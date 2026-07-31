-- Migration number: 0004    v4: availability tracking + price-drop alerts.
--
-- products.availability        'InStock' | 'OutOfStock' | NULL (unknown) — from
--                              JSON-LD offers.availability or the extension.
-- products.alerted_below_target  hysteresis flag: 1 after a target-hit alert
--                              fired; reset to 0 once the price rises back
--                              above target, re-arming the alert.
-- products.last_alert_at       throttle for low/drop alerts (max one per ~20h).
-- alerts                       every alert ever raised — powers the UI feed and
--                              survives Telegram being unconfigured/down.

ALTER TABLE products ADD COLUMN availability TEXT;
ALTER TABLE products ADD COLUMN alerted_below_target INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN last_alert_at TEXT;

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  type       TEXT NOT NULL,            -- target | low | drop | restock
  price      REAL,                     -- price that triggered the alert
  prev_price REAL,                     -- reference price (target / old low / 24h-ago)
  message    TEXT NOT NULL,
  at         TEXT NOT NULL,            -- ISO 8601
  delivered  INTEGER NOT NULL DEFAULT 0  -- 1 = pushed to Telegram successfully
);

CREATE INDEX IF NOT EXISTS idx_alerts_at ON alerts (at);
