'use strict';

// Reads the database credentials from Secrets Manager at runtime.
//
// Two secret shapes are supported, both JSON:
//   RDS-managed secret (steps 3-7):  {"username", "password"}
//   template-owned secret (step 8):  {"username", "password", "host", "port", "dbname", "engine", ...}
//
// Why at runtime and not through the task definition: the password is rotated
// automatically. A value injected when the container starts would go stale
// after a rotation, and every new connection would fail until the tasks were
// replaced. Reading it here, caching it briefly and re-reading it after an
// authentication failure keeps the service working across rotations with no
// restart. It also keeps the password out of the container's environment
// variables, where anything that can read /proc or the ECS metadata could see it.

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const CACHE_TTL_MS = 5 * 60 * 1000;

function parseSecret(secretString) {
  const s = JSON.parse(secretString);
  if (!s.password) throw new Error('Database secret has no password field');
  return {
    username: s.username,
    password: s.password,
    host: s.host,
    port: s.port !== undefined ? Number(s.port) : undefined,
    dbname: s.dbname,
  };
}

function createSecretProvider({ secretArn, region, client, now = Date.now }) {
  const sm = client || new SecretsManagerClient(region ? { region } : {});
  let cached = null;
  let fetchedAt = 0;
  let inFlight = null;

  async function fetchSecret() {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    cached = parseSecret(res.SecretString);
    fetchedAt = now();
    return cached;
  }

  return {
    async getCredentials() {
      if (cached && now() - fetchedAt < CACHE_TTL_MS) return cached;
      // Collapse concurrent refreshes into one API call.
      inFlight = inFlight || fetchSecret().finally(() => { inFlight = null; });
      return inFlight;
    },
    invalidate() {
      cached = null;
      fetchedAt = 0;
    },
  };
}

// Connection settings from the secret take precedence over the environment,
// so a secret that carries the endpoint (step 8) is all a task needs.
function applySecretToDbConfig(dbConfig, secret) {
  return {
    ...dbConfig,
    user: secret.username || dbConfig.user,
    host: secret.host || dbConfig.host,
    port: secret.port || dbConfig.port,
    database: secret.dbname || dbConfig.database,
  };
}

module.exports = { createSecretProvider, applySecretToDbConfig, parseSecret };
