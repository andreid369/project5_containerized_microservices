# Product Service on AWS (ECS Fargate + Spot, CloudFormation, CodePipeline blue/green)

A small Node.js REST API, `GET /products`, that reads products from Amazon RDS for PostgreSQL, packaged as a minimal non-root container and deployed to ECS Fargate behind an Application Load Balancer. All infrastructure is CloudFormation, built up in eight steps: the container registry, the database and cluster, the service with Auto Scaling, a dashboard, a CI/CD pipeline with CodeDeploy blue/green deployments, a Fargate + Fargate Spot capacity mix, and database credentials in a rotating Secrets Manager secret. A separate migration path shows the same service moving from the EC2 launch type to Fargate with no downtime.

![Product Service architecture on AWS: users reach an Application Load Balancer in public subnets, which forwards to ECS tasks on Fargate and Fargate Spot in private subnets; the tasks read credentials from Secrets Manager and query RDS PostgreSQL; a rotation Lambda rotates the password; CodePipeline, CodeBuild and CodeDeploy deploy every merge to main with blue/green](docs/images/architecture.png)

Security groups chain the layers: internet → ALB (80) → tasks (3000) → database (5432). Each accepts traffic only from the one in front of it.

## Project structure

```
product-service/
├── src/
│   ├── server.js         # starts the app: credentials from Secrets Manager, schema setup, :3000, graceful SIGTERM shutdown
│   ├── app.js            # Express routes: GET /products, GET /health, GET /health/live, GET /
│   ├── products.js       # SELECT from the products table
│   ├── db.js             # pg connection pool, TLS with RDS certificate verification, retry after rotation
│   ├── db-secret.js      # reads the database secret at runtime, caches it, refreshes after rotation
│   ├── migrate.js        # idempotent CREATE TABLE + seed, guarded by a PostgreSQL advisory lock
│   ├── config.js         # environment variables
│   ├── logger.js         # structured JSON logs
│   └── healthcheck.js    # container health check (no curl in the image)
├── test/                 # node:test unit tests (npm test), also run inside the Docker test stage
├── Dockerfile            # multi-stage: deps, test, runtime
├── .dockerignore
├── docker-compose.yml    # local PostgreSQL + the service
├── package.json, package-lock.json
├── cloudformation/
│   ├── product-service.yaml     # SOURCE for every template below (not deployable itself)
│   ├── steps/                   # generated: one cumulative template per step, deploy in order
│   │   ├── 02-ecr.yaml
│   │   ├── 03-ecs-task.yaml
│   │   ├── 04-ecs-service-alb-autoscaling.yaml
│   │   ├── 05-dashboard.yaml
│   │   ├── 06-cicd.yaml
│   │   ├── 07-capacity-providers.yaml
│   │   └── 08-secrets-manager.yaml
│   └── migration/               # generated: EC2 -> Fargate migration path
│       ├── 1-ec2-baseline.yaml
│       ├── 2-parallel-run.yaml
│       └── 3-remove-ec2-service.yaml
├── buildspec.yml         # CodeBuild: test, build, push, render taskdef.json and appspec.yaml
├── ecs/
│   ├── taskdef.json      # task definition template the pipeline registers
│   └── appspec.yaml      # CodeDeploy AppSpec template (blue/green target + capacity provider strategy)
├── .github/
│   ├── workflows/ci.yml  # GitHub Actions: pull request checks (tests, Docker smoke test, templates)
│   └── dependabot.yml    # weekly dependency update pull requests
├── docs/
│   ├── EC2_to_Fargate_Migration.md
│   └── images/           # architecture.png (in this README), architecture.svg, src/ to regenerate them
└── scripts/
    ├── render-cfn-steps.py   # regenerate cloudformation/steps/ and migration/ from the source
    ├── render-template.py    # fill ecs/taskdef.json and ecs/appspec.yaml from CodeBuild variables
    └── smoke-test.sh         # endpoint checks against a running service (local, CI or the AWS load balancer)
```

## Step 1: the service and the Docker image

**API**

