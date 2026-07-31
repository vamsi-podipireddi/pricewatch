# PriceWatch

Track any product's price from any website. Generalized successor to
[lenswatch](../lenswatch) — same design system, but hosted on Cloudflare
(free tier) with automatic cron syncing, plus a Chrome extension that adds
products with one click.

Beyond the price, each product carries **MRP + discount %, star rating,
ratings count, model number, stock availability, and a delivery estimate for
your pincode** (delivery comes from the extension — see below). Products from
different stores can be **grouped** ("same lens on Amazon + Flipkart") with
automatic same-product suggestions, and any two products can be **compared**
side by side with overlaid price-history charts.

v4 adds **price alerts** (target price, all-time low, big 24h drops, restock —
optionally emailed to you via the Gmail API), a **deal meter** (today's price
vs the last 90 days), chart ranges up to all-time with MRP + typical-price overlays,
search/sort/category filters, product archiving, a PWA manifest, an extension
**popup** (tracked-status + trend at a glance), and **passive capture** —
browsing a tracked product page records its price automatically.

## How it works

```
Chrome extension ──one click──► Worker API ──► D1 (products + price_history)
       ▲                            ▲                    │
       │ scrapes the rendered DOM   │ cron every 2h      │
  product page                 server-side scrape        ▼
                              (Shopify/JSON-LD/meta/  website UI
                               Amazon/Flipkart regex)  (static assets)
```

- **One Worker** serves the site (static assets), the JSON API, and a
  scheduled sweep (cron trigger, every 2 hours, stalest products first).
  Bot-blocked products are skipped for 24h at a time — the extension owns
  them; a daily re-probe notices a store unblocking.
- **D1** stores products and a step-function price history: a row on every
  price *change* plus a daily heartbeat, so charts stay tiny but continuous.
  List responses window history to ~90 days (plus one anchor point); full
  history loads on demand via `GET /api/products/:id`.
