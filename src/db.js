'use strict';

const fs = require('node:fs');
const { Pool } = require('pg');
const { createSecretProvider } = require('./db-secret');

const AUTH_FAILED = '28P01'; // PostgreSQL: invalid_password

function sslOptions(dbConfig) {
  if (!dbConfig.ssl) return false;
  // Verify the RDS server certificate against the AWS RDS CA bundle that the
  // Dockerfile downloads into the image.
  return { ca: fs.readFileSync(dbConfig.sslCaPath, 'utf8'), rejectUnauthorized: true };
}

function createDb(config, logger, { secretProvider, PoolImpl = Pool } = {}) {
  const dbConfig = config.db;
  const secrets = secretProvider
    || (dbConfig.secretArn
      ? createSecretProvider({ secretArn: dbConfig.secretArn, region: config.awsRegion })
      : null);

  const pool = new PoolImpl({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    // pg calls this for every new connection, so a rotated password is picked up
    // as soon as the cache is refreshed.
    password: secrets ? async () => (await secrets.getCredentials()).password : dbConfig.password,
    ssl: sslOptions(dbConfig),
    max: dbConfig.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => logger.error('idle database client error', { err }));

  async function query(text, params) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (err.code === AUTH_FAILED && secrets) {
        // The password was probably rotated: drop the cached one and retry once.
        logger.warn('database authentication failed, refreshing credentials');
        secrets.invalidate();
        return pool.query(text, params);
      }
      throw err;
    }
  }

  return {
    query,
    pool,
    async ping() {
      await query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createDb };
