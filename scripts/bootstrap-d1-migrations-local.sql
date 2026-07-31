-- One-time bootstrap for the LOCAL dev database (wrangler dev / --local).
-- Local already has schema v1 + 0002 + 0003 applied by hand; mark them so
-- `wrangler d1 migrations apply pricewatch --local` only runs 0004+.
--
-- Run once:  npm run db:bootstrap:local

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_v2.sql'),
  ('0003_category.sql');
