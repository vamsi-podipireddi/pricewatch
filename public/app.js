/* PriceWatch UI. Vanilla JS, no build step. */

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  data: null,
  sel: localStorage.getItem('pricewatch.sel') || null,
  chartMode: 'chart',
  checkingAll: false,
};

const DAY = 86400_000;

/* ---------- formatting ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const moneyFmtCache = new Map();
function moneyFmt(currency) {
  if (!moneyFmtCache.has(currency)) {
    let fmt;
    try {
      fmt = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      });
    } catch {
      fmt = { format: (n) => `${currency} ${Math.round(n).toLocaleString()}` };
    }
    moneyFmtCache.set(currency, fmt);
  }
  return moneyFmtCache.get(currency);
}
const fmtMoney = (n, cur = 'INR') => moneyFmt(cur).format(Math.round(n));

function currencySymbol(cur) {
  try {
    const parts = new Intl.NumberFormat('en', { style: 'currency', currency: cur }).formatToParts(1);
    return parts.find((p) => p.type === 'currency')?.value ?? cur;
  } catch {
    return cur;
  }
}

function fmtCompact(n, cur = 'INR') {
  const sym = currencySymbol(cur);
  if (cur === 'INR') {
    if (n >= 1e5) return sym + (n / 1e5).toFixed(n >= 1e6 ? 1 : 2) + 'L';
    if (n >= 1e3) return sym + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return sym + Math.round(n);
  }
  if (n >= 1e6) return sym + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return sym + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return sym + Math.round(n);
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function relTime(iso) {
  if (!iso) return null;
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ---------- price math (step semantics: price holds until next point) ---------- */

function priceAt(points, t) {
  let value = null;
  for (const pt of points) {
    if (Date.parse(pt.t) <= t) value = pt.p;
    else break;
  }
  return value;
}

function currentPrice(p) {
  return p.currentPrice ?? priceAt(p.points, Date.now());
}

function delta30(p) {
  const now = currentPrice(p);
  const then = priceAt(p.points, Date.now() - 30 * DAY) ?? p.points[0]?.p ?? null;
  if (now == null || then == null || !then) return null;
  return (now - then) / then;
}

