-- One-time bootstrap for the REMOTE database (created before the migrations
-- pipeline existed). Marks the migrations that were applied by hand so
-- `wrangler d1 migrations apply pricewatch --remote` skips them and only runs
-- the genuinely new ones.
--
-- State this file assumes (remote, as of 2026-07-25): schema.sql v1 + 0002
-- applied; 0003 NOT yet applied. If you already ran 0003 remotely, add
-- ('0003_category.sql') to the INSERT below before running.
--
-- Run once:  npm run db:bootstrap
--   (or paste into dashboard -> D1 -> pricewatch -> Console)

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_v2.sql');