| Method and path | Response |
|---|---|
| `GET /products` | `200`, JSON array of products (`id`, `sku`, `name`, `description`, `price`, `currency`, `stock`, `createdAt`) |
| `GET /health` | `200` when the database answers, `503` when it doesn't. Used by the ALB. |
| `GET /health/live` | `200` while the process runs. Used by the container health check, so a database outage doesn't make ECS kill every task. |
| `GET /` | Short JSON description |

On startup the service creates the `products` table if it doesn't exist and seeds five rows if it's empty. Several tasks can start at once; an advisory lock makes sure only one runs this.

**Dockerfile** (three stages)

- `deps`: `npm ci --omit=dev`, production dependencies only.
- `test`: all dependencies plus `npm test`. Built only on request (`--target test`), which the pipeline does before every build.
- `runtime`: Alpine with only the `node` binary (npm, npx, corepack and yarn are removed), application files owned by root and read-only to the unprivileged `node` user, the AWS RDS CA bundle for verified TLS, `EXPOSE 3000`, a `HEALTHCHECK`, and `node` started directly so `SIGTERM` reaches it.

Base images are pulled from `public.ecr.aws/docker/library/`, the ECR Public mirror of the Docker official images, so CodeBuild doesn't hit Docker Hub's anonymous rate limit.

**Run it locally**

```bash
npm ci && npm test                 # unit tests (Node 22+)
docker compose up --build          # PostgreSQL + the service
curl http://localhost:3000/products
```

## Before you start

You need the AWS CLI v2 with credentials that can create IAM roles, Docker, and a region (the commands use `AWS_REGION`). One stack, `product-service`, is created in step 2 and updated in each following step.

```bash
export AWS_REGION=us-east-1
export STACK=product-service
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Helper: read a stack output
out() { aws cloudformation describe-stacks --stack-name "$STACK" \
          --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
```

`aws cloudformation deploy` keeps the previous value of any parameter you don't override, so later steps only pass their new parameters.

## Step 2: ECR repository, then build and push the image

`cloudformation/steps/02-ecr.yaml` creates the `product-service` repository: immutable tags, scan on push, encryption at rest, and a lifecycle policy (expire untagged images after 7 days, keep the latest 30).

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/02-ecr.yaml

REPO_URI=$(out RepositoryUri)       # ACCOUNT.dkr.ecr.REGION.amazonaws.com/product-service
IMAGE_TAG=1.0.0

# 1. Authenticate Docker with ECR
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# 2. Build. --platform matters on Apple Silicon: the tasks here run on x86_64.
docker build --platform linux/amd64 -t product-service:$IMAGE_TAG .

# 3. Tag with the ECR repository URI
docker tag product-service:$IMAGE_TAG "$REPO_URI:$IMAGE_TAG"

# 4. Push
docker push "$REPO_URI:$IMAGE_TAG"

# Check the push and the vulnerability scan
aws ecr describe-images --repository-name product-service --image-ids imageTag=$IMAGE_TAG
aws ecr describe-image-scan-findings --repository-name product-service --image-id imageTag=$IMAGE_TAG \
  --query 'imageScanFindings.findingSeverityCounts'
