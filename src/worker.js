// PriceWatch Worker: API + static site + scheduled price sweep.
//
// Routes (JSON, CORS-open so the Chrome extension can call from anywhere):
//   GET    /api/health                 -> { ok, authRequired, readAuthRequired, authOk }
//   GET    /api/products               -> { products: [...], groups: [...], meta }
//                                         ?archived=1 lists archived products instead
//   GET    /api/products/:id           -> single product with FULL history (list
//                                         responses window points to ~90d)
//   GET    /api/products/lookup?url=   -> match by normalized URL / canonical key
//                                         (extension popup: "is this page tracked?")
//   GET    /api/alerts                 -> recent alerts feed (target/low/drop/restock)
//   POST   /api/products               -> add URL, or record a price observation
//                                         for an existing URL (extension path);
//                                         observeOnly:true never creates products
//   POST   /api/products/:id/refresh   -> scrape now
//   POST   /api/products/bulk-delete   -> { ids: [...] } — delete many + their history
//   PATCH  /api/products/:id           -> { title?, targetPrice?, archived?, groupId?, category? }
//   DELETE /api/products/:id
//   POST   /api/groups                 -> { name?, productIds: [>=2] }
//   PATCH  /api/groups/:id             -> { name }
//   DELETE /api/groups/:id             -> dissolve (members kept, ungrouped)
//
// Writes require the X-Auth-Token header when the API_TOKEN secret is set
// (npx wrangler secret put API_TOKEN). Reads stay open unless the optional
// READ_TOKEN secret is set (then reads accept READ_TOKEN or API_TOKEN).
// Price alerts (see alerts.js) are emailed via the Gmail API when the
// GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN /
// ALERT_EMAIL_TO secrets are set; the alerts table feeds the UI regardless.

import { extract, normalizeUrl, canonicalKey } from './extract.js';
import { evaluateAlerts, emailConfigured } from './alerts.js';

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

const DAY = 86400_000;

const authorized = (request, env) =>
  !env.API_TOKEN || request.headers.get('x-auth-token') === env.API_TOKEN;

// Reads are open by default. Setting the READ_TOKEN secret closes them; the
// write token is always accepted for reads too.
const readAuthorized = (request, env) => {
  if (!env.READ_TOKEN) return true;
  const t = request.headers.get('x-auth-token');
  return t === env.READ_TOKEN || (Boolean(env.API_TOKEN) && t === env.API_TOKEN);
};

const cleanAvailability = (v) => (v === 'InStock' || v === 'OutOfStock' ? v : null);

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

const cleanRating = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 5 ? Math.round(v * 10) / 10 : null;

const cleanCount = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string'
    ? (() => {
        const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
        return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
      })()
    : null;

const cleanPincode = (v) =>
  typeof v === 'string' && /^[\w][\w -]{2,11}$/.test(v.trim()) ? v.trim() : null;

const cleanISODate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null;

function rowToApi(r, points = []) {
  return {
    id: r.id,
    url: r.url,
    domain: r.domain,
    title: r.title,
    image: r.image,
    currency: r.currency,
    currentPrice: r.current_price,
    mrp: r.mrp,
    targetPrice: r.target_price,
    rating: r.rating,
    reviewCount: r.review_count,
    model: r.model,
    canonicalKey: r.canonical_key,
    groupId: r.group_id,
    category: r.category ?? null,
    availability: r.availability ?? null,
    archived: Boolean(r.archived),
    deliveryText: r.delivery_text,
    deliveryDate: r.delivery_date,
    deliveryPincode: r.delivery_pincode,
    deliveryAt: r.delivery_at,
    createdAt: r.created_at,
    lastChecked: r.last_checked,
    lastStatus: r.last_status,
    lastError: r.last_error,
    points,
  };
}

/* ---------- routing ---------- */

