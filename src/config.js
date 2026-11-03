'use strict';

// All configuration comes from environment variables, so the same image runs
// locally (docker compose) and on ECS (task definition environment).

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || 'info',
    runMigrations: bool(env.RUN_MIGRATIONS, true),
    db: {
      host: env.DB_HOST || 'localhost',
      port: int(env.DB_PORT, 5432),
      database: env.DB_NAME || 'products',
      user: env.DB_USER || 'postgres',
      // Local development only. On AWS the password comes from Secrets Manager.
      password: env.DB_PASSWORD,
      // ARN of the RDS-managed secret. When set, the password is read from
      // Secrets Manager at runtime and refreshed after a rotation.
      secretArn: env.DB_SECRET_ARN,
      ssl: bool(env.DB_SSL, false),
      sslCaPath: env.DB_SSL_CA_PATH || '/app/certs/rds-global-bundle.pem',
      poolMax: int(env.DB_POOL_MAX, 10),
    },
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION,
  };
}

module.exports = { loadConfig };