```

Tags are immutable, so to push a changed image use a new tag (`1.0.1`, or the git SHA).

**Want to demo the EC2 → Fargate migration?** Stop the main track here and follow [docs/EC2_to_Fargate_Migration.md](docs/EC2_to_Fargate_Migration.md): it deploys the service on the EC2 launch type (bridge networking, Auto Scaling group capacity provider, instance role), runs a Fargate service next to it, moves traffic over with weighted listener rules (0 → 10 → 50 → 100%), removes the EC2 side, and rejoins this track at step 4.

## Step 3: ECS cluster, task definition, IAM, networking and the database

`03-ecs-task.yaml` adds:

- **Networking:** a VPC across two availability zones with public subnets (NAT gateway, later the ALB) and private subnets (tasks, database), a NAT gateway, and a free S3 gateway endpoint for ECR image layers.
- **Security groups:** app (outbound only HTTPS and PostgreSQL to the database group), database (inbound 5432 from the app group only, no outbound).
- **RDS PostgreSQL 18:** private, encrypted, `ManageMasterUserPassword: true` so RDS generates the password and keeps it in Secrets Manager. (Step 8 replaces this with a template-owned secret.)
- **ECS cluster** with Container Insights and the `FARGATE` capacity provider as the default strategy, a log group, and a Fargate **task definition** (0.25 vCPU, 512 MiB, read-only root filesystem, container health check).
- **IAM:** an execution role (pull image, write logs) and a task role whose only permission is `secretsmanager:GetSecretValue` on the database secret.

The task definition holds **no credentials**: only the secret's ARN (`DB_SECRET_ARN`). The application reads the username and password from Secrets Manager at runtime with its task role, caches them for 5 minutes, and re-reads them after an authentication failure, so a rotation never needs a restart.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/03-ecs-task.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageTag=1.0.0
# About 10-15 minutes, mostly RDS.

# Run the task once (there is no service yet)
TASK_ARN=$(aws ecs run-task --cluster "$(out ClusterName)" --launch-type FARGATE \
  --task-definition "$(out TaskDefinitionArn)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(out PrivateSubnetIds)],securityGroups=[$(out AppSecurityGroupId)],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

# Expect "database settings ... secrets-manager", "seeded products table", "schema ready" and "listening"
aws logs tail /ecs/product-service --follow

aws ecs describe-tasks --cluster product-service --tasks "$TASK_ARN" \
  --query 'tasks[0].{status:lastStatus,health:healthStatus}'
aws ecs stop-task --cluster product-service --task "$TASK_ARN"
```

The task is in a private subnet with no load balancer yet, so the logs and the health status are the check at this step.

## Step 4: ECS service, Application Load Balancer and Auto Scaling

`04-ecs-service-alb-autoscaling.yaml` adds:

- **ALB** in the public subnets, HTTP listener on 80, invalid headers dropped, and the "blue" target group (IP targets on 3000, health check `/health`, 30 s deregistration delay).
- **ECS service** `product-service`: 2 tasks in the private subnets (one per zone), no public IPs, registered with the target group. It runs on the cluster's default capacity provider strategy (no launch type set), and its deployment controller is `CODE_DEPLOY`, ready for step 6.
- **Auto Scaling:** 2 to 4 tasks, target tracking on average CPU (60%) and memory (75%), quick scale-out (60 s), slow scale-in (300 s).

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/04-ecs-service-alb-autoscaling.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides AlbIngressCidr=0.0.0.0/0   # or your IP/32 to keep it private

curl "$(out ProductsUrl)"
curl "http://$(out LoadBalancerDnsName)/health"
aws application-autoscaling describe-scalable-targets --service-namespace ecs
```

Optional load test to see scaling (with [hey](https://github.com/rakyll/hey)): `hey -z 5m -c 50 "$(out ProductsUrl)"`.

## Step 5: CloudWatch dashboard

`05-dashboard.yaml` adds the `product-service` dashboard:

| Widget | Metrics |
|---|---|
| Cluster reservation | `AWS/ECS` `CPUReservation`, `MemoryReservation` |
| Tasks | `ECS/ContainerInsights` `DesiredTaskCount`, `RunningTaskCount`, `PendingTaskCount` |
| CPU reserved vs used | Container Insights `CpuReserved`, `CpuUtilized` |
| Memory reserved vs used | Container Insights `MemoryReserved`, `MemoryUtilized` |
| Service utilization | `AWS/ECS` `CPUUtilization`, `MemoryUtilization` (what Auto Scaling tracks) |
| Load balancer | requests, target and ALB 5XX, p95 response time |

**Important:** AWS publishes `CPUReservation` and `MemoryReservation` only for clusters with EC2 capacity, not for Fargate, so on this cluster that widget stays empty (it does show data during the EC2 migration path). It is included because it was requested; the Container Insights `CpuReserved` / `MemoryReserved` widgets are the Fargate equivalent.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/05-dashboard.yaml \
  --capabilities CAPABILITY_IAM
echo "$(out DashboardUrl)"
```