function rangeStats(p, days) {
  const start = Date.now() - days * DAY;
  const vals = [];
  const base = priceAt(p.points, start);
  if (base != null) vals.push(base);
  for (const pt of p.points) {
    if (Date.parse(pt.t) >= start) vals.push(pt.p);
  }
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

/* ---------- API ---------- */

const token = () => localStorage.getItem('pricewatch.token') || '';

async function api(path, method = 'GET', body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token()) headers['X-Auth-Token'] = token();
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    $('#dlg-settings').showModal();
    throw new Error('API token required — set it in Settings, then retry.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadState() {
  state.data = await api('/api/products');
  if (!state.data.products.find((p) => p.id === state.sel)) {
    state.sel = state.data.products[0]?.id ?? null;
  }
  render();
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---------- header ---------- */

function renderHeader() {
  const { products, meta } = state.data;
  const line = $('#sweep-line');
  const btn = $('#btn-check-all');
  btn.disabled = state.checkingAll || !products.length;
  btn.querySelector('svg').classList.toggle('spin', state.checkingAll);

  if (state.checkingAll) return; // progress text is managed by checkAll()

  const lastChecked = products.map((p) => p.lastChecked).filter(Boolean).sort().pop() ?? null;
  const cycleHours = products.length
    ? meta.sweepEveryHours * Math.ceil(products.length / meta.sweepBatch)
    : meta.sweepEveryHours;
  if (!products.length) line.textContent = 'Nothing tracked yet';
  else if (lastChecked) line.textContent = `Last check ${relTime(lastChecked)} · each product re-checked ~every ${cycleHours}h`;
  else line.textContent = 'First check pending';

  $('#foot-line').textContent =
    `A Cloudflare cron checks ${meta.sweepBatch} products every ${meta.sweepEveryHours} hours, stalest first. ` +
    'Sites that block server checks stay fresh through your extension clicks.';
}

/* ---------- sparkline ---------- */

function sparklineSVG(p) {
  const start = Date.now() - 30 * DAY;
  const samples = [];
  for (let i = 0; i <= 30; i++) {
    const t = start + i * DAY;
    const v = priceAt(p.points, t);
    if (v != null) samples.push({ t, v });
  }
  if (samples.length < 2) return '<span class="dim">—</span>';

  const W = 120, H = 28, P = 3;
  let min = Infinity, max = -Infinity;
  for (const s of samples) { min = Math.min(min, s.v); max = Math.max(max, s.v); }
  if (min === max) { min -= 1; max += 1; }
  const x = (t) => P + ((t - start) / (30 * DAY)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);

  let d = '';
  samples.forEach((s, i) => {
    const px = x(s.t).toFixed(1), py = y(s.v).toFixed(1);
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`; // step-after
  });
  const last = samples[samples.length - 1];
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.5" fill="var(--ink)"/>
  </svg>`;
}

function deltaHTML(d) {
  if (d == null || !isFinite(d)) return '<span class="dim">—</span>';
  const pct = Math.abs(d * 100).toFixed(1) + '%';
  if (d < -0.001) return `<span class="delta delta-down">${icon('down')}${pct}</span>`;
  if (d > 0.001) return `<span class="delta delta-up">${icon('up')}${pct}</span>`;
  return '<span class="dim delta">0.0%</span>';
}

/* ---------- status ---------- */

function statusMeta(p) {
  if (!p.lastChecked) return { dot: '', label: 'first check pending' };
  if (p.lastStatus === 'ok') return { dot: 'dot-ok', label: `checked ${relTime(p.lastChecked)}` };
  if (p.lastStatus === 'blocked') return { dot: 'dot-blocked', label: 'bot check — use extension' };
  return { dot: 'dot-error', label: 'check failed' };
}

const thumbHTML = (p, cls = '') =>
  p.image
    ? `<img class="thumb ${cls}" src="${esc(p.image)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=\\'thumb-ph ${cls}\\'><svg class=\\'icon\\'><use href=\\'#i-package\\'/></svg></span>'">`
    : `<span class="thumb-ph ${cls}">${icon('package')}</span>`;

/* ---------- watch table ---------- */

function renderWatch() {
  const root = $('#watch-section');
  const { products } = state.data;

  if (!products.length) {
    root.innerHTML = `<div class="card"><div class="empty">
      ${icon('tag')}
      <p><strong>Nothing tracked yet.</strong><br>
      Click the PriceWatch extension on any product page for one-click tracking,
      or paste a product URL here.</p>
      <button class="btn btn-primary" id="empty-add">${icon('plus')}<span>Track a product</span></button>
    </div></div>`;
    $('#empty-add')?.addEventListener('click', () => $('#dlg-add').showModal());
    return;
  }

  const rows = products.map((p) => {
    const price = currentPrice(p);
    const st = statusMeta(p);
    return `<tr data-id="${p.id}" class="${p.id === state.sel ? 'selected' : ''}" tabindex="0"
                role="button" aria-label="Show ${esc(p.title || p.domain)}">
      <td>
        <div class="prod-cell">
          ${thumbHTML(p)}
          <div class="prod-main">
            <div class="prod-title">${esc(p.title || p.url)}</div>
            <div class="prod-domain">${esc(p.domain)}</div>
          </div>
        </div>
      </td>
      <td class="right num price-lg">${price != null ? fmtMoney(price, p.currency) : '<span class="dim">—</span>'}</td>
      <td class="right">${deltaHTML(delta30(p))}</td>
      <td class="col-spark">${sparklineSVG(p)}</td>
      <td class="col-check"><span class="check-cell"><span class="status-dot ${st.dot}"></span>${esc(st.label)}</span></td>
      <td class="right">${icon('chevron', 'chev')}</td>
    </tr>`;
  }).join('');

  root.innerHTML = `<div class="card">
    <div class="card-head"><span class="eyebrow">Tracking · ${products.length} ${products.length === 1 ? 'product' : 'products'}</span></div>
    <table class="watch-table">
      <thead><tr>
        <th>Product</th><th class="right">Price</th><th class="right">Δ 30d</th>
        <th class="col-spark">Trend · 30d</th><th class="col-check">Status</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;

  root.querySelectorAll('tbody tr').forEach((tr) => {
    const pick = () => {
      state.sel = tr.dataset.id;
      localStorage.setItem('pricewatch.sel', state.sel);
      render();
      $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });
}

/* ---------- detail: tiles ---------- */

function renderTiles(p) {
  const price = currentPrice(p);
  const r90 = rangeStats(p, 90);
  const d30 = delta30(p);
  const atLow = price != null && r90 && price <= r90.min;

  return `<div class="tiles">
    <div class="tile"><div class="t-label">Current price</div>
      <div class="t-value num">${price != null ? fmtMoney(price, p.currency) : '—'}</div>
      <div class="t-sub">${esc(p.domain)}</div></div>
    <div class="tile"><div class="t-label">90-day low</div>
      <div class="t-value num">${r90 ? fmtMoney(r90.min, p.currency) : '—'}</div>
      <div class="t-sub">${atLow ? 'price is at its 90-day low' : '&nbsp;'}</div></div>
    <div class="tile"><div class="t-label">90-day high</div>
      <div class="t-value num">${r90 ? fmtMoney(r90.max, p.currency) : '—'}</div><div class="t-sub">&nbsp;</div></div>
    <div class="tile"><div class="t-label">Change · 30d</div>
      <div class="t-value">${deltaHTML(d30)}</div><div class="t-sub">&nbsp;</div></div>
  </div>`;
}

/* ---------- detail: chart ---------- */

function chartPoints(p) {
  const now = Date.now();
  const start = now - 90 * DAY;
  const pts = [];
  const v0 = priceAt(p.points, start);
  if (v0 != null) pts.push({ t: start, p: v0 });
  for (const pt of p.points) {
    const t = Date.parse(pt.t);
    if (t >= start) pts.push({ t, p: pt.p });
  }
  if (pts.length) pts.push({ t: now, p: pts[pts.length - 1].p });
  return pts.length >= 2 ? pts : null;
}

function drawChart(mount, p, pts) {
  const width = Math.max(320, mount.clientWidth);
  const H = 280;
  const M = { t: 14, r: 18, b: 28, l: 64 };
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const now = Date.now();
  const start = now - 90 * DAY;
  let min = Infinity, max = -Infinity;
  for (const pt of pts) { min = Math.min(min, pt.p); max = Math.max(max, pt.p); }
  const pad = (max - min) * 0.06 || max * 0.02 || 1;
  min -= pad; max += pad;

  const x = (t) => M.l + ((t - start) / (now - start)) * iw;
  const y = (v) => M.t + (1 - (v - min) / (max - min)) * ih;

  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const py = y(v);
    g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${py}" y2="${py}" stroke="var(--hairline)" stroke-width="1"/>`;
    g += `<text x="${M.l - 8}" y="${py + 4}" text-anchor="end" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${fmtCompact(v, p.currency)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const t = start + ((now - start) * i) / 4;
    g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${dateFmt.format(t)}</text>`;
  }
  g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${M.t + ih}" y2="${M.t + ih}" stroke="var(--baseline)" stroke-width="1"/>`;

  let d = '';
  pts.forEach((pt, i) => {
    const px = x(pt.t).toFixed(1), py = y(pt.p).toFixed(1);
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`; // step-after
  });
  const last = pts[pts.length - 1];
  g += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="3.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;

  mount.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img"
    aria-label="Price history, last 90 days">
    ${g}
    <line id="xhair" y1="${M.t}" y2="${M.t + ih}" stroke="var(--baseline)" stroke-dasharray="3 3" visibility="hidden"/>
    <g id="hover-dots"></g>
    <rect id="hover-zone" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/>
  </svg>`;

  const svg = mount.firstElementChild;
  const zone = $('#hover-zone', svg);
  const xhair = $('#xhair', svg);
  const dots = $('#hover-dots', svg);
  const tip = getTooltip();

  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const t = start + (((e.clientX - rect.left) / scale - M.l) / iw) * (now - start);
    const clamped = Math.max(start, Math.min(now, t));
    const px = x(clamped);
    xhair.setAttribute('x1', px);
    xhair.setAttribute('x2', px);
    xhair.setAttribute('visibility', 'visible');

    const v = priceAt(p.points, clamped) ?? pts[0].p;
    dots.innerHTML = v == null ? '' :
      `<circle cx="${px}" cy="${y(v)}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
    tip.innerHTML = `<div class="tt-date">${dateFmt.format(clamped)}</div>
      <div class="tt-row"><span class="dim">Price</span><span class="num">${v != null ? fmtMoney(v, p.currency) : '—'}</span></div>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    let left = e.clientX + 14;
    if (left + tw > window.innerWidth - 8) left = e.clientX - tw - 14;
    tip.style.left = left + 'px';
    tip.style.top = Math.min(e.clientY + 12, window.innerHeight - tip.offsetHeight - 8) + 'px';
  };
  const onLeave = () => {
    xhair.setAttribute('visibility', 'hidden');
    dots.innerHTML = '';
    tip.hidden = true;
  };
  zone.addEventListener('mousemove', onMove);
  zone.addEventListener('mouseleave', onLeave);
}

function getTooltip() {
  let tip = $('#chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'chart-tip';
    tip.className = 'tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

/* ---------- detail ---------- */

function statusLineHTML(p) {
  const st = statusMeta(p);
  if (p.lastStatus === 'blocked') {
    return `<span class="status-line status-blocked">${icon('alert')}bot check — click the extension on the page to record the price</span>`;
  }
  if (p.lastStatus === 'error') {
    return `<span class="status-line status-error">${icon('alert')}${esc(p.lastError || 'check failed')}</span>`;
  }
  return `<span class="status-line">${esc(st.label)}</span>`;
}

function renderDetail() {
  const root = $('#detail-section');
  const p = state.data.products.find((x) => x.id === state.sel);
  if (!p) { root.innerHTML = ''; return; }

  const pts = chartPoints(p);

  const toggle = `<div class="seg" role="group" aria-label="Chart or table view">
    <button type="button" data-mode="chart" aria-pressed="${state.chartMode === 'chart'}">Chart</button>
    <button type="button" data-mode="table" aria-pressed="${state.chartMode === 'table'}">Table</button>
  </div>`;

  let bodyHTML;
  if (!pts) {
    bodyHTML = `<div class="empty-inline">No price history yet — it builds up as checks run.</div>`;
  } else if (state.chartMode === 'table') {
    const rows = [...p.points].reverse().slice(0, 200).map((pt) =>
      `<tr><td class="num">${dateTimeFmt.format(Date.parse(pt.t))}</td><td class="right num">${fmtMoney(pt.p, p.currency)}</td></tr>`
    ).join('');
    bodyHTML = `<table class="points-table"><thead><tr><th>When</th><th class="right">Price</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } else {
    bodyHTML = `<div class="chart-wrap" id="chart-mount"></div>`;
  }

  root.innerHTML = `<div class="card">
    <div class="detail-head">
      <div class="detail-id">
        ${thumbHTML(p)}
        <div>
          <h2>${esc(p.title || p.url)}</h2>
          <div class="detail-sub">
            <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.domain)}</a>
            <span>·</span>
            ${statusLineHTML(p)}
          </div>
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-icon" data-act="rename" title="Rename" aria-label="Rename product">${icon('pencil')}</button>
        <button class="btn btn-icon" data-act="refresh" title="Check price now" aria-label="Check price now">${icon('refresh')}</button>
        <a class="btn btn-icon" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="Open product page" aria-label="Open product page">${icon('external')}</a>
        <button class="btn btn-icon" data-act="delete" title="Stop tracking" aria-label="Stop tracking">${icon('trash')}</button>
      </div>
    </div>
    ${renderTiles(p)}
    <div class="chart-tools"><span class="eyebrow">Price history · 90d</span>${toggle}</div>
    ${bodyHTML}
  </div>`;

  if (pts && state.chartMode === 'chart') drawChart($('#chart-mount', root), p, pts);

  root.querySelectorAll('.seg button').forEach((b) =>
    b.addEventListener('click', () => { state.chartMode = b.dataset.mode; renderDetail(); }));

  $('[data-act="rename"]', root).addEventListener('click', async () => {
    const name = prompt('Product name:', p.title || '');
    if (!name || !name.trim()) return;
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { title: name.trim() });
      await loadState();
    } catch (err) { toast(err.message); }
  });

  $('[data-act="refresh"]', root).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.querySelector('svg').classList.add('spin');
    try {
      const r = await api(`/api/products/${p.id}/refresh`, 'POST');
      toast(r.checked ? 'Price updated.' : 'Check failed — see status for details.');
      await loadState();
    } catch (err) { toast(err.message); render(); }
  });

  $('[data-act="delete"]', root).addEventListener('click', async () => {
    if (!confirm(`Stop tracking "${p.title || p.url}" and delete its history?`)) return;
    try {
      await api(`/api/products/${p.id}`, 'DELETE');
      state.sel = null;
      await loadState();
    } catch (err) { toast(err.message); }
  });
}

/* ---------- check all (client-driven, one Worker request per product) ---------- */

async function checkAll() {
  if (state.checkingAll) return;
  const products = [...state.data.products].sort((a, b) =>
    String(a.lastChecked || '').localeCompare(String(b.lastChecked || '')));
  if (!products.length) return;

  state.checkingAll = true;
  renderHeader();
  const line = $('#sweep-line');
  let done = 0, failed = 0;
  for (const p of products) {
    line.textContent = `Checking prices — ${done + 1} of ${products.length}`;
    try {
      const r = await api(`/api/products/${p.id}/refresh`, 'POST');
      if (!r.checked) failed++;
    } catch { failed++; }
    done++;
  }
  state.checkingAll = false;
  toast(failed ? `Done — ${failed} of ${products.length} checks failed (see status).` : 'All prices checked.');
  await loadState();
}

/* ---------- root render + global wiring ---------- */

function render() {
  renderHeader();
  renderWatch();
  renderDetail();
}

$('#btn-check-all').addEventListener('click', () => checkAll().catch((err) => toast(err.message)));

$('#btn-add').addEventListener('click', () => $('#dlg-add').showModal());
$('#btn-settings').addEventListener('click', () => {
  $('#form-settings [name="token"]').value = token();
  $('#dlg-settings').showModal();
});

document.querySelectorAll('dialog').forEach((dlg) =>
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close())));

$('#form-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const url = String(fd.get('url') || '').trim();
  const title = String(fd.get('title') || '').trim();
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    const r = await api('/api/products', 'POST', { url, title: title || undefined });
    $('#dlg-add').close();
    e.target.reset();
    state.sel = r.product.id;
    localStorage.setItem('pricewatch.sel', state.sel);
    toast(r.existing ? 'Already tracking that URL.' :
      r.product.lastStatus === 'ok' ? 'Tracking — first price recorded.' :
      'Tracking added — first check failed, the cron will retry (or click the extension on the page).');
    await loadState();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#form-settings').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = String(new FormData(e.target).get('token') || '').trim();
  if (t) localStorage.setItem('pricewatch.token', t);
  else localStorage.removeItem('pricewatch.token');
  $('#dlg-settings').close();
  toast('Saved.');
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderDetail, 150);
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

loadState().catch((err) => toast('Could not reach the server: ' + err.message));
