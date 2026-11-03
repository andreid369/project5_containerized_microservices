'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecretProvider, applySecretToDbConfig, parseSecret } = require('../src/db-secret');
const { createDb } = require('../src/db');
const { loadConfig } = require('../src/config');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeSecretsClient(values) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async send() {
      const v = values[Math.min(calls, values.length - 1)];
      calls += 1;
      return { SecretString: JSON.stringify(v) };
    },
  };
}

test('secret provider caches the secret and refreshes it after invalidate()', async () => {
  const client = fakeSecretsClient([
    { username: 'admin', password: 'old' },
    { username: 'admin', password: 'new' },
  ]);
  const sp = createSecretProvider({ secretArn: 'arn:test', client });
  assert.equal((await sp.getCredentials()).password, 'old');
  assert.equal((await sp.getCredentials()).password, 'old');
  assert.equal(client.calls, 1);
  sp.invalidate();
  assert.equal((await sp.getCredentials()).password, 'new');
  assert.equal(client.calls, 2);
});

test('secret provider collapses concurrent fetches into one call', async () => {
  const client = fakeSecretsClient([{ username: 'admin', password: 'p' }]);
  const sp = createSecretProvider({ secretArn: 'arn:test', client });
  await Promise.all([sp.getCredentials(), sp.getCredentials(), sp.getCredentials()]);
  assert.equal(client.calls, 1);
});

test('secret provider refreshes after the cache TTL', async () => {
  let t = 0;
  const client = fakeSecretsClient([{ username: 'a', password: '1' }, { username: 'a', password: '2' }]);
  const sp = createSecretProvider({ secretArn: 'arn:test', client, now: () => t });
  await sp.getCredentials();
  t = 6 * 60 * 1000;
  assert.equal((await sp.getCredentials()).password, '2');
});

test('db.query retries once with fresh credentials after an auth failure (rotation)', async () => {
  let attempts = 0;
  class FakePool {
    constructor(opts) { this.opts = opts; }
    on() {}
    async query() {
      attempts += 1;
      const pw = await this.opts.password();
      if (pw === 'old') {
        const e = new Error('password authentication failed');
        e.code = '28P01';
        throw e;
      }
      return { rows: [{ ok: 1 }] };
    }
  }
  const client = fakeSecretsClient([{ username: 'a', password: 'old' }, { username: 'a', password: 'new' }]);
  const secretProvider = createSecretProvider({ secretArn: 'arn:test', client });
  const config = loadConfig({ DB_SECRET_ARN: 'arn:test' });
  const db = createDb(config, silent, { secretProvider, PoolImpl: FakePool });
  const res = await db.query('SELECT 1');
  assert.deepEqual(res.rows, [{ ok: 1 }]);
  assert.equal(attempts, 2);
});

test('a template-owned secret (step 8) supplies the endpoint as well as the credentials', () => {
  const secret = parseSecret(JSON.stringify({
    username: 'productadmin', password: 'p', host: 'db.internal', port: 5432, dbname: 'products', engine: 'postgres',
  }));
  const merged = applySecretToDbConfig(loadConfig({ DB_HOST: 'ignored', DB_USER: 'ignored' }).db, secret);
  assert.equal(merged.host, 'db.internal');
  assert.equal(merged.user, 'productadmin');
  assert.equal(merged.port, 5432);
  assert.equal(merged.database, 'products');
});

test('an RDS-managed secret (username and password only) keeps the endpoint from the environment', () => {
  const secret = parseSecret(JSON.stringify({ username: 'productadmin', password: 'p' }));
  const merged = applySecretToDbConfig(loadConfig({ DB_HOST: 'rds.example', DB_PORT: '5433' }).db, secret);
  assert.equal(merged.host, 'rds.example');
  assert.equal(merged.port, 5433);
  assert.equal(merged.user, 'productadmin');
});

test('a secret without a password is rejected', () => {
  assert.throws(() => parseSecret('{"username": "x"}'), /no password/);
});

test('config defaults: port 3000, SSL off locally, migrations on', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.db.ssl, false);
  assert.equal(c.runMigrations, true);
  assert.equal(loadConfig({ DB_SSL: 'true' }).db.ssl, true);
});
