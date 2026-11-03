'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function withServer(deps, fn) {
  const app = createApp({ logger: silent, healthCheck: async () => {}, ...deps });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const sample = [{ id: 1, sku: 'KB-001', name: 'Keyboard', price: 89.99, currency: 'USD', stock: 1 }];

test('GET /products returns the product list as JSON', async () => {
  await withServer({ productRepository: { list: async () => sample } }, async (base) => {
    const res = await fetch(`${base}/products`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), sample);
  });
});

test('GET /products hides database errors from the client', async () => {
  const repo = { list: async () => { throw new Error('password authentication failed for user x'); } };
  await withServer({ productRepository: repo }, async (base) => {
    const res = await fetch(`${base}/products`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Internal server error');
    assert.ok(!JSON.stringify(body).includes('password'));
  });
});

test('GET /health is 200 when the database is up and 503 when it is down', async () => {
  await withServer({ productRepository: { list: async () => [] } }, async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await withServer({ productRepository: { list: async () => [] }, healthCheck: down }, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).database, 'down');
  });
});

test('GET /health/live does not depend on the database', async () => {
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await withServer({ productRepository: { list: async () => [] }, healthCheck: down }, async (base) => {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
  });
});

test('unknown routes return a JSON 404, and the request ID is echoed', async () => {
  await withServer({ productRepository: { list: async () => [] } }, async (base) => {
    const res = await fetch(`${base}/nope`, { headers: { 'x-amzn-trace-id': 'Root=1-abc' } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-request-id'), 'Root=1-abc');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});