## Step 6: CI/CD with CodePipeline, CodeBuild and CodeDeploy blue/green

`06-cicd.yaml` adds:

- **Blue/green on the ALB:** a "green" target group, a test listener on 8080 (reachable from `TestTrafficCidr`, by default only inside the VPC), and a CloudWatch alarm on target 5XX errors.
- **Source:** a CodeConnections connection to GitHub and an encrypted, TLS-only, versioned S3 artifact bucket.
- **CodeBuild** (`buildspec.yml`): runs the tests in the Docker `test` stage, builds the image, tags it with the first 12 characters of the commit SHA, pushes it to ECR (skipping the push if that tag already exists, since tags are immutable), and produces `imageDetail.json`, `taskdef.json` and `appspec.yaml`.
- **CodeDeploy:** an ECS application and deployment group, `BLUE_GREEN` with traffic control. Green gets traffic once healthy, blue stays up 5 minutes for an instant rollback, and the deployment rolls back automatically on failure or when the 5XX alarm fires.
- **CodePipeline (V2):** Source (GitHub) → Build (CodeBuild) → Deploy (`CodeDeployToECS`).
- **IAM roles** for CodeBuild (ECR push to this repository only, logs, artifacts), CodePipeline (start this build, deploy with this application, register task definitions, pass only the two task roles to ECS) and CodeDeploy (`AWSCodeDeployRoleForECS`).

**How each deployment is assembled.** `ecs/taskdef.json` and `ecs/appspec.yaml` are templates. CodeBuild fills their `${...}` placeholders from environment variables that CloudFormation set on the build project: role ARNs, the database endpoint, the secret's ARN, and the capacity provider strategy (`scripts/render-template.py`, which fails on any missing value or invalid JSON). CodePipeline then replaces `<IMAGE1_NAME>` with the new image URI from `imageDetail.json`, registers the task definition as a new revision of the `product-service` family, and puts its ARN into the AppSpec in place of `<TASK_DEFINITION>`. So stack settings (like the capacity strategy in step 7, or the secret in step 8) reach the service on the next pipeline run.

```bash
# 1. Put this project in a GitHub repository
git init && git add . && git commit -m "Product Service"
git remote add origin git@github.com:YOUR_USER/product-service.git
git push -u origin main

# 2. Deploy step 6
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/06-cicd.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubRepository=YOUR_USER/product-service GitHubBranch=main
```

3. **Authorize the GitHub connection once.** It is created in `PENDING` state. In the console: Developer Tools → Settings → Connections → `product-service-github` → Update pending connection, and install or choose the AWS Connector for GitHub app. The pipeline's first automatic run fails at Source until this is done; that's expected.

```bash
# 4. Run the pipeline (or just push a commit)
aws codepipeline start-pipeline-execution --name product-service

# Watch it
aws codepipeline get-pipeline-state --name product-service \
  --query 'stageStates[].{stage:stageName,status:latestExecution.status}' --output table
aws deploy list-deployments --application-name product-service \
  --deployment-group-name product-service-dg --query 'deployments[0]' --output text \
  | xargs -I{} aws deploy get-deployment --deployment-id {} \
      --query 'deploymentInfo.{status:status,created:createTime}'

# The new version answers on the test listener during the deployment
# (set TestTrafficCidr=YOUR_IP/32 to reach it from your machine)
curl "$(out TestListenerUrl)"
curl "$(out ProductsUrl)"
```

**Try a rollback:** in `src/products.js`, change `FROM products` to `FROM productz`. The unit tests don't cover the SQL and `/health` still passes, so the change deploys and traffic switches. Push, keep requesting `/products`, and watch the 5XX alarm stop the deployment and CodeDeploy shift traffic back to blue. Then `git revert HEAD && git push`.

## CI on GitHub: pull request checks

`.github/workflows/ci.yml` checks every pull request and every push to `main`. It needs no AWS credentials and deploys nothing; CodePipeline stays the only path to AWS. The two meet at `main`: CI decides what may be merged, and CodePipeline deploys what is merged.

