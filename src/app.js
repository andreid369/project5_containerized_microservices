'use strict';

const express = require('express');
const { randomUUID } = require('node:crypto');

// The app takes its dependencies as arguments so tests can run it without a
// database.
function createApp({ productRepository, healthCheck, logger }) {
  const app = express();
  app.disable('x-powered-by');

  // Request ID: reuse the ALB trace ID when present, so an application log line
  // can be matched with the ALB access log for the same request.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    req.id = req.get('x-amzn-trace-id') || req.get('x-request-id') || randomUUID();
    res.set('x-request-id', req.id);
    res.on('finish', () => {
      if (req.path === '/health/live') return; // keep container health checks out of the logs
      logger.info('request', {
        request_id: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    next();
  });

  app.get('/', (req, res) => {
    res.json({ service: 'product-service', endpoints: ['GET /products', 'GET /health'] });
  });

  app.get('/products', async (req, res, next) => {
    try {
      res.json(await productRepository.list());
    } catch (err) {
      next(err);
    }
  });

  // Readiness: used by the ALB target group. Checks the database too.
  app.get('/health', async (req, res) => {
    try {
      await healthCheck();
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      logger.warn('health check failed', { request_id: req.id, err });
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  // Liveness: used by the container health check. Deliberately does not touch
  // the database, so a database outage doesn't make ECS kill every task.
  app.get('/health/live', (req, res) => res.json({ status: 'ok' }));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Generic error response: details go to the log, never to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('unhandled error', { request_id: req.id, err });
    res.status(500).json({ error: 'Internal server error', request_id: req.id });
  });

  return app;
}

module.exports = { createApp };
