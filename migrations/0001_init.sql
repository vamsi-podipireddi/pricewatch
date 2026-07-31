-- Migration number: 0001    v1 baseline schema.
-- Fresh databases: `wrangler d1 migrations apply pricewatch` runs 0001..000N in
-- order. Databases created before the migrations pipeline existed already have
-- these tables — mark this file applied via scripts/bootstrap-d1-migrations-*.sql
-- instead of running it.

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  domain        TEXT NOT NULL,
  title         TEXT,
  image         TEXT,
  currency      TEXT NOT NULL DEFAULT 'INR',
  current_price REAL,
  target_price  REAL,
  created_at    TEXT NOT NULL,
  last_checked  TEXT,
  last_status   TEXT,
  last_error    TEXT,
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  price      REAL NOT NULL,
  at         TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_history_product_at ON price_history (product_id, at);