- **Alerts fire inside `observe()`** — every successful observation is
  checked against the product's target price, its all-time low, a 24h drop
  threshold, and availability flips. Alerts land in an `alerts` table (the
  site's bell panel) and are emailed via the Gmail API when configured. See below.
- **The extension is the bot-wall workaround.** Amazon/Flipkart usually block
  datacenter IPs, so server-side checks can fail on those sites. The popup
  scrapes the page you're already looking at (real browser, real session) and
  pushes the price to the API. Passive capture goes further: a content
  script — registered dynamically for *only* the stores you already track —
  records the price whenever you happen to browse a tracked product page
  (`observeOnly`: browsing never adds new products).
- **Delivery estimates are extension-only by design.** Stores render the
  delivery date for the pincode set in *your* browser session; a server-side
  fetch has no location, so whatever it saw would be wrong. The extension
  captures the delivery line + pincode on every click; the site shows it with
  its capture time and marks it stale after ~3 days.
- **Cross-store identity.** Amazon URLs collapse to `/dp/ASIN`, Flipkart to
  `?pid=`, and each listing gets a canonical key (`amazon.in:B0ABC12345`) —
  re-adding the same listing under a different URL updates the existing
  product instead of duplicating it. Cross-*store* grouping (same product,
  different sites) is manual: select 2+ products → Group, or accept the
  automatic "these look alike" suggestion.

## Price alerts

Set a target on any product (its **Target price** tile). Every observation —
cron, popup, passive capture, auto-sync — then checks four triggers:

| Type | Fires when | Repeat behaviour |
| --- | --- | --- |
| `target` | price ≤ target price | once per crossing — re-arms when the price rises back above target (or the target changes) |
| `low` | new all-time tracked low (needs ≥3 prior points) | throttled to one low/drop alert per ~20h |
| `drop` | ≥ `ALERT_DROP_PCT` (default 10%) below ~24h ago | same throttle |
| `restock` | availability flips OutOfStock → InStock | on each flip |
 Alerts always land in the site's bell panel. To also get them **emailed to
your Gmail inbox**, the Worker sends through the Gmail API from your own
account — free, no third-party mail service. One-time setup:

1. [console.cloud.google.com](https://console.cloud.google.com) → create a
   project → *APIs & Services* → *Library* → enable **Gmail API**.
2. *OAuth consent screen* → External → fill the two required fields → then
   **Publish app** (stays unverified — only you will ever consent to it).
   Don't leave it in "Testing": testing-mode refresh tokens expire after 7
   days and alerts would silently stop.
3. *Credentials* → *Create credentials* → *OAuth client ID* → **Web
   application** → add `https://developers.google.com/oauthplayground` as an
   authorized redirect URI. Note the client ID + secret.
4. [OAuth Playground](https://developers.google.com/oauthplayground) → gear
   icon → *Use your own OAuth credentials* → paste ID + secret. In Step 1
   enter the scope `https://www.googleapis.com/auth/gmail.send` → *Authorize
   APIs* → pick your Gmail account and click through the unverified-app
   warning (*Advanced → Go to …*). In Step 2 *Exchange authorization code for
   tokens* → copy the **Refresh token**.
5. Set four secrets:

```bash
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put ALERT_EMAIL_TO        # e.g. you@gmail.com
```

Mail is sent from your own address to `ALERT_EMAIL_TO`; the alerts feed marks
delivered ones with "emailed".

## Deploy (once)

```bash
cd ~/projects/pricewatch
npm install                      # installs wrangler (dev dependency only)

npx wrangler d1 create pricewatch
# copy the database_id it prints into wrangler.toml

npm run db:migrate               # applies migrations/0001..000N to the remote D1
npx wrangler secret put API_TOKEN   # pick any long random string; protects writes
npm run deploy                   # runs pending migrations, then deploys
```

Optional secrets: `READ_TOKEN` (require a token for reads too — otherwise
anyone with the URL can see what you track, including delivery pincodes), and
the four Gmail alert secrets (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`, `ALERT_EMAIL_TO` — see "Price alerts" above).

The deploy prints your URL, e.g. `https://pricewatch.<subdomain>.workers.dev`.

- Site → open the URL, gear icon → paste the same API token.
- Extension → `chrome://extensions` → enable Developer mode → *Load unpacked*
  → select the `extension/` folder → open its options page → set server URL +
  token → pin the toolbar icon.

Skipping `API_TOKEN` leaves the API writable by anyone who finds the URL —
fine for a private subdomain, not recommended.

## Deploy via the Cloudflare dashboard (no CLI)

Same result as the CLI flow above, all in the browser. Order matters: the D1
database ID must be in `wrangler.toml` *before* the first build.

1. **Create the D1 database** — [dash.cloudflare.com](https://dash.cloudflare.com)
   → *Storage & Databases* → *D1 SQL Database* → *Create Database* → name it
   `pricewatch`. Copy the **Database ID** shown on the database page.
2. **Apply the schema** — open the database → *Console* tab → paste the full
   contents of `schema.sql` → *Execute*. Verify with
   `SELECT name FROM sqlite_master WHERE type='table';` — expect `products`,
   `price_history`, `groups` and `alerts`. Then mark all migrations applied
   (paste `scripts/bootstrap-d1-migrations-remote.sql` and add
   `('0003_category.sql'), ('0004_v4.sql')` to its INSERT) so future
   `npm run db:migrate` runs skip them.
3. **Put the ID in `wrangler.toml`** — edit the file on GitHub (pencil icon):
   replace `PASTE_D1_DATABASE_ID_HERE` with the copied ID, commit to `main`.
4. **Create the Worker from Git** — *Workers & Pages* → *Create* → *Workers*
   → *Import a repository* → authorize GitHub → pick the `pricewatch` repo.
   Leave the detected settings (config is read from `wrangler.toml`; deploy
   command `npx wrangler deploy`) → *Save and Deploy*. The first build prints
   your URL: `https://pricewatch.<subdomain>.workers.dev`.
5. **Set the write token** — Worker → *Settings* → *Variables and Secrets* →
   *Add* → type **Secret**, name `API_TOKEN`, value = any long random string.
6. **Verify the cron** — Worker → *Settings* → *Trigger Events*: the
   `11 */2 * * *` schedule from `wrangler.toml` should be listed after the
   first deploy.
7. **Connect the clients** — site URL → gear icon → paste the token.
   Extension → options page → server URL + token → *Test connection*.

Every push to `main` now auto-deploys.

## Local dev

```bash
npm run db:migrate:local   # apply migrations to the local D1 emulator
npm run dev                # http://localhost:8787
```

Tests:

```bash
npm test              # node --test — extraction engine, HTML parser, alert helpers
npm run test:worker   # vitest-pool-workers — API routes against a real, isolated D1
npm run test:all      # both
```

Trigger the cron locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`
(wrangler dev exposes scheduled handlers there), or just use "Sync prices"
in the UI. The header's "Refresh" button only re-reads saved data (picks up
extension clicks / cron results); "Sync prices" is the one that re-scrapes.

## API

All responses JSON; CORS open. Writes need `X-Auth-Token` when `API_TOKEN` is set.

| Route | What |
| --- | --- |
| `GET /api/health` | `{ ok, authRequired, readAuthRequired, authOk }` — extension "Test connection" |
| `GET /api/products` | `{ products, groups, meta }`; products carry `points: [{t, p, m?}]` history windowed to ~90d + one anchor (m = MRP), plus `mrp, rating, reviewCount, model, availability, targetPrice, category, groupId, archived, deliveryText/Date/Pincode/At`. `?archived=1` lists archived products instead |
| `GET /api/products/:id` | One product with FULL history |
| `GET /api/products/lookup?url=` | `{ product \| null }` — matches by normalized URL or canonical key (extension popup) |
| `GET /api/alerts` | Last 50 alerts, joined with product title/image |
| `POST /api/products` | `{url}` → server scrapes; extension sends `{url, price, mrp?, currency?, availability?, rating?, …, source:'extension'}`. Upserts by normalized URL *or* canonical key. `observeOnly: true` updates a tracked product but never creates one (passive capture) |
| `POST /api/products/:id/refresh` | Scrape now |
| `PATCH /api/products/:id` | `{title?, targetPrice?, archived?, groupId?, category?}` (`groupId: null` leaves the group; changing `targetPrice` re-arms its alert) |
| `DELETE /api/products/:id` | Remove product + history |
| `POST /api/products/bulk-delete` | `{ids: [...]}` — remove many products + their history in one call (UI: Select → Delete) |
| `POST /api/groups` | `{name, productIds: [>=2]}` |
| `PATCH /api/groups/:id` | `{name}` |
| `DELETE /api/groups/:id` | Dissolve — members stay tracked, ungrouped |

Groups with fewer than 2 active members dissolve automatically. URLs are
normalized before storage: tracking params stripped (`utm_*`, `fbclid`,
`gclid`, …), Amazon collapsed to `/dp/ASIN`, Flipkart to its `pid` — so the
extension and a pasted URL land on the same product.

## Extraction chain (server)

1. **Shopify** — `/products/<handle>.js`, clean JSON.
2. **JSON-LD** — schema.org `Product` → `offers.price` + `priceCurrency`
   (covers most Shopify/Woo/Magento themes).
3. **Meta tags** — `og:price:amount`, `product:price:amount`, `itemprop=price`.
4. **Amazon / Flipkart** — site-specific regex; detects bot walls and marks
   the product `blocked` instead of erroring.

The extension adds a 5th, strongest path: the rendered DOM, with a
biggest-visible-price heuristic that skips struck-through MRPs.

Every path also collects extras where available: MRP (Amazon `basisPrice`
"M.R.P." row first — a deal's "Was:" strike must not win — then labeled
M.R.P. text, then buy-box strikes / Flipkart embedded state / Shopify
`compare_at_price`; only kept when strictly above the price), rating +
ratings count (JSON-LD `aggregateRating`, Amazon's own review block — never
carousel snippets), and model number (JSON-LD `mpn`, Amazon "Item model
number", Flipkart spec table). The extension's MRP scan is anchored to the
price element's own block and ignores cross-sell rails (carousels, "similar
items"), so a related product's strike price can't become this product's MRP.
The extension additionally parses the delivery line into a date (`Tomorrow`,
`Wednesday, 9 July`, …).

## Migrations

Schema changes ship as numbered files in `migrations/` and are applied with
Wrangler's built-in tracking (`d1_migrations` table records what ran):

```bash
npm run db:migrate         # remote: apply pending migrations
npm run db:migrate:local   # local dev database
```

`npm run deploy` runs remote migrations before deploying, so the Worker can
never outrun its schema. If you deploy from Git (Workers Builds), set the
project's **deploy command** to:

```
npx wrangler d1 migrations apply pricewatch --remote && npx wrangler deploy
```

**Upgrading a pre-v4 database (created before this pipeline existed)** — the
tracking table doesn't know about migrations applied by hand, so bootstrap it
once, then apply:

```bash
npm run db:bootstrap       # marks 0001+0002 as already applied (edit the file
                           # first to add 0003 if you already ran db:migrate:v3)
npm run db:migrate         # applies 0003 (category) + 0004 (alerts) + newer
```

No CLI? Same thing in the dashboard console (D1 → pricewatch → Console):
paste `scripts/bootstrap-d1-migrations-remote.sql`, then any unapplied
migration files in order (`0003_category.sql`, `0004_v4.sql`), then mark those
as applied too:
`INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_category.sql'), ('0004_v4.sql');`

After upgrading, reload the extension: `chrome://extensions` → PriceWatch →
reload (⟳) — v1.4.0 adds the popup and passive capture, and Chrome re-asks
for permissions on manifest changes.

## Free-tier constraints (why the numbers are what they are)

- **10 ms CPU / invocation** → scanned HTML capped at 900 KB, cron batch
  capped at `SWEEP_BATCH` (6). Effective per-product cadence:
  `2h × ceil(count / 6)` — 18 products ⇒ every 6 h.
- **Cron triggers** are a Workers feature (not Pages) — that's why this is a
  single Worker with static assets rather than a Pages project; same hosting,
  same free tier, and cron works.
- "Sync prices" in the UI fans out client-side, one request per product, so
  it never hits the per-invocation subrequest cap.

## Layout

```
wrangler.toml        Worker config: assets, D1 binding, cron, alert vars
wrangler.test.toml   test-only config for vitest-pool-workers (isolated D1)
schema.sql           current full schema — dashboard-console installs only
migrations/          0001..0004 — the canonical schema history (wrangler d1 migrations)
scripts/             one-time d1_migrations bootstrap for pre-pipeline databases
src/worker.js        API routes, auth, groups, cron sweep
src/alerts.js        alert engine: target/low/drop/restock + Gmail email push
src/extract.js       adapter chain + extras (MRP/rating/model/availability) + URL normalization
public/              site (vanilla JS, no build step) + PWA manifest + service worker
extension/           Chrome MV3: popup, background (capture/auto-sync/passive), options
test/                node --test unit tests + test/worker vitest route tests
```

Runtime dependencies: none. Dev dependencies: `wrangler`, `vitest`,
`@cloudflare/vitest-pool-workers`.
The extension has no icons on purpose (Chrome falls back to an initial) —
add PNGs under `extension/icons/` and reference them in the manifest if wanted.
