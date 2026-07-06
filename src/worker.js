// PriceWatch Worker: API + static site + scheduled price sweep.
//
// Routes (JSON, CORS-open so the Chrome extension can call from anywhere):
//   GET    /api/health                 -> { ok, authRequired, authOk }
//   GET    /api/products               -> { products: [...], meta }
//   POST   /api/products               -> add URL, or record a price observation
//                                         for an existing URL (extension path)
//   POST   /api/products/:id/refresh   -> scrape now
//   PATCH  /api/products/:id           -> { title?, targetPrice?, archived? }
//   DELETE /api/products/:id
//
// Writes require the X-Auth-Token header when the API_TOKEN secret is set
// (npx wrangler secret put API_TOKEN). Reads stay open.

import { extract, normalizeUrl } from './extract.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,x-auth-token',
  'access-control-max-age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: err?.message || 'Internal error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

/* ---------- auth / helpers ---------- */

const authorized = (request, env) =>
  !env.API_TOKEN || request.headers.get('x-auth-token') === env.API_TOKEN;

const readBody = (request) => request.json().catch(() => null);

const batchSize = (env) => {
  const n = Number(env.SWEEP_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 6;
};

const cleanText = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

const cleanCurrency = (v) =>
  typeof v === 'string' && /^[A-Za-z]{3}$/.test(v.trim()) ? v.trim().toUpperCase() : null;

const cleanPrice = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e9 ? v : null);

function rowToApi(r, points = []) {
  return {
    id: r.id,
    url: r.url,
    domain: r.domain,
    title: r.title,
    image: r.image,
    currency: r.currency,
    currentPrice: r.current_price,
    targetPrice: r.target_price,
    createdAt: r.created_at,
    lastChecked: r.last_checked,
    lastStatus: r.last_status,
    lastError: r.last_error,
    points,
  };
}

/* ---------- routing ---------- */

async function handleApi(request, env, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', 'products', id?, action?]
  const method = request.method;

  if (seg[1] === 'health') {
    return json({ ok: true, authRequired: Boolean(env.API_TOKEN), authOk: authorized(request, env) });
  }
  if (seg[1] !== 'products') return json({ error: 'Not found' }, 404);

  if (method === 'GET' && seg.length === 2) return listProducts(env);

  // Everything past this point mutates.
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized: set the X-Auth-Token header to your API token.' }, 401);
  }

  if (method === 'POST' && seg.length === 2) return addOrObserve(env, await readBody(request));

  const id = seg[2];
  if (!id) return json({ error: 'Not found' }, 404);
  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!product) return json({ error: 'Product not found' }, 404);

  if (method === 'POST' && seg[3] === 'refresh' && seg.length === 4) {
    const r = await checkProduct(env, product, 'manual');
    return json({ product: await getProduct(env, id), checked: r.ok });
  }

  if (method === 'PATCH' && seg.length === 3) {
    const b = (await readBody(request)) ?? {};
    const sets = [];
    const binds = [];
    if (typeof b.title === 'string' && b.title.trim()) {
      sets.push('title = ?');
      binds.push(b.title.trim().slice(0, 300));
    }
    if (b.targetPrice === null || cleanPrice(b.targetPrice) != null) {
      sets.push('target_price = ?');
      binds.push(b.targetPrice);
    }
    if (typeof b.archived === 'boolean') {
      sets.push('archived = ?');
      binds.push(b.archived ? 1 : 0);
    }
    if (!sets.length) return json({ error: 'Nothing to update' }, 400);
    await env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    return json({ product: await getProduct(env, id) });
  }

  if (method === 'DELETE' && seg.length === 3) {
    await env.DB.prepare('DELETE FROM price_history WHERE product_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

/* ---------- reads ---------- */

async function listProducts(env) {
  const prods = (
    await env.DB.prepare('SELECT * FROM products WHERE archived = 0 ORDER BY created_at DESC').all()
  ).results;
  const byId = new Map(prods.map((p) => [p.id, []]));
  if (prods.length) {
    const hist = (
      await env.DB.prepare('SELECT product_id, price, at FROM price_history ORDER BY at ASC LIMIT 20000').all()
    ).results;
    for (const h of hist) byId.get(h.product_id)?.push({ t: h.at, p: h.price });
  }
  return json({
    products: prods.map((p) => rowToApi(p, byId.get(p.id))),
    meta: { authRequired: Boolean(env.API_TOKEN), sweepBatch: batchSize(env), sweepEveryHours: 2 },
  });
}

async function getProduct(env, id) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!row) return null;
  const pts = (
    await env.DB.prepare('SELECT price, at FROM price_history WHERE product_id = ? ORDER BY at ASC LIMIT 2000')
      .bind(id)
      .all()
  ).results;
  return rowToApi(row, pts.map((r) => ({ t: r.at, p: r.price })));
}

