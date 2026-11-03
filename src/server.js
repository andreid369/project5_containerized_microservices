'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createDb } = require('./db');
const { createSecretProvider, applySecretToDbConfig } = require('./db-secret');
const { createProductRepository } = require('./products');
const { migrate } = require('./migrate');
const { createApp } = require('./app');

const config = loadConfig();
const logger = createLogger(config.logLevel);

async function migrateWithRetry(db, attempts = 5) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await migrate(db.pool, logger);
      return;
    } catch (err) {
      logger.warn('schema setup failed', { attempt: i, err });
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function main() {
  // With DB_SECRET_ARN set (on AWS), the username, and the endpoint when the
  // secret has one, come from Secrets Manager. The password is read per new
  // connection by the pool (db.js), so a rotation is picked up without a restart.
  const secrets = config.db.secretArn
    ? createSecretProvider({ secretArn: config.db.secretArn, region: config.awsRegion })
    : null;
  const dbConfig = secrets
    ? applySecretToDbConfig(config.db, await secrets.getCredentials())
    : config.db;
  logger.info('database settings', {
    host: dbConfig.host,
    database: dbConfig.database,
    credentials: secrets ? 'secrets-manager' : 'environment',
  });

  const db = createDb({ ...config, db: dbConfig }, logger, { secretProvider: secrets });
  if (config.runMigrations) await migrateWithRetry(db);

  const app = createApp({
    productRepository: createProductRepository(db),
    healthCheck: () => db.ping(),
    logger,
  });

  const server = app.listen(config.port, () => logger.info('listening', { port: config.port }));

  // The ALB keeps idle connections open for 60 s. Node's default keep-alive is
  // 5 s, so Node could close a connection the ALB is about to reuse, which shows
  // up as a sporadic 502. Keep Node's timeout longer than the ALB's.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // ECS sends SIGTERM on scale-in and deployments: stop accepting connections,
  // let in-flight requests finish, close the pool, then exit.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    server.close(async () => {
      await db.close().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25_000).unref(); // under ECS stopTimeout (30 s)
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('startup failed', { err });
  process.exit(1);
});
