// Route tests against the real Worker + real D1 (isolated per test file).
// Everything goes through worker.fetch — the same code path production runs.
// All writes use extension-shaped payloads ({url, price, ...}) so no test
// ever fetches an external store.

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../../src/worker.js';

const call = (path, init) => worker.fetch(new Request('http://test.local' + path, init), env);
const getJson = async (path) => (await call(path)).json();
const post = (path, body) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (path, body) =>
  call(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (path) => call(path, { method: 'DELETE' });

let n = 0;
const freshUrl = () => `https://store.example/p/item-${Date.now()}-${n++}`;

async function addProduct(over = {}) {
  const res = await post('/api/products', {
    url: freshUrl(),
    price: 1000,
    currency: 'INR',
    title: 'Test product',
    source: 'extension',
    ...over,
  });
  const data = await res.json();
  return data.product;
}

const alertsFor = async (id) => (await getJson('/api/alerts')).alerts.filter((a) => a.productId === id);

describe('health', () => {
  it('reports ok with auth flags', async () => {
    const data = await getJson('/api/health');
    expect(data.ok).toBe(true);
    expect(data.authRequired).toBe(false);
    expect(data.readAuthRequired).toBe(false);
  });
});

describe('add / observe', () => {
  it('creates on first POST, observes on re-POST of the same URL', async () => {
    const url = freshUrl();
    const first = await post('/api/products', { url, price: 1000, currency: 'INR', source: 'extension' });
    expect(first.status).toBe(201);
    const created = (await first.json()).product;
    expect(created.currentPrice).toBe(1000);

    const second = await post('/api/products', { url, price: 900, currency: 'INR', source: 'extension' });
    const again = await second.json();
    expect(again.existing).toBe(true);
    expect(again.product.id).toBe(created.id);
    expect(again.product.currentPrice).toBe(900);
    expect(again.product.points.length).toBe(2);
  });

  it('dedupes by canonical key across URL variants', async () => {
    const a = await post('/api/products', {
      url: 'https://www.amazon.in/Some-Slug/dp/B0TESTKEY1?ref=x',
      price: 500,
      currency: 'INR',
      source: 'extension',
    });
    const created = (await a.json()).product;
    const b = await post('/api/products', {
      url: 'https://amazon.in/dp/b0testkey1',
      price: 480,
      currency: 'INR',
      source: 'extension',
    });
    const again = await b.json();
    expect(again.existing).toBe(true);
    expect(again.product.id).toBe(created.id);
  });

  it('observeOnly never creates a product', async () => {
    const before = (await getJson('/api/products')).products.length;
    const res = await post('/api/products', {
      url: freshUrl(),
      price: 777,
      currency: 'INR',
      source: 'extension',
      observeOnly: true,
    });
    const data = await res.json();
    expect(data.observed).toBe(false);
    expect(data.product).toBe(null);
    expect((await getJson('/api/products')).products.length).toBe(before);
  });

  it('observeOnly still updates an existing product', async () => {
    const p = await addProduct();
    await post('/api/products', {
      url: p.url,
      price: 950,
      currency: 'INR',
      source: 'extension',
      observeOnly: true,
    });
    const fresh = (await getJson(`/api/products/${p.id}`)).product;
    expect(fresh.currentPrice).toBe(950);
  });
});

describe('lookup', () => {
  it('matches by normalized URL', async () => {
    const p = await addProduct();
    const data = await getJson(`/api/products/lookup?url=${encodeURIComponent(p.url + '?utm_source=news')}`);
    expect(data.product?.id).toBe(p.id);
  });

  it('returns null for untracked URLs', async () => {
    const data = await getJson(`/api/products/lookup?url=${encodeURIComponent('https://other.example/x')}`);
    expect(data.product).toBe(null);
  });
});

describe('alerts', () => {
  it('fires a target alert once per crossing and re-arms above target', async () => {
    const p = await addProduct({ price: 1000 });
    await patch(`/api/products/${p.id}`, { targetPrice: 900 });

    await post('/api/products', { url: p.url, price: 850, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).filter((a) => a.type === 'target').length).toBe(1);

    // Still below target: hysteresis holds, no second alert.
    await post('/api/products', { url: p.url, price: 840, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).filter((a) => a.type === 'target').length).toBe(1);

    // Back above target re-arms; next crossing alerts again.
    await post('/api/products', { url: p.url, price: 950, currency: 'INR', source: 'extension' });
    await post('/api/products', { url: p.url, price: 880, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).filter((a) => a.type === 'target').length).toBe(2);
  });

  it('changing the target re-arms the alert', async () => {
    const p = await addProduct({ price: 1000 });
    await patch(`/api/products/${p.id}`, { targetPrice: 900 });
    await post('/api/products', { url: p.url, price: 850, currency: 'INR', source: 'extension' });
    await patch(`/api/products/${p.id}`, { targetPrice: 840 });
    await post('/api/products', { url: p.url, price: 830, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).filter((a) => a.type === 'target').length).toBe(2);
  });

  it('fires an all-time-low alert once there is enough history', async () => {
    const p = await addProduct({ price: 1000 });
    await post('/api/products', { url: p.url, price: 950, currency: 'INR', source: 'extension' });
    await post('/api/products', { url: p.url, price: 970, currency: 'INR', source: 'extension' });
    // 3 prior rows now; a new low must alert.
    await post('/api/products', { url: p.url, price: 900, currency: 'INR', source: 'extension' });
    const low = (await alertsFor(p.id)).filter((a) => a.type === 'low');
    expect(low.length).toBe(1);
    expect(low[0].price).toBe(900);
  });

  it('fires a drop alert vs ~24h ago and throttles repeats', async () => {
    const p = await addProduct({ price: 1000 });
    // Backdate the only history row so it reads as "a day ago".
    const dayAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await env.DB.prepare('UPDATE price_history SET at = ? WHERE product_id = ?').bind(dayAgo, p.id).run();

    await post('/api/products', { url: p.url, price: 800, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).filter((a) => a.type === 'drop').length).toBe(1);

    // 700 is a new low but low needs >=3 prior rows (has 2); drop is throttled.
    await post('/api/products', { url: p.url, price: 700, currency: 'INR', source: 'extension' });
    expect((await alertsFor(p.id)).length).toBe(1);
  });

  it('fires a restock alert on OutOfStock -> InStock', async () => {
    const p = await addProduct({ price: 1000, availability: 'OutOfStock' });
    expect((await getJson(`/api/products/${p.id}`)).product.availability).toBe('OutOfStock');
    await post('/api/products', {
      url: p.url,
      price: 1000,
      currency: 'INR',
      availability: 'InStock',
      source: 'extension',
    });
    const restock = (await alertsFor(p.id)).filter((a) => a.type === 'restock');
    expect(restock.length).toBe(1);
    expect((await getJson(`/api/products/${p.id}`)).product.availability).toBe('InStock');
  });
});

describe('history windowing', () => {
  it('list responses carry an anchor point before the 90d window; GET /:id has everything', async () => {
    const p = await addProduct({ price: 1200 });
    const old = new Date(Date.now() - 120 * 86400 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO price_history (product_id, price, at, source) VALUES (?, ?, ?, ?)')
      .bind(p.id, 1500, old, 'cron')
      .run();

    const listed = (await getJson('/api/products')).products.find((x) => x.id === p.id);
    expect(listed.points.length).toBe(2); // anchor (old) + in-window row
    expect(listed.points[0].t).toBe(old);
    expect(listed.points[0].p).toBe(1500);

    const full = (await getJson(`/api/products/${p.id}`)).product;
    expect(full.points.length).toBe(2);
  });
});

describe('archive', () => {
  it('archived products leave the default list and appear under ?archived=1', async () => {
    const p = await addProduct();
    await patch(`/api/products/${p.id}`, { archived: true });
    expect((await getJson('/api/products')).products.some((x) => x.id === p.id)).toBe(false);
    const archived = (await getJson('/api/products?archived=1')).products;
    expect(archived.some((x) => x.id === p.id && x.archived === true)).toBe(true);
    await patch(`/api/products/${p.id}`, { archived: false });
    expect((await getJson('/api/products')).products.some((x) => x.id === p.id)).toBe(true);
  });
});

describe('categories', () => {
  it('sets and clears the category', async () => {
    const p = await addProduct();
    await patch(`/api/products/${p.id}`, { category: 'Lenses' });
    expect((await getJson(`/api/products/${p.id}`)).product.category).toBe('Lenses');
    await patch(`/api/products/${p.id}`, { category: null });
    expect((await getJson(`/api/products/${p.id}`)).product.category).toBe(null);
  });
});

describe('groups', () => {
  it('creates, renames and dissolves a group', async () => {
    const a = await addProduct();
    const b = await addProduct();
    const created = await (await post('/api/groups', { name: 'Same lens', productIds: [a.id, b.id] })).json();
    expect(created.group.name).toBe('Same lens');

    await patch(`/api/groups/${created.group.id}`, { name: 'Renamed' });
    const listed = (await getJson('/api/products')).groups.find((g) => g.id === created.group.id);
    expect(listed.name).toBe('Renamed');

    await del(`/api/groups/${created.group.id}`);
    const after = await getJson('/api/products');
    expect(after.groups.some((g) => g.id === created.group.id)).toBe(false);
    expect(after.products.find((x) => x.id === a.id).groupId).toBe(null);
  });

  it('rejects groups of fewer than two products', async () => {
    const a = await addProduct();
    const res = await post('/api/groups', { productIds: [a.id] });
    expect(res.status).toBe(400);
  });
});

describe('delete', () => {
  it('bulk-delete removes products and their history', async () => {
    const a = await addProduct();
    const b = await addProduct();
    const res = await (await post('/api/products/bulk-delete', { ids: [a.id, b.id] })).json();
    expect(res.deleted).toBe(2);
    const hist = await env.DB.prepare('SELECT COUNT(*) AS n FROM price_history WHERE product_id IN (?, ?)')
      .bind(a.id, b.id)
      .first();
    expect(hist.n).toBe(0);
  });
});