| Check (job name) | What it runs | What it catches |
|---|---|---|
| Unit tests | `npm ci`, `npm test`, `npm audit --omit=dev --audit-level=high` | Broken code, vulnerable production dependencies |
| Docker build and smoke test | The Dockerfile's `test` stage, the runtime image (amd64), non-root and no-npm checks, then the image started read-only against a PostgreSQL service container: `scripts/smoke-test.sh`, a restart (no second seed), and a SIGTERM shutdown (exit 0 in under 10 s) | A Dockerfile that doesn't build or doesn't run, missing files, permission problems, a broken health check or shutdown |
| CloudFormation and pipeline files | The generated templates match their source, `cfn-lint`, `taskdef.json` and `appspec.yaml` rendered as CodeBuild does, and no credential variables in the task definition | Templates edited without regenerating, template errors, a buildspec change that would fail in CodeBuild |

`.github/dependabot.yml` opens weekly pull requests for npm packages, GitHub Actions and the base image. Each one runs through CI, and merging it deploys it.

**Make the checks a gate.** Without branch protection CI only reports results, and a direct push to `main` still deploys. On GitHub, go to Settings → Rules → Rulesets → New branch ruleset, target the default branch, and enable:

- **Require a pull request before merging** (0 approvals is fine when you work alone)
- **Require status checks to pass**, adding the three job names above (they appear after the workflow has run once)
- **Block force pushes**

From then on the flow is: branch, then pull request, then CI, then merge, then CodePipeline, then a blue/green deployment.

```bash
git switch -c change-something
# edit, commit
git push -u origin change-something
gh pr create --fill          # CI runs; merge when green
gh pr merge --squash --delete-branch
```

`scripts/smoke-test.sh` also works against AWS: `scripts/smoke-test.sh "http://$(out LoadBalancerDnsName)"`.

## Step 7: Fargate and Fargate Spot capacity providers

`07-capacity-providers.yaml` associates both `FARGATE` and `FARGATE_SPOT` with the cluster and sets this strategy, as the cluster default and for every CodeDeploy deployment:

| Provider | Base | Weight | Meaning |
|---|---|---|---|
| `FARGATE` | 1 (`FargateBaseTasks`) | 1 (`FargateWeight`) | The first task always runs on regular Fargate. Spot can never take it away, so the service always has at least one task. |
| `FARGATE_SPOT` | 0 | 3 (`FargateSpotWeight`) | Tasks above the base are split 1:3, so most added capacity is Spot. |

With the defaults the service's 2 tasks run as 1 Fargate + 1 Fargate Spot, and a scale-out to 4 adds mostly Spot tasks. Fargate Spot costs up to about 70% less than regular Fargate, so the steady state costs about a third less for compute.

**How availability is kept:**

- The base task is on-demand and can't be interrupted.
- Tasks run in two availability zones, and ECS replaces an interrupted Spot task automatically.
- An interruption comes with a 2-minute warning as `SIGTERM`. The app stops accepting connections, finishes in-flight requests and closes its database pool (`server.js`), and the ALB drains the target (30 s deregistration delay), so in-flight requests complete.
- Fargate Spot doesn't fall back to regular Fargate when there's no Spot capacity: a Spot task can wait for capacity. That's why the base exists. For a stricter floor, set `FargateBaseTasks` equal to `MinTasks` (2): the whole minimum stays on-demand and only scale-out uses Spot.

**Why the strategy also travels in the AppSpec.** A blue/green (CodeDeploy) service takes its capacity settings from each deployment; ECS doesn't accept those changes through CloudFormation for this service. So the strategy is defined once in the stack, written to the cluster default, and passed to CodeBuild as `CAPACITY_PROVIDER_STRATEGY_JSON`, which renders it into `appspec.yaml`. The next deployment moves the tasks.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/07-capacity-providers.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides FargateBaseTasks=1 FargateWeight=1 FargateSpotWeight=3

# Apply it to the running service with a blue/green deployment
aws codepipeline start-pipeline-execution --name product-service

