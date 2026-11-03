'use strict';

// Idempotent schema setup, run once at startup. Several tasks can start at the
// same time, so a PostgreSQL advisory lock makes sure only one of them runs the
// DDL and the seed while the others wait.

const LOCK_ID = 727274; // arbitrary, unique to this service

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  sku         VARCHAR(32)    NOT NULL UNIQUE,
  name        VARCHAR(200)   NOT NULL,
  description TEXT,
  price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  currency    CHAR(3)        NOT NULL DEFAULT 'USD',
  stock       INTEGER        NOT NULL DEFAULT 0 CHECK (stock >= 0),
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);
`;

const SEED = `
INSERT INTO products (sku, name, description, price, currency, stock) VALUES
  ('KB-001', 'Mechanical Keyboard', 'Tenkeyless, hot-swappable switches', 89.99, 'USD', 42),
  ('MS-002', 'Wireless Mouse', 'Ergonomic, 4000 DPI', 39.50, 'USD', 120),
  ('MN-003', '27" Monitor', '1440p IPS, 144 Hz', 279.00, 'USD', 15),
  ('HS-004', 'USB-C Headset', 'Noise-cancelling microphone', 59.90, 'USD', 64),
  ('DK-005', 'Laptop Dock', 'USB-C, dual display, 100 W PD', 149.00, 'USD', 23)
ON CONFLICT (sku) DO NOTHING;
`;

async function migrate(pool, logger) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(SCHEMA);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM products');
    if (rows[0].n === 0) {
      await client.query(SEED);
      logger.info('seeded products table');
    }
    logger.info('schema ready');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate, SCHEMA, SEED };
