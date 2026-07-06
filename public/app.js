/* PriceWatch UI. Vanilla JS, no build step. */

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  data: null,
  sel: localStorage.getItem('pricewatch.sel') || null,
  chartMode: 'chart',
  checkingAll: false,
  selectMode: false,
  selected: new Set(),
  compare: null, // array of product ids, or null
  dismissed: new Set(JSON.parse(localStorage.getItem('pricewatch.dismissed') || '[]')),
};

const DAY = 86400_000;
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

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

function fmtCount(n) {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const dateDayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
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

const shortTitle = (t, n = 42) => {
  const s = String(t || '').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

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

// MRP is only meaningful above the price; the Worker enforces this too.
function mrpOf(p) {
  const price = currentPrice(p);
  return p.mrp != null && price != null && p.mrp > price ? p.mrp : null;
}

function discountPct(p) {
  const mrp = mrpOf(p);
  const price = currentPrice(p);
  if (mrp == null || price == null) return null;
  return Math.round((1 - price / mrp) * 100);
}

// True when the current price is the lowest ever tracked (needs some history
// so brand-new products don't all claim it).
function atTrackedLow(p) {
  const price = currentPrice(p);
  if (price == null || p.points.length < 3) return false;
  return price <= Math.min(...p.points.map((pt) => pt.p));
}

/* ---------- delivery ---------- */

function deliveryInfo(p) {
  if (!p.deliveryText && !p.deliveryDate) return null;
  const label = p.deliveryDate
    ? `by ${dateDayFmt.format(Date.parse(p.deliveryDate))}`
    : shortTitle(p.deliveryText, 30);
  const stale = p.deliveryAt && Date.now() - Date.parse(p.deliveryAt) > 72 * 3600_000;
  const full =
    (p.deliveryText || '') +
    (p.deliveryPincode ? ` · pincode ${p.deliveryPincode}` : '') +
    (p.deliveryAt ? ` · captured ${relTime(p.deliveryAt)} via extension` : '');
  return { label, stale, full };
}

/* ---------- grouping / similarity ---------- */

const groupsById = () => new Map((state.data.groups || []).map((g) => [g.id, g]));

// Entries the watch table renders: groups (>=2 members) and ungrouped singles,
// newest first. Members are sorted cheapest first.
function viewEntries() {
  const gmap = groupsById();
  const members = new Map();
  const singles = [];
  for (const p of state.data.products) {
    if (p.groupId && gmap.has(p.groupId)) {
      if (!members.has(p.groupId)) members.set(p.groupId, []);
      members.get(p.groupId).push(p);
    } else {
      singles.push(p);
    }
  }
  const entries = [];
  for (const [gid, mem] of members) {
    if (mem.length < 2) {
      singles.push(...mem);
      continue;
    }
    mem.sort((a, b) => (currentPrice(a) ?? Infinity) - (currentPrice(b) ?? Infinity));
    entries.push({
      type: 'group',
      g: gmap.get(gid),
      members: mem,
      key: Math.max(...mem.map((p) => Date.parse(p.createdAt || 0) || 0)),
    });
  }
  for (const p of singles) entries.push({ type: 'single', p, key: Date.parse(p.createdAt || 0) || 0 });
  entries.sort((a, b) => b.key - a.key);
  return entries;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'for', 'with', 'of', 'to', 'in', 'on', 'by', 'new']);

function titleTokens(t) {
  return new Set(
    String(t || '')
      .toLowerCase()
      .replace(/[–—]/g, '-')
      .replace(/[^a-z0-9.\-/ ]+/g, ' ')
      .split(/[\s/]+/)
      .map((s) => s.replace(/^[.-]+|[.-]+$/g, ''))
      .filter((w) => w.length > 1 && !STOP.has(w))
  );
}

// Token overlap, with a bonus for matching model-ish tokens ("70-300mm",
// "f4.5-6.3") — those identify a product far more than words do.
function simScore(a, b) {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  let modelHits = 0;
  for (const t of A) {
    if (B.has(t)) {
      inter++;
      if (/\d/.test(t)) modelHits++;
    }
  }
  return inter / (A.size + B.size - inter) + Math.min(modelHits, 4) * 0.06;
}

function computeSuggestions() {
  const un = state.data.products.filter((p) => !p.groupId && p.title);
  const out = [];
  for (let i = 0; i < un.length; i++) {
    for (let j = i + 1; j < un.length; j++) {
      const a = un[i];
      const b = un[j];
      const key = [a.id, b.id].sort().join('|');
      if (state.dismissed.has(key)) continue;
      let score = simScore(a.title, b.title);
      if (a.model && b.model && a.model.toLowerCase() === b.model.toLowerCase()) score = 1;
      if (score >= 0.55) out.push({ a, b, key, score });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 1);
}

// Longest common word-prefix of the titles makes a decent default group name.
function commonName(ps) {
  const titles = ps.map((p) => (p.title || '').trim()).filter(Boolean);
  if (!titles.length) return 'Group';
  const words = titles[0].split(/\s+/);
  let k = 0;
  outer: for (; k < words.length; k++) {
    const prefix = words.slice(0, k + 1).join(' ').toLowerCase();
    for (const t of titles) if (!t.toLowerCase().startsWith(prefix)) break outer;
  }
  const name = words.slice(0, k).join(' ').replace(/[\s\-–—:,|]+$/, '');
  return (name.length >= 8 ? name : titles[0]).slice(0, 80);
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
  state.data.groups = state.data.groups || [];
  const ids = new Set(state.data.products.map((p) => p.id));
  if (!ids.has(state.sel)) state.sel = state.data.products[0]?.id ?? null;
  if (state.compare) {
    state.compare = state.compare.filter((id) => ids.has(id));
    if (state.compare.length < 2) state.compare = null;
  }
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
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

function persistDismissed() {
  localStorage.setItem('pricewatch.dismissed', JSON.stringify([...state.dismissed]));
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

function ratingInline(p) {
  if (p.rating == null) return '';
  const count = p.reviewCount != null ? ` <span class="rc">(${fmtCount(p.reviewCount)})</span>` : '';
  return `<span class="rating-inline">${icon('star')}<span class="num">${p.rating.toFixed(1)}</span>${count}</span>`;
}

function deliveryInline(p) {
  const d = deliveryInfo(p);
  if (!d) return '';
  return `<span class="deliv-inline ${d.stale ? 'deliv-stale' : ''} hide-sm" title="${esc(d.full)}">${icon('truck')}${esc(d.label)}</span>`;
}

function priceCellHTML(p, best) {
  const price = currentPrice(p);
  const mrp = mrpOf(p);
  const off = discountPct(p);
  if (price == null) return '<span class="dim">—</span>';
  let sub = '';
  if (mrp != null) {
    sub = `<span class="price-sub"><span class="mrp-strike">${fmtMoney(mrp, p.currency)}</span>` +
      (off ? `<span class="pill pill-off">-${off}%</span>` : '') + '</span>';
  }
  return `<span class="price-wrap ${best ? 'price-best' : ''}">
    <span class="price-lg num">${fmtMoney(price, p.currency)}</span>${sub}
  </span>`;
}

function rowHTML(p, { inGroup = false, best = false } = {}) {
  const st = statusMeta(p);
  const checkCell = state.selectMode
    ? `<td class="col-select"><input type="checkbox" class="rowcheck" data-check="${p.id}" ${
        state.selected.has(p.id) ? 'checked' : ''
      } aria-label="Select ${esc(p.title || p.domain)}"></td>`
    : '';
  const metaBits = [
    `<span class="prod-domain">${esc(p.domain)}</span>`,
    ratingInline(p),
    deliveryInline(p),
    best ? `<span class="pill pill-best">best price</span>` : '',
    !inGroup && atTrackedLow(p) ? `<span class="pill pill-low">lowest yet</span>` : '',
  ].filter(Boolean);
  return `<tr data-id="${p.id}" class="${p.id === state.sel && !state.selectMode ? 'selected' : ''} ${inGroup ? 'in-group' : ''}"
              tabindex="0" role="button" aria-label="Show ${esc(p.title || p.domain)}">
    ${checkCell}
    <td>
      <div class="prod-cell">
        ${thumbHTML(p)}
        <div class="prod-main">
          <div class="prod-title">${esc(p.title || p.url)}</div>
          <div class="sub-meta">${metaBits.join('')}</div>
        </div>
      </div>
    </td>
    <td class="right">${priceCellHTML(p, best)}</td>
    <td class="right">${deltaHTML(delta30(p))}</td>
    <td class="col-spark">${sparklineSVG(p)}</td>
    <td class="col-check"><span class="check-cell"><span class="status-dot ${st.dot}"></span>${esc(st.label)}</span></td>
    <td class="right">${icon('chevron', 'chev')}</td>
  </tr>`;
}

function groupHeadHTML(g, members, colCount) {
  const priced = members.filter((p) => currentPrice(p) != null);
  const sameCur = new Set(priced.map((p) => p.currency)).size <= 1;
  let meta = `${members.length} stores`;
  if (priced.length && sameCur) {
    const best = priced[0]; // members arrive cheapest-first
    const worst = priced[priced.length - 1];
    meta += ` · best <strong>${fmtMoney(currentPrice(best), best.currency)}</strong> at ${esc(best.domain)}`;
    if (priced.length > 1 && currentPrice(worst) > currentPrice(best)) {
      meta += ` · you save ${fmtMoney(currentPrice(worst) - currentPrice(best), best.currency)} vs ${esc(worst.domain)}`;
    }
  }
  return `<tr class="group-head" data-gid="${g.id}" tabindex="0" role="button" aria-label="Compare ${esc(g.name)}">
    <td colspan="${colCount}">
      <div class="group-line">
        ${icon('layers')}
        <span class="group-name">${esc(g.name)}</span>
        <span class="group-meta">${meta}</span>
        <span class="group-actions">
          <button class="btn btn-icon" data-gact="compare" data-gid="${g.id}" title="Compare stores" aria-label="Compare stores">${icon('compare')}</button>
          <button class="btn btn-icon" data-gact="rename" data-gid="${g.id}" title="Rename group" aria-label="Rename group">${icon('pencil')}</button>
          <button class="btn btn-icon btn-danger-text" data-gact="ungroup" data-gid="${g.id}" title="Ungroup (keeps products)" aria-label="Ungroup">${icon('x')}</button>
        </span>
      </div>
    </td>
  </tr>`;
}

function suggestHTML() {
  if (state.selectMode) return '';
  const sug = computeSuggestions();
  if (!sug.length) return '';
  const s = sug[0];
  return `<div class="suggest" data-a="${s.a.id}" data-b="${s.b.id}" data-key="${esc(s.key)}">
    ${icon('layers')}
    <span class="sg-text">Same product on two stores? <strong>${esc(shortTitle(s.a.title))}</strong>
      <span class="dim">(${esc(s.a.domain)})</span> and <strong>${esc(shortTitle(s.b.title))}</strong>
      <span class="dim">(${esc(s.b.domain)})</span> look alike.</span>
    <span class="sg-actions">
      <button class="btn btn-sm btn-primary" data-sg="group">${icon('layers')}<span>Group & compare</span></button>
      <button class="btn btn-sm btn-ghost" data-sg="dismiss">Dismiss</button>
    </span>
  </div>`;
}

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
    renderSelectBar();
    return;
  }

  const colCount = state.selectMode ? 7 : 6;
  const entries = viewEntries();
  const body = entries
    .map((e) => {
      if (e.type === 'single') return rowHTML(e.p);
      const priced = e.members.filter((p) => currentPrice(p) != null);
      const sameCur = new Set(priced.map((p) => p.currency)).size <= 1;
      const bestId = sameCur && priced.length > 1 ? priced[0].id : null;
      return (
        groupHeadHTML(e.g, e.members, colCount) +
        e.members.map((p) => rowHTML(p, { inGroup: true, best: p.id === bestId })).join('')
      );
    })
    .join('');

  root.innerHTML = `<div class="card">
    <div class="card-head">
      <span class="eyebrow">Tracking · ${products.length} ${products.length === 1 ? 'product' : 'products'}</span>
      <button class="btn btn-sm btn-ghost" id="btn-select" type="button">
        ${state.selectMode ? icon('x') : icon('check')}<span>${state.selectMode ? 'Done selecting' : 'Select'}</span>
      </button>
    </div>
    ${suggestHTML()}
    <table class="watch-table">
      <thead><tr>
        ${state.selectMode ? '<th class="col-select"></th>' : ''}
        <th>Product</th><th class="right">Price</th><th class="right">Δ 30d</th>
        <th class="col-spark">Trend · 30d</th><th class="col-check">Status</th><th></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;

  $('#btn-select').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    render();
  });

  root.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const pick = () => {
      if (state.selectMode) {
        toggleSelected(id);
        return;
      }
      state.sel = id;
      state.compare = null;
      localStorage.setItem('pricewatch.sel', state.sel);
      render();
      $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
  });

  root.querySelectorAll('.rowcheck').forEach((cb) => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => toggleSelected(cb.dataset.check, cb.checked));
  });

  root.querySelectorAll('tr.group-head').forEach((tr) => {
    const open = () => {
      if (state.selectMode) return;
      openCompareForGroup(tr.dataset.gid);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  root.querySelectorAll('[data-gact]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const gid = btn.dataset.gid;
      const g = groupsById().get(gid);
      if (!g) return;
      if (btn.dataset.gact === 'compare') return openCompareForGroup(gid);
      if (btn.dataset.gact === 'rename') {
        const name = prompt('Group name:', g.name);
        if (!name || !name.trim()) return;
        try {
          await api(`/api/groups/${gid}`, 'PATCH', { name: name.trim() });
          await loadState();
        } catch (err) { toast(err.message); }
      }
      if (btn.dataset.gact === 'ungroup') {
        if (!confirm(`Ungroup "${g.name}"? The products stay tracked, just no longer grouped.`)) return;
        try {
          await api(`/api/groups/${gid}`, 'DELETE');
          state.compare = null;
          await loadState();
        } catch (err) { toast(err.message); }
      }
    });
  });

  const sg = $('.suggest', root);
  if (sg) {
    $('[data-sg="dismiss"]', sg).addEventListener('click', () => {
      state.dismissed.add(sg.dataset.key);
      persistDismissed();
      renderWatch();
    });
    $('[data-sg="group"]', sg).addEventListener('click', async () => {
      const ids = [sg.dataset.a, sg.dataset.b];
      const ps = ids.map((id) => state.data.products.find((p) => p.id === id)).filter(Boolean);
      await createGroupFromIds(ids, commonName(ps), { compareAfter: true });
    });
  }

  renderSelectBar();
}

function toggleSelected(id, force) {
  const on = force ?? !state.selected.has(id);
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  renderWatch();
}

/* ---------- selection bar ---------- */

function renderSelectBar() {
  let bar = $('#select-bar');
  if (!state.selectMode) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'select-bar';
    bar.className = 'select-bar';
    document.body.appendChild(bar);
  }
  const n = state.selected.size;
  const total = state.data.products.length;
  bar.innerHTML = `<span class="count">${n} selected</span>
    <span class="hint">2 to compare · 2+ to group</span>
    <button class="btn btn-sm btn-ghost" data-bar="all">${n === total ? 'Clear all' : 'Select all'}</button>
    <button class="btn btn-sm" data-bar="compare" ${n === 2 ? '' : 'disabled'}>${icon('compare')}<span>Compare</span></button>
    <button class="btn btn-sm" data-bar="group" ${n >= 2 ? '' : 'disabled'}>${icon('layers')}<span>Group</span></button>
    <button class="btn btn-sm btn-danger" data-bar="delete" ${n ? '' : 'disabled'}>${icon('trash')}<span>Delete</span></button>
    <button class="btn btn-sm btn-ghost" data-bar="cancel">Cancel</button>`;

  $('[data-bar="cancel"]', bar).addEventListener('click', () => {
    state.selectMode = false;
    state.selected.clear();
    render();
  });
  $('[data-bar="all"]', bar).addEventListener('click', () => {
    if (state.selected.size === total) state.selected.clear();
    else state.data.products.forEach((p) => state.selected.add(p.id));
    renderWatch();
  });
  $('[data-bar="delete"]', bar).addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) return;
    const names = ids
      .map((id) => state.data.products.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => shortTitle(p.title || p.url, 48));
    const preview = names.slice(0, 4).join('\n') + (names.length > 4 ? `\n…and ${names.length - 4} more` : '');
    if (!confirm(`Stop tracking ${ids.length} ${ids.length === 1 ? 'product' : 'products'} and delete their price history?\n\n${preview}`)) return;
    try {
      const r = await api('/api/products/bulk-delete', 'POST', { ids });
      state.selectMode = false;
      state.selected.clear();
      if (ids.includes(state.sel)) state.sel = null;
      state.compare = null;
      toast(`Deleted ${r.deleted} ${r.deleted === 1 ? 'product' : 'products'}.`);
      await loadState();
    } catch (err) {
      toast(err.message);
    }
  });
  $('[data-bar="compare"]', bar).addEventListener('click', () => {
    state.compare = [...state.selected];
    state.selectMode = false;
    state.selected.clear();
    render();
    $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('[data-bar="group"]', bar).addEventListener('click', async () => {
    const ids = [...state.selected];
    const ps = ids.map((id) => state.data.products.find((p) => p.id === id)).filter(Boolean);
    const name = prompt('Name this group:', commonName(ps));
    if (name == null) return;
    await createGroupFromIds(ids, name.trim() || commonName(ps), { compareAfter: true });
  });
}

async function createGroupFromIds(ids, name, { compareAfter = false } = {}) {
  try {
    await api('/api/groups', 'POST', { name, productIds: ids });
    state.selectMode = false;
    state.selected.clear();
    if (compareAfter) state.compare = ids;
    toast(`Grouped as "${name}".`);
    await loadState();
    if (compareAfter) $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(err.message);
  }
}

function openCompareForGroup(gid) {
  const members = state.data.products.filter((p) => p.groupId === gid);
  if (members.length < 2) return;
  state.compare = members.map((p) => p.id);
  render();
  $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- detail: tiles ---------- */

function renderTiles(p) {
  const price = currentPrice(p);
  const r90 = rangeStats(p, 90);
  const d30 = delta30(p);
  const atLow90 = price != null && r90 && price <= r90.min;
  const mrp = mrpOf(p);
  const off = discountPct(p);
  const d = deliveryInfo(p);

  const priceExtra =
    mrp != null
      ? `<span class="mrp-strike">${fmtMoney(mrp, p.currency)}</span>${off ? `<span class="pill pill-off">-${off}%</span>` : ''}`
      : '';

  return `<div class="tiles">
    <div class="tile"><div class="t-label">Current price</div>
      <div class="t-value num">${price != null ? fmtMoney(price, p.currency) : '—'}${priceExtra}</div>
      <div class="t-sub">${atTrackedLow(p) ? 'lowest tracked price' : esc(p.domain)}</div></div>
    <div class="tile"><div class="t-label">90-day low</div>
      <div class="t-value num">${r90 ? fmtMoney(r90.min, p.currency) : '—'}</div>
      <div class="t-sub">${atLow90 ? 'price is at its 90-day low' : '&nbsp;'}</div></div>
    <div class="tile"><div class="t-label">90-day high</div>
      <div class="t-value num">${r90 ? fmtMoney(r90.max, p.currency) : '—'}</div><div class="t-sub">&nbsp;</div></div>
    <div class="tile"><div class="t-label">Change · 30d</div>
      <div class="t-value">${deltaHTML(d30)}</div><div class="t-sub">&nbsp;</div></div>
    <div class="tile"><div class="t-label">Rating</div>
      <div class="t-value">${p.rating != null ? `${icon('star')}<span class="num">${p.rating.toFixed(1)}</span>` : '<span class="dim">—</span>'}</div>
      <div class="t-sub">${p.reviewCount != null ? `${Number(p.reviewCount).toLocaleString('en-IN')} ratings` : '&nbsp;'}</div></div>
    <div class="tile"><div class="t-label">Delivery</div>
      <div class="t-value" ${d ? `title="${esc(d.full)}"` : ''}>${d ? `${icon('truck')}<span>${esc(d.label)}</span>` : '<span class="dim">—</span>'}</div>
      <div class="t-sub">${
        d
          ? esc([p.deliveryPincode, relTime(p.deliveryAt)].filter(Boolean).join(' · ')) + (d.stale ? ' · re-click extension to refresh' : '')
          : 'captured when you click the extension on the page'
      }</div></div>
  </div>`;
}

/* ---------- charts (single + multi series) ---------- */

function chartPoints(points) {
  const now = Date.now();
  const start = now - 90 * DAY;
  const pts = [];
  const v0 = priceAt(points, start);
  if (v0 != null) pts.push({ t: start, p: v0 });
  for (const pt of points) {
    const t = Date.parse(pt.t);
    if (t >= start) pts.push({ t, p: pt.p });
  }
  if (pts.length) pts.push({ t: now, p: pts[pts.length - 1].p });
  return pts.length >= 2 ? pts : null;
}

// series: [{ label, color, currency, points }] — points are the raw API rows.
function drawChart(mount, seriesIn) {
  const series = seriesIn
    .map((s) => ({ ...s, pts: chartPoints(s.points) }))
    .filter((s) => s.pts);
  if (!series.length) {
    mount.innerHTML = `<div class="empty-inline">No price history yet — it builds up as checks run.</div>`;
    return;
  }

  const width = Math.max(320, mount.clientWidth);
  const H = 280;
  const M = { t: 14, r: 18, b: 28, l: 64 };
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const now = Date.now();
  const start = now - 90 * DAY;
  let min = Infinity, max = -Infinity;
  for (const s of series) for (const pt of s.pts) { min = Math.min(min, pt.p); max = Math.max(max, pt.p); }
  const pad = (max - min) * 0.06 || max * 0.02 || 1;
  min -= pad; max += pad;

  const x = (t) => M.l + ((t - start) / (now - start)) * iw;
  const y = (v) => M.t + (1 - (v - min) / (max - min)) * ih;
  const cur = series[0].currency;

  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const py = y(v);
    g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${py}" y2="${py}" stroke="var(--hairline)" stroke-width="1"/>`;
    g += `<text x="${M.l - 8}" y="${py + 4}" text-anchor="end" font-size="11" fill="var(--muted)" style="font-variant-numeric:tabular-nums">${fmtCompact(v, cur)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const t = start + ((now - start) * i) / 4;
    g += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${dateFmt.format(t)}</text>`;
  }
  g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${M.t + ih}" y2="${M.t + ih}" stroke="var(--baseline)" stroke-width="1"/>`;

  let defs = '';
  series.forEach((s, si) => {
    let d = '';
    s.pts.forEach((pt, i) => {
      const px = x(pt.t).toFixed(1), py = y(pt.p).toFixed(1);
      d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`; // step-after
    });
    if (series.length === 1) {
      // Soft area fill under a single line.
      defs = `<defs><linearGradient id="pw-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--series-1)" stop-opacity="0.16"/>
        <stop offset="1" stop-color="var(--series-1)" stop-opacity="0.01"/>
      </linearGradient></defs>`;
      const first = s.pts[0], lastPt = s.pts[s.pts.length - 1];
      g += `<path d="${d}L${x(lastPt.t).toFixed(1)} ${M.t + ih}L${x(first.t).toFixed(1)} ${M.t + ih}Z" fill="url(#pw-area)" stroke="none"/>`;
    }
    const last = s.pts[s.pts.length - 1];
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    g += `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
  });

  const legend =
    series.length > 1
      ? `<div class="legend">${series
          .map((s) => `<span class="lg-item"><span class="lg-dot" style="background:${s.color}"></span><span class="lg-label">${esc(s.label)}</span></span>`)
          .join('')}</div>`
      : '';

  mount.innerHTML = `${legend}<svg class="chart-svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img"
    aria-label="Price history, last 90 days">
    ${defs}
    ${g}
    <line id="xhair" y1="${M.t}" y2="${M.t + ih}" stroke="var(--baseline)" stroke-dasharray="3 3" visibility="hidden"/>
    <g id="hover-dots"></g>
    <rect id="hover-zone" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/>
  </svg>`;

  const svg = $('svg', mount);
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

    let dotHtml = '';
    let rows = '';
    for (const s of series) {
      const v = priceAt(s.points, clamped) ?? s.pts[0].p;
      if (v == null) continue;
      dotHtml += `<circle cx="${px}" cy="${y(v)}" r="4.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`;
      rows +=
        series.length === 1
          ? `<div class="tt-row"><span class="dim">Price</span><span class="num">${fmtMoney(v, s.currency)}</span></div>`
          : `<div class="tt-row"><span class="tt-name"><span class="lg-dot" style="background:${s.color}"></span><span>${esc(s.label)}</span></span><span class="num">${fmtMoney(v, s.currency)}</span></div>`;
    }
    dots.innerHTML = dotHtml;
    tip.innerHTML = `<div class="tt-date">${dateFmt.format(clamped)}</div>${rows}`;
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

/* ---------- compare view ---------- */

function renderCompare(root) {
  const ps = state.compare.map((id) => state.data.products.find((p) => p.id === id)).filter(Boolean);
  if (ps.length < 2) {
    state.compare = null;
    renderDetail();
    return;
  }
  const colors = ps.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]);
  const sameCur = new Set(ps.map((p) => p.currency)).size === 1;
  const gid = ps.every((p) => p.groupId && p.groupId === ps[0].groupId) ? ps[0].groupId : null;
  const gname = gid ? groupsById().get(gid)?.name : null;

  const prices = ps.map((p) => currentPrice(p));
  const bestOf = (vals, dir = 'min') => {
    const idx = vals
      .map((v, i) => [v, i])
      .filter(([v]) => v != null && isFinite(v))
      .sort((a, b) => (dir === 'min' ? a[0] - b[0] : b[0] - a[0]));
    return idx.length > 1 && idx[0][0] !== idx[1][0] ? idx[0][1] : idx.length === 1 ? idx[0][1] : -1;
  };

  const row = (label, cells, bestIdx = -1) =>
    `<tr><th class="cmp-metric">${label}</th>${cells
      .map((c, i) => `<td class="${i === bestIdx ? 'cmp-best-cell' : ''}">${c}</td>`)
      .join('')}</tr>`;

  const rows = [];
  rows.push(
    row(
      'Price now',
      ps.map((p, i) =>
        prices[i] != null
          ? `<span class="cmp-val">${fmtMoney(prices[i], p.currency)}</span>` +
            (sameCur && i === bestOf(prices) ? ` <span class="pill pill-best">best</span>` : '')
          : '<span class="dim">—</span>'
      ),
      sameCur ? bestOf(prices) : -1
    )
  );
  if (ps.some((p) => mrpOf(p) != null)) {
    rows.push(row('MRP', ps.map((p) => (mrpOf(p) != null ? `<span class="num">${fmtMoney(mrpOf(p), p.currency)}</span>` : '<span class="dim">—</span>'))));
    const offs = ps.map((p) => discountPct(p));
    rows.push(
      row(
        'Discount',
        offs.map((o) => (o != null ? `<span class="pill pill-off">-${o}%</span>` : '<span class="dim">—</span>')),
        bestOf(offs, 'max')
      )
    );
  }
  rows.push(row('Change · 30d', ps.map((p) => deltaHTML(delta30(p)))));
  const lows = ps.map((p) => rangeStats(p, 90)?.min ?? null);
  rows.push(
    row(
      '90-day low',
      ps.map((p, i) => (lows[i] != null ? `<span class="num">${fmtMoney(lows[i], p.currency)}</span>` : '<span class="dim">—</span>')),
      sameCur ? bestOf(lows) : -1
    )
  );
  rows.push(
    row('90-day high', ps.map((p) => {
      const hi = rangeStats(p, 90)?.max;
      return hi != null ? `<span class="num">${fmtMoney(hi, p.currency)}</span>` : '<span class="dim">—</span>';
    }))
  );
  if (ps.some((p) => p.rating != null)) {
    rows.push(
      row(
        'Rating',
        ps.map((p) => (p.rating != null ? ratingInline(p) : '<span class="dim">—</span>')),
        bestOf(ps.map((p) => p.rating), 'max')
      )
    );
  }
  if (ps.some((p) => deliveryInfo(p))) {
    const dts = ps.map((p) => (p.deliveryDate ? Date.parse(p.deliveryDate) : null));
    rows.push(
      row(
        'Delivery',
        ps.map((p) => {
          const d = deliveryInfo(p);
          return d
            ? `<span class="deliv-inline ${d.stale ? 'deliv-stale' : ''}" title="${esc(d.full)}">${icon('truck')}${esc(d.label)}</span>`
            : '<span class="dim">—</span>';
        }),
        bestOf(dts)
      )
    );
  }
  if (ps.some((p) => p.model)) {
    rows.push(row('Model', ps.map((p) => (p.model ? `<span class="num">${esc(p.model)}</span>` : '<span class="dim">—</span>'))));
  }
  rows.push(row('Checked', ps.map((p) => `<span class="dim">${esc(relTime(p.lastChecked) || 'never')}</span>`)));

  const headCells = ps
    .map(
      (p, i) => `<td>
        <div class="cmp-prod">
          <span class="cmp-dot" style="background:${colors[i]}"></span>
          ${thumbHTML(p)}
          <div>
            <div class="cmp-prod-name"><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.title || p.url)}</a></div>
            <div class="sub-meta"><span class="prod-domain">${esc(p.domain)}</span></div>
          </div>
        </div>
      </td>`
    )
    .join('');

  root.innerHTML = `<div class="card">
    <div class="detail-head">
      <div class="detail-id">
        ${icon('compare', 'icon brand-mark')}
        <div>
          <h2>${gname ? `${esc(gname)} — store comparison` : `Comparing ${ps.length} products`}</h2>
          <div class="detail-sub">${sameCur ? 'same currency, prices directly comparable' : 'different currencies — compare with care'}</div>
        </div>
      </div>
      <div class="detail-actions">
        ${gid ? `<button class="btn btn-icon" data-act="rename-group" title="Rename group" aria-label="Rename group">${icon('pencil')}</button>` : ''}
        <button class="btn btn-icon" data-act="close-compare" title="Close comparison" aria-label="Close comparison">${icon('x')}</button>
      </div>
    </div>
    <div class="chart-tools"><span class="eyebrow">Price history · 90d · overlaid</span></div>
    <div class="chart-wrap" id="cmp-chart"></div>
    <div class="cmp-scroll">
      <table class="cmp-table">
        <tbody>
          <tr><th class="cmp-metric">Product</th>${headCells}</tr>
          ${rows.join('')}
        </tbody>
      </table>
    </div>
  </div>`;

  drawChart(
    $('#cmp-chart', root),
    ps.map((p, i) => ({ label: `${p.domain}`, color: colors[i], currency: p.currency, points: p.points }))
  );

  $('[data-act="close-compare"]', root).addEventListener('click', () => {
    state.compare = null;
    render();
  });
  $('[data-act="rename-group"]', root)?.addEventListener('click', async () => {
    const g = groupsById().get(gid);
    const name = prompt('Group name:', g?.name || '');
    if (!name || !name.trim()) return;
    try {
      await api(`/api/groups/${gid}`, 'PATCH', { name: name.trim() });
      await loadState();
    } catch (err) { toast(err.message); }
  });
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
  if (state.compare) return renderCompare(root);

  const p = state.data.products.find((x) => x.id === state.sel);
  if (!p) { root.innerHTML = ''; return; }

  const hasPts = chartPoints(p.points);
  const gname = p.groupId ? groupsById().get(p.groupId)?.name : null;

  const toggle = `<div class="seg" role="group" aria-label="Chart or table view">
    <button type="button" data-mode="chart" aria-pressed="${state.chartMode === 'chart'}">Chart</button>
    <button type="button" data-mode="table" aria-pressed="${state.chartMode === 'table'}">Table</button>
  </div>`;

  let bodyHTML;
  if (!hasPts) {
    bodyHTML = `<div class="empty-inline">No price history yet — it builds up as checks run.</div>`;
  } else if (state.chartMode === 'table') {
    const anyMrp = p.points.some((pt) => pt.m != null);
    const rows = [...p.points].reverse().slice(0, 200).map((pt) =>
      `<tr><td class="num">${dateTimeFmt.format(Date.parse(pt.t))}</td><td class="right num">${fmtMoney(pt.p, p.currency)}</td>${
        anyMrp ? `<td class="right num">${pt.m != null ? fmtMoney(pt.m, p.currency) : '<span class="dim">—</span>'}</td>` : ''
      }</tr>`
    ).join('');
    bodyHTML = `<table class="points-table"><thead><tr><th>When</th><th class="right">Price</th>${anyMrp ? '<th class="right">MRP</th>' : ''}</tr></thead>
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
            ${p.model ? `<span>·</span><span title="Model number">${esc(p.model)}</span>` : ''}
            <span>·</span>
            ${statusLineHTML(p)}
            ${gname ? `<span class="group-chip" title="In group">${icon('layers')}${esc(gname)}
              <button type="button" data-act="leave-group" title="Remove from group" aria-label="Remove from group">${icon('x')}</button></span>` : ''}
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

  if (hasPts && state.chartMode === 'chart') {
    drawChart($('#chart-mount', root), [
      { label: p.domain, color: SERIES_COLORS[0], currency: p.currency, points: p.points },
    ]);
  }

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

  $('[data-act="leave-group"]', root)?.addEventListener('click', async () => {
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { groupId: null });
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

// Refresh = re-pull saved data only (picks up extension clicks and cron runs).
// Sync prices (above) is the one that re-scrapes stores.
$('#btn-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const svg = btn.querySelector('svg');
  btn.disabled = true;
  svg.classList.add('spin');
  try {
    await loadState();
    toast('Data refreshed.');
  } catch (err) {
    toast('Could not refresh: ' + err.message);
  } finally {
    btn.disabled = false;
    svg.classList.remove('spin');
  }
});

$('#btn-add').addEventListener('click', () => $('#dlg-add').showModal());
$('#btn-settings').addEventListener('click', () => {
  $('#form-settings [name="token"]').value = token();
  $('#dlg-settings').showModal();
});

document.querySelectorAll('dialog').forEach((dlg) =>
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close())));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.selectMode) {
    state.selectMode = false;
    state.selected.clear();
    render();
  } else if (state.compare) {
    state.compare = null;
    render();
  }
});

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
    state.compare = null;
    localStorage.setItem('pricewatch.sel', state.sel);
    toast(r.existing ? 'Already tracking that product — recorded a fresh look at it.' :
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