async function handleApi(request, env, url) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', 'products'|'groups', id?, action?]
  const method = request.method;

  if (seg[1] === 'health') {
    return json({
      ok: true,
      authRequired: Boolean(env.API_TOKEN),
      readAuthRequired: Boolean(env.READ_TOKEN),
      authOk: authorized(request, env),
    });
  }

  if (method === 'GET' && !readAuthorized(request, env)) {
    return json({ error: 'Unauthorized: this deployment requires a token for reads too.' }, 401);
  }

  if (seg[1] === 'alerts' && method === 'GET' && seg.length === 2) return listAlerts(env);

  if (seg[1] === 'groups') {
    if (!authorized(request, env)) {
      return json({ error: 'Unauthorized: set the X-Auth-Token header to your API token.' }, 401);
    }
    if (method === 'POST' && seg.length === 2) return createGroup(env, await readBody(request));
    const gid = seg[2];
    if (!gid || seg.length !== 3) return json({ error: 'Not found' }, 404);
    const group = await env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(gid).first();
    if (!group) return json({ error: 'Group not found' }, 404);
    if (method === 'PATCH') {
      const name = cleanText((await readBody(request))?.name, 120);
      if (!name) return json({ error: 'name is required' }, 400);
      await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name, gid).run();
      return json({ group: { id: gid, name } });
    }
    if (method === 'DELETE') {
      await env.DB.prepare('UPDATE products SET group_id = NULL WHERE group_id = ?').bind(gid).run();
      await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(gid).run();
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  }

  if (seg[1] !== 'products') return json({ error: 'Not found' }, 404);

  if (method === 'GET' && seg.length === 2) return listProducts(env, url);

  if (method === 'GET' && seg[2] === 'lookup' && seg.length === 3) return lookupProduct(env, url);

  if (method === 'GET' && seg.length === 3) {
    const product = await getProduct(env, seg[2]);
    return product ? json({ product }) : json({ error: 'Product not found' }, 404);
  }

  // Everything past this point mutates.
  if (!authorized(request, env)) {
    return json({ error: 'Unauthorized: set the X-Auth-Token header to your API token.' }, 401);
  }

  if (method === 'POST' && seg.length === 2) return addOrObserve(env, await readBody(request));

  if (method === 'POST' && seg[2] === 'bulk-delete' && seg.length === 3) {
    const b = await readBody(request);
    const ids = Array.isArray(b?.ids)
      ? [...new Set(b.ids.filter((x) => typeof x === 'string'))].slice(0, 200)
      : [];
    if (!ids.length) return json({ error: 'ids is required (non-empty array of product ids)' }, 400);
    const marks = ids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM price_history WHERE product_id IN (${marks})`).bind(...ids).run();
    const r = await env.DB.prepare(`DELETE FROM products WHERE id IN (${marks})`).bind(...ids).run();
    await cleanupGroups(env);
    return json({ ok: true, deleted: r.meta?.changes ?? 0 });
  }

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
      sets.push('alerted_below_target = 0'); // new target re-arms the alert
    }
    if (typeof b.archived === 'boolean') {
      sets.push('archived = ?');
      binds.push(b.archived ? 1 : 0);
    }
    if ('category' in b) {
      const cat = cleanText(b.category, 40);
      if (b.category === null || b.category === '' || cat) {
        sets.push('category = ?');
        binds.push(cat);
      }
    }
    if ('groupId' in b) {
      if (b.groupId === null) {
        sets.push('group_id = NULL');
      } else if (typeof b.groupId === 'string') {
        const g = await env.DB.prepare('SELECT id FROM groups WHERE id = ?').bind(b.groupId).first();
        if (!g) return json({ error: 'Group not found' }, 404);
        sets.push('group_id = ?');
        binds.push(b.groupId);
      }
    }
    if (!sets.length) return json({ error: 'Nothing to update' }, 400);
    await env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
    if ('groupId' in b) await cleanupGroups(env);
    return json({ product: await getProduct(env, id) });
  }

  if (method === 'DELETE' && seg.length === 3) {
    await env.DB.prepare('DELETE FROM price_history WHERE product_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    await cleanupGroups(env);
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}

/* ---------- reads ---------- */

const POINTS_WINDOW_DAYS = 90;

// List responses window history to the last 90 days plus one anchor row per
// product from before the window (so a price that hasn't changed in months
// still draws as a line, not an empty chart). Full history: GET /:id.
async function listProducts(env, url) {
  const archived = url?.searchParams?.get('archived') === '1' ? 1 : 0;
  const prods = (
    await env.DB.prepare('SELECT * FROM products WHERE archived = ? ORDER BY created_at DESC')
      .bind(archived)
      .all()
  ).results;
  const groups = (await env.DB.prepare('SELECT id, name, created_at FROM groups').all()).results.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.created_at,
  }));
  const byId = new Map(prods.map((p) => [p.id, []]));
  if (prods.length) {
    const cutoff = new Date(Date.now() - POINTS_WINDOW_DAYS * DAY).toISOString();
    const anchors = (
      await env.DB.prepare(
        'SELECT product_id, price, mrp, MAX(at) AS at FROM price_history WHERE at < ? GROUP BY product_id'
      ).bind(cutoff).all()
    ).results;
    for (const h of anchors) byId.get(h.product_id)?.push({ t: h.at, p: h.price, ...(h.mrp != null ? { m: h.mrp } : {}) });
    const hist = (
      await env.DB.prepare(
        'SELECT product_id, price, mrp, at FROM price_history WHERE at >= ? ORDER BY at ASC LIMIT 20000'
      ).bind(cutoff).all()
    ).results;
    for (const h of hist) byId.get(h.product_id)?.push({ t: h.at, p: h.price, ...(h.mrp != null ? { m: h.mrp } : {}) });
  }
  return json({
    products: prods.map((p) => rowToApi(p, byId.get(p.id))),
    groups,
    meta: {
      authRequired: Boolean(env.API_TOKEN),
      readAuthRequired: Boolean(env.READ_TOKEN),
      sweepBatch: batchSize(env),
      sweepEveryHours: 2,
      pointsWindowDays: POINTS_WINDOW_DAYS,
      email: emailConfigured(env),
    },
  });
}

async function listAlerts(env) {
  const rows = (
    await env.DB.prepare(
      `SELECT a.id, a.product_id, a.type, a.price, a.prev_price, a.message, a.at, a.delivered,
              p.title, p.url, p.domain, p.image, p.currency
         FROM alerts a LEFT JOIN products p ON p.id = a.product_id
        ORDER BY a.at DESC LIMIT 50`
    ).all()
  ).results;
  return json({
    alerts: rows.map((a) => ({
      id: a.id,
      productId: a.product_id,
      type: a.type,
      price: a.price,
      prevPrice: a.prev_price,
      message: a.message,
      at: a.at,
      delivered: Boolean(a.delivered),
      title: a.title,
      url: a.url,
      domain: a.domain,
      image: a.image,
      currency: a.currency,
    })),
  });
}

// Extension popup: "is the page I'm on tracked?" Matches exactly the way
// addOrObserve dedupes — normalized URL first, canonical key second.
async function lookupProduct(env, url) {
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'url query parameter is required' }, 400);
  let norm;
  try {
    norm = normalizeUrl(raw);
  } catch (err) {
    return json({ error: err.message || 'Invalid URL' }, 400);
  }
  let row = await env.DB.prepare('SELECT * FROM products WHERE url = ?').bind(norm).first();
  if (!row) {
    const ck = canonicalKey(norm);
    if (ck) row = await env.DB.prepare('SELECT * FROM products WHERE canonical_key = ?').bind(ck).first();
  }
  if (!row) return json({ product: null });
  return json({ product: await getProduct(env, row.id) });
}

async function getProduct(env, id) {
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
  if (!row) return null;
  const pts = (
    await env.DB.prepare('SELECT price, mrp, at FROM price_history WHERE product_id = ? ORDER BY at ASC LIMIT 2000')
      .bind(id)
      .all()
  ).results;
  return rowToApi(row, pts.map((r) => ({ t: r.at, p: r.price, ...(r.mrp != null ? { m: r.mrp } : {}) })));
}

/* ---------- writes ---------- */

// POST /api/products. Two shapes:
//   { url }                          site form -> scrape server-side
//   { url, price, mrp?, currency?, title?, image?, rating?, reviewCount?,
//     model?, deliveryText?, deliveryDate?, deliveryPincode?, source: 'extension' }
//                                    extension -> trust the in-page scrape
// Upserts by normalized URL *or* canonical product key (ASIN / Flipkart pid):
// an existing product just gets a fresh observation, so re-clicking the
// extension is the manual "refresh" that beats bot walls.
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
    mrp: cleanPrice(b.mrp),
    currency: cleanCurrency(b.currency),
    title: cleanText(b.title, 300),
    image: cleanText(b.image, 600),
    rating: cleanRating(b.rating),
    reviewCount: cleanCount(b.reviewCount),
    model: cleanText(b.model, 80),
    availability: cleanAvailability(b.availability),
  };
  const delivery = {
    text: cleanText(b.deliveryText, 160),
    date: cleanISODate(b.deliveryDate),
    pincode: cleanPincode(b.deliveryPincode),
  };
  const hasDelivery = source === 'extension' && (delivery.text || delivery.date);

  const ck = canonicalKey(norm);
  let existing = await env.DB.prepare('SELECT * FROM products WHERE url = ?').bind(norm).first();
  if (!existing && ck) {
    existing = await env.DB.prepare('SELECT * FROM products WHERE canonical_key = ?').bind(ck).first();
  }
  if (existing) {
    if (price != null) await observe(env, existing, observation, source);
    if (hasDelivery) await saveDelivery(env, existing.id, delivery);
    return json({ product: await getProduct(env, existing.id), existing: true });
  }

  // Passive captures (extension content script) only ever update products the
  // user already tracks — browsing a store must never auto-add products.
  if (b.observeOnly) return json({ product: null, existing: false, observed: false });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const domain = new URL(norm).hostname.replace(/^www\./, '');
  await env.DB.prepare(
    'INSERT INTO products (id, url, domain, title, image, currency, canonical_key, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(id, norm, domain, observation.title, observation.image, observation.currency ?? 'INR', ck, cleanText(b.category, 40), now)
    .run();
  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();

  if (price != null) {
    await observe(env, product, observation, source);
  } else {
    await checkProduct(env, product, source); // first scrape inline; cron retries failures
  }
  if (hasDelivery) await saveDelivery(env, id, delivery);
  return json({ product: await getProduct(env, id), existing: false }, 201);
}

// Record one price point. History rows only on change or >20h heartbeat —
// step-function storage keeps history tiny but charts continuous.
// MRP / rating / review count only overwrite when the new check produced a
// value; a page that hides them on one load shouldn't wipe stored data.
async function observe(env, product, r, source) {
  const now = new Date().toISOString();
  const mrp = r.mrp != null && r.mrp > r.price ? r.mrp : null;
  const last = await env.DB.prepare(
    'SELECT price, at FROM price_history WHERE product_id = ? ORDER BY at DESC LIMIT 1'
  )
    .bind(product.id)
    .first();
  // A server-side check that comes back in a different currency (geo-priced
  // store ignoring the currency cookie) must not mix e.g. USD numbers into an
  // INR history. The extension scrapes what the user actually sees, so its
  // observations are exempt and may legitimately move the product's currency.
  if (last && source !== 'extension' && r.currency && product.currency && r.currency !== product.currency) {
    await env.DB.prepare('UPDATE products SET last_checked = ?, last_status = ?, last_error = ? WHERE id = ?')
      .bind(now, 'error', `Store returned ${r.currency} but product is tracked in ${product.currency}; price skipped.`, product.id)
      .run();
    return;
  }
  const availability = cleanAvailability(r.availability);
  // Alerts read the pre-observation state (old low, old availability, old
  // flags), so evaluate before the new history row and product update land.
  await evaluateAlerts(env, product, { price: r.price, availability, last });
  const changed = !last || Math.abs(last.price - r.price) > 0.009;
  const heartbeat = last && Date.now() - Date.parse(last.at) > 20 * 3600 * 1000;
  if (changed || heartbeat) {
    await env.DB.prepare('INSERT INTO price_history (product_id, price, mrp, at, source) VALUES (?, ?, ?, ?, ?)')
      .bind(product.id, r.price, mrp, now, source)
      .run();
  }
  await env.DB.prepare(
    `UPDATE products SET
       current_price = ?,
       mrp = COALESCE(?, mrp),
       currency = COALESCE(?, currency),
       title = CASE WHEN title IS NULL OR title = '' THEN COALESCE(?, title) ELSE title END,
       image = COALESCE(image, ?),
       rating = COALESCE(?, rating),
       review_count = COALESCE(?, review_count),
       model = COALESCE(model, ?),
       canonical_key = COALESCE(canonical_key, ?),
       availability = COALESCE(?, availability),
       last_checked = ?, last_status = 'ok', last_error = NULL
     WHERE id = ?`
  )
    .bind(
      r.price,
      mrp,
      r.currency ?? null,
      r.title ?? null,
      r.image ?? null,
      r.rating ?? null,
      r.reviewCount ?? null,
      r.model ?? null,
      canonicalKey(product.url),
      availability,
      now,
      product.id
    )
    .run();
}

// Delivery estimates only ever come from extension clicks: the user's browser
// session carries their pincode; server-side fetches see a locationless page.
async function saveDelivery(env, productId, d) {
  await env.DB.prepare(
    'UPDATE products SET delivery_text = ?, delivery_date = ?, delivery_pincode = ?, delivery_at = ? WHERE id = ?'
  )
    .bind(d.text, d.date, d.pincode, new Date().toISOString(), productId)
    .run();
}

async function checkProduct(env, product, source = 'cron') {
  const r = await extract(product.url, { currency: product.currency });
  if (r.ok) {
    await observe(env, product, r, source);
    return r;
  }
  await env.DB.prepare('UPDATE products SET last_checked = ?, last_status = ?, last_error = ? WHERE id = ?')
    .bind(new Date().toISOString(), r.blocked ? 'blocked' : 'error', r.error || 'check failed', product.id)
    .run();
  return r;
}

/* ---------- groups ---------- */

async function createGroup(env, b) {
  const ids = Array.isArray(b?.productIds)
    ? [...new Set(b.productIds.filter((x) => typeof x === 'string'))].slice(0, 20)
    : [];
  if (ids.length < 2) return json({ error: 'Pick at least two products to group.' }, 400);
  const marks = ids.map(() => '?').join(',');
  const found = (
    await env.DB.prepare(`SELECT id FROM products WHERE id IN (${marks})`).bind(...ids).all()
  ).results;
  if (found.length !== ids.length) return json({ error: 'One or more products were not found.' }, 404);

  const id = crypto.randomUUID();
  const name = cleanText(b.name, 120) ?? 'Group';
  await env.DB.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)')
    .bind(id, name, new Date().toISOString())
    .run();
  await env.DB.prepare(`UPDATE products SET group_id = ? WHERE id IN (${marks})`).bind(id, ...ids).run();
  await cleanupGroups(env); // moving members may have emptied another group
  return json({ group: { id, name } }, 201);
}

// Groups need >=2 active members to mean anything; dissolve the rest.
async function cleanupGroups(env) {
  await env.DB.prepare(
    `DELETE FROM groups WHERE id IN (
       SELECT g.id FROM groups g
       LEFT JOIN products p ON p.group_id = g.id AND p.archived = 0
       GROUP BY g.id HAVING COUNT(p.id) < 2)`
  ).run();
  await env.DB.prepare(
    'UPDATE products SET group_id = NULL WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM groups)'
  ).run();
}

/* ---------- cron sweep ---------- */

// Stalest-first batch. Effective per-product cadence: 2h * ceil(count / batch).
// Bot-blocked products are skipped for 24h at a time — the extension owns
// them (residential IP beats the bot wall); a daily server re-probe is enough
// to notice a store unblocking, without burning a batch slot every sweep on a
// guaranteed failure.
async function sweep(env) {
  const blockedCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM products WHERE archived = 0
         AND (last_status IS NULL OR last_status != 'blocked' OR last_checked IS NULL OR last_checked < ?)
       ORDER BY last_checked IS NOT NULL, last_checked ASC LIMIT ?`
    )
      .bind(blockedCutoff, batchSize(env))
      .all()
  ).results;
  const cutoff = Date.now() - 50 * 60 * 1000;
  for (const p of rows) {
    if (p.last_checked && Date.parse(p.last_checked) > cutoff) continue;
    await checkProduct(env, p, 'cron');
  }
}
