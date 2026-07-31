-- PriceWatch D1 schema (v4) — reference copy of the CURRENT full schema, for
-- dashboard-console installs where the CLI isn't available:
--   dashboard -> D1 -> pricewatch -> Console -> paste -> Execute
-- The canonical install/upgrade path is the migrations pipeline:
--   npx wrangler d1 migrations apply pricewatch --remote   (npm run db:migrate)
-- Fresh CLI installs should use migrations (0001..000N), not this file, so the
-- d1_migrations bookkeeping stays correct from day one.

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
  category         TEXT,                   -- user-assigned shelf ("Shoes", "Camera gear"); NULL = uncategorized
  availability     TEXT,                   -- 'InStock' | 'OutOfStock' | NULL (unknown), from JSON-LD / extension
  alerted_below_target INTEGER NOT NULL DEFAULT 0, -- target-alert hysteresis: 1 = already alerted, re-arms when price > target
  last_alert_at    TEXT,                   -- throttle for low/drop alerts (ISO 8601)
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

-- Every alert ever raised (target hit / all-time low / 24h drop / restock).
-- Powers the UI feed; delivered=1 means it was also pushed to Telegram.
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  type       TEXT NOT NULL,            -- target | low | drop | restock
  price      REAL,                     -- price that triggered the alert
  prev_price REAL,                     -- reference price (target / old low / 24h-ago)
  message    TEXT NOT NULL,
  at         TEXT NOT NULL,            -- ISO 8601
  delivered  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_at ON alerts (at);
