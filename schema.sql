-- PriceWatch D1 schema (v2). Fresh installs apply this file:
--   npx wrangler d1 execute pricewatch --remote --file=schema.sql
--   npx wrangler d1 execute pricewatch --local  --file=schema.sql   (for `wrangler dev`)
-- Existing v1 databases: apply migrations/0002_v2.sql instead (keeps your data).

CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL UNIQUE,   -- normalized (tracking params stripped, Amazon collapsed to /dp/ASIN, Flipkart to ?pid=)
  domain           TEXT NOT NULL,
  title            TEXT,
  image            TEXT,
  currency         TEXT NOT NULL DEFAULT 'INR',
  current_price    REAL,
  mrp              REAL,                   -- list/strike-through price, only stored when > current price
  target_price     REAL,
  rating           REAL,                   -- 0-5, one decimal
  review_count     INTEGER,                -- ratings count shown on the store page
  model            TEXT,                   -- manufacturer model number / MPN when detectable
  canonical_key    TEXT,                   -- store-stable product id, e.g. "amazon.in:B0ABC12345" — dedupes re-adds
  group_id         TEXT,                   -- manual cross-store grouping (groups.id)
  delivery_text    TEXT,                   -- raw "FREE delivery Wednesday, 9 July" line, captured by the extension
  delivery_date    TEXT,                   -- parsed YYYY-MM-DD when the text was parseable
  delivery_pincode TEXT,                   -- pincode the page was showing when captured
  delivery_at      TEXT,                   -- when the extension captured delivery info (ISO 8601)
  created_at       TEXT NOT NULL,          -- ISO 8601
  last_checked     TEXT,
  last_status      TEXT,                   -- ok | blocked | error
  last_error       TEXT,
  archived         INTEGER NOT NULL DEFAULT 0
);

-- Step-function history: a row is written when the price changes, plus a daily
-- heartbeat row (>20h since last) so charts show continuity, not gaps.
CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  price      REAL NOT NULL,
  mrp        REAL,                         -- MRP at observation time (nullable)
  at         TEXT NOT NULL,                -- ISO 8601
  source     TEXT NOT NULL DEFAULT 'cron'  -- cron | manual | extension
);

CREATE INDEX IF NOT EXISTS idx_history_product_at ON price_history (product_id, at);

-- Cross-store product groups ("same lens on Amazon + Flipkart"). A group with
-- fewer than 2 members is dissolved automatically by the Worker.
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
