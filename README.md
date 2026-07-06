# PriceWatch

Track any product's price from any website. Generalized successor to
[lenswatch](../lenswatch) — same design system, but hosted on Cloudflare
(free tier) with automatic cron syncing, plus a Chrome extension that adds
products with one click.

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
- **D1** stores products and a step-function price history: a row on every
  price *change* plus a daily heartbeat, so charts stay tiny but continuous.
- **The extension is the bot-wall workaround.** Amazon/Flipkart usually block
  datacenter IPs, so server-side checks can fail on those sites. The extension
  scrapes the page you're already looking at (real browser, real session) and
  pushes the price to the API. Clicking it on an already-tracked product
  records a fresh observation — badge shows `upd`.

## Deploy (once)

```bash
cd ~/projects/pricewatch
npm install                      # installs wrangler (dev dependency only)

npx wrangler d1 create pricewatch
# copy the database_id it prints into wrangler.toml

npm run db:init                  # applies schema.sql to the remote D1
npx wrangler secret put API_TOKEN   # pick any long random string; protects writes
npm run deploy
```

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
   `SELECT name FROM sqlite_master WHERE type='table';` — expect `products`
   and `price_history`.
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
npm run db:local     # apply schema to the local D1 emulator (first time)
npm run dev          # http://localhost:8787
```

Trigger the cron locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`
(wrangler dev exposes scheduled handlers there), or just use "Check all now"
in the UI.

## API

All responses JSON; CORS open. Writes need `X-Auth-Token` when `API_TOKEN` is set.

| Route | What |
| --- | --- |
| `GET /api/health` | `{ ok, authRequired, authOk }` — extension "Test connection" |
| `GET /api/products` | All products with `points: [{t, p}]` history |
| `POST /api/products` | `{url}` → server scrapes; `{url, price, currency?, title?, image?}` → trusts the client (extension). Upserts by normalized URL |
| `POST /api/products/:id/refresh` | Scrape now |
| `PATCH /api/products/:id` | `{title?, targetPrice?, archived?}` |
| `DELETE /api/products/:id` | Remove product + history |

URLs are normalized before storage: tracking params stripped (`utm_*`,
`fbclid`, `gclid`, …), Amazon collapsed to `/dp/ASIN` — so the extension and
a pasted URL land on the same product.

## Extraction chain (server)

1. **Shopify** — `/products/<handle>.js`, clean JSON.
2. **JSON-LD** — schema.org `Product` → `offers.price` + `priceCurrency`
   (covers most Shopify/Woo/Magento themes).
3. **Meta tags** — `og:price:amount`, `product:price:amount`, `itemprop=price`.
4. **Amazon / Flipkart** — site-specific regex; detects bot walls and marks
   the product `blocked` instead of erroring.

The extension adds a 5th, strongest path: the rendered DOM, with a
biggest-visible-price heuristic that skips struck-through MRPs.

## Free-tier constraints (why the numbers are what they are)

- **10 ms CPU / invocation** → scanned HTML capped at 900 KB, cron batch
  capped at `SWEEP_BATCH` (6). Effective per-product cadence:
  `2h × ceil(count / 6)` — 18 products ⇒ every 6 h.
- **Cron triggers** are a Workers feature (not Pages) — that's why this is a
  single Worker with static assets rather than a Pages project; same hosting,
  same free tier, and cron works.
- "Check all now" in the UI fans out client-side, one request per product, so
  it never hits the per-invocation subrequest cap.

## Layout

```
wrangler.toml        Worker config: assets, D1 binding, cron
schema.sql           D1 schema (products, price_history)
src/worker.js        API routes, auth, cron sweep
src/extract.js       adapter chain + URL normalization
public/              site (vanilla JS, no build step)
extension/           Chrome MV3: background.js (scrape + POST), options page
```

No runtime dependencies anywhere; `wrangler` is the only dev dependency.
The extension has no icons on purpose (Chrome falls back to an initial) —
add PNGs under `extension/icons/` and reference them in the manifest if wanted.
