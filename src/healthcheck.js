'use strict';

// Container health check (Docker HEALTHCHECK and the ECS task definition).
// The runtime image has no curl or wget, so this uses Node itself.

const http = require('node:http');

const port = process.env.PORT || 3000;
const req = http.get({ host: '127.0.0.1', port, path: '/health/live', timeout: 2000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