/* ---------- writes ---------- */

// POST /api/products. Two shapes:
//   { url }                                    site form -> scrape server-side
//   { url, price, currency?, title?, image? }  extension -> trust the in-page scrape
// Upserts by normalized URL: an existing product just gets a fresh observation,
// so re-clicking the extension is the manual "refresh" that beats bot walls.
async function addOrObserve(env, b) {
  if (!b || typeof b.url !== 'string') return json({ error: 'url is required' }, 400);
  let norm;
  try {
    norm = normalizeUrl(b.url);
  } catch (err) {
    return json({ error: err.message || 'Invalid URL' }, 400);
  }

  const price = cleanPrice(b.price);
  const source = b.source === 'extension' ? 'extension' : 'manual';
  const observation = {
    price,
    currency: cleanCurrency(b.currency),
    title: cleanText(b.title, 300),
    image: cleanText(b.image, 600),
  };

  const existing = await env.DB.prepare('SELECT * FROM products WHERE url = ?').bind(norm).first();
  if (existing) {
    if (price != null) await observe(env, existing, observation, source);
    return json({ product: await getProduct(env, existing.id), existing: true });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const domain = new URL(norm).hostname.replace(/^www\./, '');
  await env.DB.prepare(
    'INSERT INTO products (id, url, domain, title, image, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, norm, domain, observation.title, observation.image, observation.currency ?? 'INR', now)
    .run();
  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();

  if (price != null) {
    await observe(env, product, observation, source);
  } else {
    await checkProduct(env, product, source); // first scrape inline; cron retries failures
  }
  return json({ product: await getProduct(env, id), existing: false }, 201);
}

// Record one price point. History rows only on change or >20h heartbeat —
// step-function storage keeps history tiny but charts continuous.
async function observe(env, product, r, source) {
  const now = new Date().toISOString();
  const last = await env.DB.prepare(
    'SELECT price, at FROM price_history WHERE product_id = ? ORDER BY at DESC LIMIT 1'
  )
    .bind(product.id)
    .first();
  const changed = !last || Math.abs(last.price - r.price) > 0.009;
  const heartbeat = last && Date.now() - Date.parse(last.at) > 20 * 3600 * 1000;
  if (changed || heartbeat) {
    await env.DB.prepare('INSERT INTO price_history (product_id, price, at, source) VALUES (?, ?, ?, ?)')
      .bind(product.id, r.price, now, source)
      .run();
  }
  await env.DB.prepare(
    `UPDATE products SET
       current_price = ?,
       currency = COALESCE(?, currency),
       title = CASE WHEN title IS NULL OR title = '' THEN COALESCE(?, title) ELSE title END,
       image = COALESCE(image, ?),
       last_checked = ?, last_status = 'ok', last_error = NULL
     WHERE id = ?`
  )
    .bind(r.price, r.currency ?? null, r.title ?? null, r.image ?? null, now, product.id)
    .run();
}

async function checkProduct(env, product, source = 'cron') {
  const r = await extract(product.url);
  if (r.ok) {
    await observe(env, product, r, source);
    return r;
  }
  await env.DB.prepare('UPDATE products SET last_checked = ?, last_status = ?, last_error = ? WHERE id = ?')
    .bind(new Date().toISOString(), r.blocked ? 'blocked' : 'error', r.error || 'check failed', product.id)
    .run();
  return r;
}

/* ---------- cron sweep ---------- */

// Stalest-first batch. Effective per-product cadence: 2h * ceil(count / batch).
async function sweep(env) {
  const rows = (
    await env.DB.prepare(
      'SELECT * FROM products WHERE archived = 0 ORDER BY last_checked IS NOT NULL, last_checked ASC LIMIT ?'
    )
      .bind(batchSize(env))
      .all()
  ).results;
  const cutoff = Date.now() - 50 * 60 * 1000;
  for (const p of rows) {
    if (p.last_checked && Date.parse(p.last_checked) > cutoff) continue;
    await checkProduct(env, p, 'cron');
  }
}