# After the deployment: which provider each task runs on
aws ecs list-tasks --cluster product-service --service-name product-service --query 'taskArns' --output text \
  | xargs aws ecs describe-tasks --cluster product-service \
      --query 'tasks[].{task:taskArn,provider:capacityProviderName,zone:availabilityZone}' --output table --tasks
```

## Step 8: database credentials in a Secrets Manager secret

`08-secrets-manager.yaml` replaces the RDS-managed password with a secret the template owns:

- **`AWS::SecretsManager::Secret` `product-service/database`.** CloudFormation generates a 32-character password inside Secrets Manager (`GenerateSecretString`), alongside the username and database name. The password is never in the template, a parameter, an output, or the task definition.
- **The database uses it** through a dynamic reference (`{{resolve:secretsmanager:...}}`) that CloudFormation resolves at deploy time.
- **`SecretTargetAttachment`** adds the database endpoint (host, port, engine) to the secret, so the secret alone is enough to connect.
- **Rotation every 30 days** (`SecretRotationDays`) by the AWS-provided single-user PostgreSQL rotation Lambda, which runs in the private subnets with its own security group (the database admits it on 5432).
- **Least privilege:** the task role can read only this secret. The execution role has no access to it at all, because ECS doesn't inject it; the application fetches it.

**How the task retrieves it at runtime.** The task definition contains only `DB_SECRET_ARN`, which is not sensitive. At startup the application calls `GetSecretValue` with the task role and takes the username, password, host, port and database name from the secret. It reads the password again for new connections after the 5-minute cache expires, and immediately after an authentication failure, so rotation needs no restart. ECS's own `secrets` field isn't used, on purpose: it would place the password in the container's environment variables at start, where it would go stale after the first rotation.

```bash
aws cloudformation deploy --stack-name "$STACK" \
  --template-file cloudformation/steps/08-secrets-manager.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides SecretRotationDays=30

# Deploy task definitions that point at the new secret
aws codepipeline start-pipeline-execution --name product-service

# Check: the secret's keys (not values), rotation, and that the task definition has no credentials
aws secretsmanager describe-secret --secret-id product-service/database \
  --query '{rotation:RotationEnabled,days:RotationRules.AutomaticallyAfterDays,next:NextRotationDate}'
aws secretsmanager get-secret-value --secret-id product-service/database \
  --query SecretString --output text | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)))'
aws ecs describe-task-definition --task-definition product-service \
  --query 'taskDefinition.containerDefinitions[0].environment[].name'

