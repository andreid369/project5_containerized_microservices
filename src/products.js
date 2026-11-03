'use strict';

// Data access for products. The query is a fixed statement with no user input.

function createProductRepository(db) {
  return {
    async list() {
      const { rows } = await db.query(
        `SELECT id, sku, name, description, price, currency, stock, created_at
           FROM products
          ORDER BY id
          LIMIT 100`,
      );
      return rows.map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        description: r.description,
        price: Number(r.price), // NUMERIC comes back from pg as a string
        currency: r.currency,
        stock: r.stock,
        createdAt: r.created_at,
      }));
    },
  };
}

module.exports = { createProductRepository };
