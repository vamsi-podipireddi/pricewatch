-- PriceWatch v1 -> v2 migration. Run ONCE against an existing v1 database,
-- BEFORE deploying the v2 Worker (the new code writes these columns).
--   Dashboard: D1 -> pricewatch -> Console -> paste this file -> Execute
--   CLI:       npx wrangler d1 execute pricewatch --remote --file=migrations/0002_v2.sql
--              npx wrangler d1 execute pricewatch --local  --file=migrations/0002_v2.sql
-- Running it twice fails with "duplicate column name" — harmless, it means
-- the migration is already applied.

ALTER TABLE products ADD COLUMN mrp REAL;
ALTER TABLE products ADD COLUMN rating REAL;
ALTER TABLE products ADD COLUMN review_count INTEGER;
ALTER TABLE products ADD COLUMN model TEXT;
ALTER TABLE products ADD COLUMN canonical_key TEXT;
ALTER TABLE products ADD COLUMN group_id TEXT;
ALTER TABLE products ADD COLUMN delivery_text TEXT;
ALTER TABLE products ADD COLUMN delivery_date TEXT;
ALTER TABLE products ADD COLUMN delivery_pincode TEXT;
ALTER TABLE products ADD COLUMN delivery_at TEXT;

ALTER TABLE price_history ADD COLUMN mrp REAL;

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