# Optional: rotate now and watch the service keep working
aws secretsmanager rotate-secret --secret-id product-service/database
curl "$(out ProductsUrl)"
```

`CAPABILITY_AUTO_EXPAND` is needed because the hosted rotation Lambda comes from the `AWS::SecretsManager-2020-07-23` transform.

**Going from step 7 to step 8 causes a short outage.** When the stack update switches the database to the new password, RDS deletes its managed secret, so the running tasks can't open new database connections until the pipeline deploys task definitions that point at the new secret. Start the pipeline right after the stack update (as above) and expect errors for those few minutes. To avoid the gap entirely, deploy `08-secrets-manager.yaml` directly after step 2 on a fresh stack: it contains every earlier step.

## Design decisions and known limitations

- **The service uses the `CODE_DEPLOY` deployment controller from step 4, names its task definition by family, and sets neither a launch type nor its own capacity strategy.** The controller is chosen when the service is created, and ECS rejects most later changes to a blue/green service through UpdateService, including a new task definition. So the task definition, network configuration and capacity strategy all arrive through CodeDeploy deployments, and the CloudFormation `Service` resource is identical in every template from step 4 on. A new task definition revision registered by CloudFormation (step 8, or a changed `ImageTag`) is harmless but doesn't reach the running tasks; the pipeline's revision does. Keep `ecs/taskdef.json` in sync with the template's `TaskDefinition`.
- **CodeDeploy changes the listener, CloudFormation doesn't know.** After a deployment, production may be on the green target group while the template still says blue. A stack update that modifies `HttpListener` would point traffic back at blue. Leave the listeners alone in stack updates once deployments run, or check which target group is live first.
- **Auto Scaling uses CPU and memory, not ALB requests per target.** That metric is tied to one target group, and blue/green swaps target groups on every deployment.
- **Fargate and the reservation metrics:** see step 5.
- **ECS also has built-in blue/green deployments now** (no CodeDeploy needed). This project uses CodeDeploy because that was the requirement; the built-in option is worth knowing for an interview.

Open gaps, in order of importance:

| Gap | Fix |
|---|---|
| HTTP only, no authentication, no WAF | ACM certificate and a 443 listener (needs a domain), Cognito/JWT or API Gateway in front, AWS WAF with a rate rule |
| The app connects as the database master user | A `product_reader` role with `SELECT` only, in its own secret, rotated with the multi-user rotation Lambda |
| One NAT gateway, single-AZ database | One NAT per zone, `MultiAZ: true`, `DeletionProtection: true` |
| Secret encrypted with the AWS-managed key | A customer-managed KMS key on the secret, with key policy access for the task role only |
| Base images pinned by tag, not digest | Pin `NODE_IMAGE` to `node:24-alpine@sha256:...` and update it deliberately |
| No pre-traffic automated tests | An `AfterAllowTestTraffic` Lambda hook in `ecs/appspec.yaml` that calls the test listener |
| Tasks reach AWS APIs through the NAT | Interface VPC endpoints for ECR, Secrets Manager and CloudWatch Logs, then drop the 443-to-anywhere rule |

## Cost (us-east-1, approximate)

| Resource | Per hour |
|---|---|
| NAT gateway | $0.045 + $0.045/GB |
| ALB | about $0.023 + LCUs |
| Fargate, 2 tasks × (0.25 vCPU, 0.5 GB): 1 on-demand + 1 Spot from step 7 | about $0.017 (about $0.025 with both on-demand) |
| RDS db.t4g.micro + 20 GB gp3 | about $0.018 |
| Public IPv4 (NAT + 2 ALB) | $0.015 |
| **Total** | **about $0.12/hour, roughly $3/day** |

Plus small monthly items: Secrets Manager ($0.40 per secret), Container Insights metrics, CodeBuild minutes, CodePipeline V2 action minutes, and rotation Lambda runs. During the EC2 migration path, add the two container instances (2 × t3.small, about $0.04/hour). At this size the NAT gateway and ALB dominate; Spot matters more as the task count grows. Set an AWS Budgets alert, and tear the stack down when you're done.

## Tear down

```bash
# After step 6: empty the versioned artifact bucket, or the stack delete fails on it
BUCKET=$(out ArtifactBucketName)
aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions --bucket "$BUCKET" \
  --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)"

aws cloudformation delete-stack --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --stack-name "$STACK"

# Retained on purpose, delete when you no longer need them:
aws ecr delete-repository --repository-name product-service --force
aws rds describe-db-snapshots --snapshot-type manual \
  --query 'DBSnapshots[].DBSnapshotIdentifier'     # final snapshot of the database
```

If re-creating the stack later fails because the secret name `product-service/database` is still scheduled for deletion, remove it for good first: `aws secretsmanager delete-secret --secret-id product-service/database --force-delete-without-recovery`.

## Changing the templates

`cloudformation/product-service.yaml` is the single source. Blocks between `#@in TOKENS` and `#@end` belong to particular targets: `3+` (step 3 and later), `3-7` (steps 3 to 7), `6` (step 6 only), `ec2` (migration baseline) and `migrate` (parallel run). Because it holds alternative versions of some resources side by side, the source itself isn't deployable. Edit it, then regenerate and lint:

```bash
python3 scripts/render-cfn-steps.py
pip install cfn-lint && cfn-lint cloudformation/steps/*.yaml cloudformation/migration/*.yaml
```

## License

[MIT](LICENSE): you may use, copy and modify this project, including commercially, as long as the copyright notice stays with it.

The architecture diagram (`docs/images/architecture.png` and `.svg`) contains [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/), which belong to Amazon Web Services and are used under AWS's terms for architecture diagrams. They are not covered by the MIT license.
