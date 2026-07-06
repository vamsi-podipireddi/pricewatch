-- PriceWatch D1 schema. Apply with:
--   npx wrangler d1 execute pricewatch --remote --file=schema.sql
--   npx wrangler d1 execute pricewatch --local  --file=schema.sql   (for `wrangler dev`)

CREATE TABLE IF NOT EXISTS products (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,   -- normalized (tracking params stripped, Amazon collapsed to /dp/ASIN)
  domain        TEXT NOT NULL,
  title         TEXT,
  image         TEXT,
  currency      TEXT NOT NULL DEFAULT 'INR',
  current_price REAL,
  target_price  REAL,
  created_at    TEXT NOT NULL,          -- ISO 8601
  last_checked  TEXT,
  last_status   TEXT,                   -- ok | blocked | error
  last_error    TEXT,
  archived      INTEGER NOT NULL DEFAULT 0
);

-- Step-function history: a row is written when the price changes, plus a daily
-- heartbeat row (>20h since last) so charts show continuity, not gaps.
CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  price      REAL NOT NULL,
  at         TEXT NOT NULL,             -- ISO 8601
  source     TEXT NOT NULL DEFAULT 'cron'  -- cron | manual | extension
);

CREATE INDEX IF NOT EXISTS idx_history_product_at ON price_history (product_id, at);
