# Multi-stage build for the Product Service.
#
#   deps     installs production dependencies only (npm ci --omit=dev)
#   test     installs everything and runs the test suite (built only on request:
#            docker build --target test .)
#   runtime  the final image: Alpine + node, no npm/yarn, non-root, read-only app files
#
# Base images come from the ECR Public mirror of the Docker official images, so
# CodeBuild doesn't hit Docker Hub's anonymous pull rate limit.
# For fully reproducible builds, pin NODE_IMAGE by digest (node:24-alpine@sha256:...).

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY test ./test
RUN npm test

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_SSL_CA_PATH=/app/certs/rds-global-bundle.pem

# The application needs only the node binary at runtime. Removing npm, npx,
# corepack and yarn removes most of the image's CVE surface (their bundled
# dependencies), and apk upgrade picks up Alpine security fixes.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && apk upgrade --no-cache

WORKDIR /app

# AWS RDS certificate bundle, used to verify the database's TLS certificate.
# Files ADDed from a URL are created root-only (0600), and some Docker versions
# ignore ADD --chmod for URLs, so the permissions are set explicitly here.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 755 /app/certs && chmod 444 /app/certs/rds-global-bundle.pem

# Application files are owned by root and only readable by the node user, so a
# compromised process can't modify its own code.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node

# Fail the build, not the deployment, if the app user can't read its CA bundle
# or the bundle isn't a usable certificate.
RUN node -e "const fs=require('fs'),{X509Certificate}=require('crypto'); \
  new X509Certificate(fs.readFileSync(process.env.DB_SSL_CA_PATH)); console.log('CA bundle readable by', require('os').userInfo().username)"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

# Run node directly (not through npm or a shell) so it is PID 1's child-less
# process that receives SIGTERM from ECS and shuts down gracefully.
CMD ["node", "src/server.js"]
