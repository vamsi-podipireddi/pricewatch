/* PriceWatch UI. Vanilla JS, no build step. */

const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  data: null,
  sel: localStorage.getItem('pricewatch.sel') || null,
  chartMode: 'chart',
  chartDays: 90, // 30 | 90 | 180 | 'all'
  checkingAll: false,
  selectMode: false,
  selected: new Set(),
  compare: null, // array of product ids, or null
  dismissed: new Set(JSON.parse(localStorage.getItem('pricewatch.dismissed') || '[]')),
  query: '',
  sort: 'newest', // newest | priceAsc | priceDesc | discount | drop
  listView: localStorage.getItem('pricewatch.listView') === 'cards' ? 'cards' : 'rows',
  limit: 12, // entries rendered before "Load more"; resets whenever the view changes
  catFilter: null, // category name, UNCAT, or null = all
  showArchived: false,
  fullPoints: new Map(), // product id -> full history (list responses are ~90d windows)
  alerts: [],
};

const DAY = 86400_000;
const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

// Signal palette. `accent` tracks the signal-colour preference, so inline SVG
// attributes (which can't read CSS vars reliably in every engine) stay in sync.
const C = {
  accent: '#5ce0a8',
  amber: '#efb65c',
  rose: '#f0837c',
  dim: '#6e737b',
  ink: '#ecedef',
};

/* ---------- appearance preferences ---------- */

// The three knobs the design exposes: which colour carries "good news", how
// tight the rows sit, and whether the page glows.
const ACCENTS = [
  ['#5ce0a8', 'Signal'],
  ['#8aa8ff', 'Cobalt'],
  ['#efb65c', 'Amber'],
  ['#e4e7ea', 'Mono'],
];
const DENSITIES = [['comfortable', 'Comfortable'], ['compact', 'Compact']];

const prefs = { accent: ACCENTS[0][0], density: 'comfortable', glow: true };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('pricewatch.prefs') || '{}'));
} catch {
  /* corrupt prefs fall back to the defaults above */
}
// Never trust storage: an unknown accent would leave every signal colourless.
if (!ACCENTS.some(([hex]) => hex === prefs.accent)) prefs.accent = ACCENTS[0][0];
if (!DENSITIES.some(([v]) => v === prefs.density)) prefs.density = 'comfortable';
prefs.glow = prefs.glow !== false;

function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--accent', prefs.accent);
  root.dataset.density = prefs.density;
  root.dataset.glow = prefs.glow ? 'on' : 'off';
  C.accent = prefs.accent;
}

function savePrefs() {
  localStorage.setItem('pricewatch.prefs', JSON.stringify(prefs));
  applyPrefs();
}

applyPrefs();

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

const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

// Alerts show wall-clock time when they landed today ("09:12" reads like an
// event), and fall back to a date once they are older than that.
function clockTime(iso) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  return t >= new Date().setHours(0, 0, 0, 0) ? timeFmt.format(t) : dateFmt.format(t);
}

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

// Deal meter: where today's price sits vs the last 90 days of daily samples.
// pct = share of sampled days the current price undercuts (or matches).
function dealMeta(p) {
  const price = currentPrice(p);
  if (price == null || !p.points || p.points.length < 3) return null;
  const start = Date.now() - 90 * DAY;
  let below = 0;
  let total = 0;
  for (let i = 0; i <= 90; i++) {
    const v = priceAt(p.points, start + i * DAY);
    if (v != null) {
      total++;
      if (price <= v + 0.009) below++;
    }
  }
  if (total < 7) return null; // too little history to judge
  const pct = Math.round((below / total) * 100);
  const label = pct >= 90 ? 'Excellent' : pct >= 70 ? 'Good' : pct >= 40 ? 'Fair' : 'High';
  // pos runs the other way: 0 = cheapest it has been, 100 = dearest. The deal
  // meter fills left-to-right, so it wants the position, not the score.
  const pos = 100 - pct;
  const color = pos < 25 ? C.accent : pos < 60 ? 'rgba(255,255,255,0.28)' : C.rose;
  const cls = pct >= 70 ? 'deal-good' : pct >= 40 ? 'deal-fair' : 'deal-high';
  return { pct, label, pos, color, cls };
}

// Low / typical / high of the last 90 days — the scale the deal meter sits on.
function bandStats(p) {
  const r = rangeStats(p, 90);
  if (!r) return null;
  const start = Date.now() - 90 * DAY;
  const vals = [];
  for (let i = 0; i <= 90; i++) {
    const v = priceAt(p.points, start + i * DAY);
    if (v != null) vals.push(v);
  }
  if (vals.length < 7) return null;
  vals.sort((a, b) => a - b);
  // n counts real observations, not the daily samples the median is taken from.
  const n = p.points.filter((pt) => Date.parse(pt.t) >= start).length;
  return { low: r.min, high: r.max, typical: vals[Math.floor(vals.length / 2)], n };
}

// One-line reading of where today's price sits. Near the low it quotes the gap
// to the low (actionable); through the middle of the band it reads against the
// typical price, because "31% above low" says nothing when low is an outlier.
function dealNote(p) {
  const price = currentPrice(p);
  const band = bandStats(p);
  if (price == null || !band) return 'building history';
  if (price <= band.low + 0.009) return 'at 90-day low';
  const over = Math.round(((price - band.low) / band.low) * 100);
  if (over < 1) return 'at 90-day low';
  const deal = dealMeta(p);
  if (deal && deal.pos >= 25 && deal.pos < 70) {
    const vsTypical = price / band.typical;
    if (vsTypical < 0.97) return 'below typical';
    if (vsTypical <= 1.03) return 'near typical';
    return 'above typical';
  }
  return `${over}% above low`;
}

// How long since this product was last this cheap. Walks back a day at a time
// and stops at the first day it cost the same or less; null once history runs
// out, so a two-week-old product can't claim a two-week record.
function cheapestInDays(p) {
  const price = currentPrice(p);
  if (price == null || !p.points || p.points.length < 3) return null;
  const first = Date.parse(p.points[0].t);
  const now = Date.now();
  const span = Math.floor((now - first) / DAY);
  if (span < 7) return null;
  for (let d = 1; d <= span; d++) {
    const v = priceAt(p.points, now - d * DAY);
    if (v == null || v <= price + 0.009) return d - 1;
  }
  return span; // never been this cheap in the whole tracked window
}

// The headline verdict beside the deal meter, in the design's own register.
function dealVerdict(p) {
  const days = cheapestInDays(p);
  if (days != null && days >= 7) return `cheapest in ${days} days`;
  return dealNote(p);
}

const targetHit = (p) => p.targetPrice != null && currentPrice(p) != null && currentPrice(p) <= p.targetPrice + 0.009;

// The mono flag that rides beside a product name. At most one, most urgent first.
function flagOf(p) {
  if (p.availability === 'OutOfStock') return { text: 'out of stock', cls: 'pill-oos' };
  if (atTrackedLow(p)) return { text: 'all-time low', cls: 'pill-low' };
  if (targetHit(p)) return { text: 'target hit', cls: 'pill-target' };
  return null;
}

// Did this product get cheaper in the last 24 hours?
function droppedToday(p) {
  const now = currentPrice(p);
  const then = priceAt(p.points, Date.now() - DAY);
  return now != null && then != null && now < then - 0.009;
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

/* ---------- categories ---------- */

const UNCAT = 'Uncategorized';

const catOf = (p) => (typeof p.category === 'string' && p.category.trim()) || null;

const allCategories = () =>
  [...new Set(state.data.products.map(catOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// Buckets view entries by category, preserving their order inside each bucket.
// A group entry sits under its first member's category. Case-insensitive merge,
// first-seen spelling wins. Uncategorized always sorts last.
function categorySections(entries) {
  const byKey = new Map(); // lower-case key -> { name, list }
  for (const e of entries) {
    const p = e.type === 'single' ? e.p : e.members[0];
    const name = catOf(p) || UNCAT;
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { name, list: [] });
    byKey.get(key).list.push(e);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.name === UNCAT) return 1;
    if (b.name === UNCAT) return -1;
    return a.name.localeCompare(b.name);
  });
}

// Free-text filter: every word must appear somewhere in title/domain/model/category.
function productMatches(p, q) {
  if (!q) return true;
  const hay = `${p.title || ''} ${p.domain} ${p.model || ''} ${catOf(p) || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

const SORTS = [
  ['newest', 'Newest first'],
  ['priceAsc', 'Price · low to high'],
  ['priceDesc', 'Price · high to low'],
  ['discount', 'Biggest discount'],
  ['drop', 'Biggest 30d drop'],
];

// Sort key for an entry (groups rank by their best/cheapest member).
function entryVal(e, mode) {
  const p = e.type === 'single' ? e.p : e.members[0];
  if (mode === 'priceAsc' || mode === 'priceDesc') return currentPrice(p);
  if (mode === 'discount') {
    const offs = (e.type === 'single' ? [e.p] : e.members).map((x) => discountPct(x)).filter((v) => v != null);
    return offs.length ? Math.max(...offs) : null;
  }
  if (mode === 'drop') {
    const ds = (e.type === 'single' ? [e.p] : e.members).map((x) => delta30(x)).filter((v) => v != null);
    return ds.length ? Math.min(...ds) : null;
  }
  return e.key;
}

// Entries the watch table renders: groups (>=2 members) and ungrouped singles.
// Search + category filter keep a group when ANY member matches; sort order
// follows state.sort (newest first by default). Members sort cheapest first.
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

  const q = state.query.trim();
  const cat = state.catFilter;
  const visible = entries.filter((e) => {
    const ps = e.type === 'single' ? [e.p] : e.members;
    const qOk = !q || ps.some((p) => productMatches(p, q));
    const catOk =
      !cat || ps.some((p) => (cat === UNCAT ? !catOf(p) : (catOf(p) || '').toLowerCase() === cat.toLowerCase()));
    return qOk && catOk;
  });

  const mode = state.sort;
  if (mode === 'newest') {
    visible.sort((a, b) => b.key - a.key);
  } else {
    const dir = mode === 'priceDesc' || mode === 'discount' ? -1 : 1;
    visible.sort((a, b) => {
      const va = entryVal(a, mode);
      const vb = entryVal(b, mode);
      if (va == null && vb == null) return b.key - a.key;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
    // A group is one entry but renders as several rows, so its members have to
    // follow the same direction — otherwise "price high to low" visibly steps
    // back up inside every group.
    if (mode === 'priceDesc') {
      for (const e of visible) if (e.type === 'group') e.members.reverse();
    }
  }
  return visible;
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
  state.data = await api('/api/products' + (state.showArchived ? '?archived=1' : ''));
  state.data.groups = state.data.groups || [];
  state.fullPoints.clear(); // fresh observations invalidate cached full histories
  try {
    state.alerts = (await api('/api/alerts')).alerts || [];
  } catch {
    state.alerts = []; // alerts table may not exist yet (migration pending)
  }
  const ids = new Set(state.data.products.map((p) => p.id));
  if (!ids.has(state.sel)) state.sel = state.data.products[0]?.id ?? null;
  if (state.compare) {
    state.compare = state.compare.filter((id) => ids.has(id));
    if (state.compare.length < 2) state.compare = null;
  }
  for (const id of [...state.selected]) if (!ids.has(id)) state.selected.delete(id);
  render();
}

// Full history on demand: list payloads window points to ~90d, so ranges
// beyond that pull GET /api/products/:id once per product and cache it.
async function ensureFullPoints(ids) {
  const missing = ids.filter((id) => !state.fullPoints.has(id));
  if (!missing.length) return false;
  await Promise.all(
    missing.map(async (id) => {
      try {
        const r = await api(`/api/products/${id}`);
        state.fullPoints.set(id, r.product?.points || []);
      } catch {
        state.fullPoints.set(id, null); // remember the failure; don't refetch-loop
      }
    })
  );
  return true;
}

const needsFullHistory = () => state.chartDays === 'all' || state.chartDays > (state.data?.meta?.pointsWindowDays ?? 90);

function pointsFor(p) {
  if (!needsFullHistory()) return p.points;
  const full = state.fullPoints.get(p.id);
  return full ?? p.points;
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

/* ---------- modal helpers (replace prompt/confirm) ---------- */

function pwInput({ title, label = 'Value', value = '', placeholder = '', hint = '', submit = 'Save', options = [] }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-input');
    $('#input-title').textContent = title;
    $('#input-label').textContent = label;
    const inp = $('#input-value');
    inp.value = value;
    inp.placeholder = placeholder;
    $('#input-list').innerHTML = options.map((o) => `<option value="${esc(o)}">`).join('');
    const hintEl = $('#input-hint');
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
    $('#input-submit').textContent = submit;
    let result = null; // stays null on Cancel / Escape
    const onSubmit = () => { result = inp.value; };
    $('#form-input').addEventListener('submit', onSubmit);
    dlg.addEventListener(
      'close',
      () => {
        $('#form-input').removeEventListener('submit', onSubmit);
        resolve(result);
      },
      { once: true }
    );
    dlg.showModal();
    inp.select();
  });
}

function pwConfirm({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const btn = $('#confirm-submit');
    btn.textContent = confirmLabel;
    btn.classList.toggle('btn-danger', danger);
    btn.classList.toggle('btn-primary', !danger);
    let result = false;
    const onSubmit = () => { result = true; };
    $('#form-confirm').addEventListener('submit', onSubmit);
    dlg.addEventListener(
      'close',
      () => {
        $('#form-confirm').removeEventListener('submit', onSubmit);
        resolve(result);
      },
      { once: true }
    );
    dlg.showModal();
  });
}

/* ---------- header ---------- */

// The cron fires on a fixed interval, so the next run is one interval past the
// most recent check. Returns null once that moment has passed.
function nextSweepIn(lastChecked, everyHours) {
  const interval = everyHours * 3600_000;
  const ms = Date.parse(lastChecked) + interval - Date.now();
  if (!isFinite(ms) || ms <= 0) return null;
  // A check stamped in the future (clock skew between the Worker and this
  // browser) must never project a wait longer than the interval itself.
  const mins = Math.round(Math.min(ms, interval) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

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

  let pulse = 'pulse-idle';
  let bits = ['nothing tracked yet'];
  if (products.length && lastChecked) {
    pulse = '';
    const next = nextSweepIn(lastChecked, meta.sweepEveryHours);
    bits = [
      `swept ${relTime(lastChecked)}`,
      next ? `next ${next}` : 'sweep due',
      `${products.length} tracked`,
    ];
    line.title = `Every product is re-checked about every ${cycleHours}h`;
  } else if (products.length) {
    pulse = 'pulse-warn';
    bits = ['first check pending', `${products.length} tracked`];
  }
  line.innerHTML =
    `<span class="pulse ${pulse}"></span>` +
    bits.map((b) => `<span>${esc(b.toUpperCase())}</span>`).join('<span class="sep">/</span>');

  qEl.placeholder = products.length ? `Search ${products.length} products` : 'Search';

  $('#foot-line').textContent =
    `A Cloudflare cron checks ${meta.sweepBatch} products every ${meta.sweepEveryHours} hours, stalest first. ` +
    'Sites that block server checks stay fresh through your extension clicks.';
}

/* ---------- today + movers ---------- */

// The strip above the list answers "what changed?" before the list answers
// "what am I watching?". Empty of news, it stays out of the way entirely.
function renderSummary() {
  const root = $('#summary-section');
  const products = state.data.products.filter((p) => currentPrice(p) != null);
  if (state.showArchived || products.length < 2) {
    root.innerHTML = '';
    return;
  }

  const drops = products.filter(droppedToday);
  const lows = products.filter(atTrackedLow);
  const oos = products.filter((p) => p.availability === 'OutOfStock');
  const midnight = new Date().setHours(0, 0, 0, 0);
  const alertsToday = state.alerts.filter((a) => Date.parse(a.at) >= midnight).length;

  const tags = [
    lows.length ? `<span class="tag tag-low">${lows.length} all-time low</span>` : '',
    alertsToday ? `<span class="tag tag-alert">${alertsToday} alert${alertsToday === 1 ? '' : 's'}</span>` : '',
    oos.length ? `<span class="tag tag-oos">${oos.length} out of stock</span>` : '',
  ].filter(Boolean);
  if (!tags.length) tags.push(`<span class="tag">${products.length} tracked</span>`);

  // Biggest 30-day movers, drops first — the ones worth a second look.
  const movers = products
    .map((p) => ({ p, d: delta30(p) }))
    .filter((m) => m.d != null && Math.abs(m.d) > 0.005)
    .sort((a, b) => a.d - b.d || Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 4);

  if (!drops.length && !movers.length) {
    root.innerHTML = '';
    return;
  }

  root.innerHTML = `<div class="summary">
    <div class="today">
      <div class="mono-label">Today</div>
      <div class="today-count">
        <span class="n ${drops.length ? '' : 'n-flat'}">${drops.length}</span>
        <span class="lbl">price drop${drops.length === 1 ? '' : 's'}</span>
      </div>
      <div class="today-tags">${tags.join('')}</div>
    </div>
    <div class="movers">${movers.map(moverHTML).join('')}</div>
  </div>`;

  root.querySelectorAll('.mover').forEach((el) =>
    el.addEventListener('click', () => selectProduct(el.dataset.id))
  );
}

const MOVER_TAGS = [
  [(p) => p.availability === 'OutOfStock', 'out of stock', 'var(--rose)'],
  [(p) => atTrackedLow(p), 'all-time low', 'var(--accent)'],
  [(p) => targetHit(p), 'target hit', 'var(--amber)'],
];

function moverHTML({ p, d }) {
  const deal = dealMeta(p);
  const tag = MOVER_TAGS.find(([test]) => test(p));
  const tagText = tag ? tag[1] : dealNote(p);
  const tagColor = tag ? tag[2] : deal && deal.pct >= 70 ? 'var(--accent)' : 'var(--dim-2)';
  return `<button class="mover" type="button" data-id="${p.id}">
    <span class="mover-id">
      ${thumbHTML(p)}
      <span style="min-width:0">
        <span class="mover-name">${esc(shortTitle(p.title || p.domain, 30))}</span>
        <span class="mover-store">${esc(p.domain)}</span>
      </span>
    </span>
    <span class="mover-figures">
      <span>
        <span class="mover-price">${fmtMoney(currentPrice(p), p.currency)}</span>
        <span class="mover-delta" style="color:${deltaColor(d)}">${deltaText(d)}</span>
      </span>
      ${sparklineSVG(p, 76, 30)}
    </span>
    <span class="mover-tag" style="color:${tagColor}">${esc(tagText.toUpperCase())}</span>
  </button>`;
}

function selectProduct(id) {
  if (!id) return;
  state.sel = id;
  state.compare = null;
  localStorage.setItem('pricewatch.sel', id);
  render();
  $('#detail-section').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- sparkline ---------- */

// Step-after sparkline, coloured by direction: green fell, rose rose. `area`
// fills underneath, which reads better at card size than a bare line.
function sparklineSVG(p, W = 76, H = 26, { area = false } = {}) {
  const start = Date.now() - 30 * DAY;
  const samples = [];
  for (let i = 0; i <= 30; i++) {
    const t = start + i * DAY;
    const v = priceAt(p.points, t);
    if (v != null) samples.push({ t, v });
  }
  if (samples.length < 2) return `<svg width="${W}" height="${H}" aria-hidden="true"></svg>`;

  const P = 3;
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
  const stroke = deltaColor(delta30(p));
  const fill = area
    ? `<path d="${d}V${H - P}H${x(samples[0].t).toFixed(1)}Z" fill="${stroke}" fill-opacity="0.1"/>`
    : '';
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" style="flex:none">
    ${fill}
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.2" fill="${stroke}"/>
  </svg>`;
}

const deltaColor = (d) => (d == null || !isFinite(d) ? C.dim : d < -0.001 ? C.accent : d > 0.001 ? C.rose : C.dim);

const deltaText = (d) => {
  if (d == null || !isFinite(d)) return '—';
  const pct = Math.abs(d * 100).toFixed(1) + '%';
  if (d < -0.001) return `▼ ${pct}`;
  if (d > 0.001) return `▲ ${pct}`;
  return '—';
};

function deltaHTML(d) {
  const cls = d == null || !isFinite(d) ? 'delta-flat' : d < -0.001 ? 'delta-down' : d > 0.001 ? 'delta-up' : 'delta-flat';
  return `<span class="delta ${cls}">${deltaText(d)}</span>`;
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

// Rows carry price and movement only. MRP, discount, rating and delivery all
// live in the detail panel — a scan column that says four things says none.
function priceCellHTML(p, best) {
  const price = currentPrice(p);
  if (price == null) return '<span class="dim">—</span>';
  return `<span class="price-wrap ${best ? 'price-best' : ''}">
    <span class="price-lg">${fmtMoney(price, p.currency)}</span>
    ${deltaHTML(delta30(p))}
  </span>`;
}

// Deal meter: a filled track where 0% is the cheapest this product has been in
// 90 days. The ticker is today; the note spells out what the bar is saying.
function meterHTML(p) {
  const deal = dealMeta(p);
  if (!deal) return `<div class="meter-note">${esc(dealNote(p))}</div>`;
  return `<div class="meter">
      <span class="fill" style="width:${deal.pos}%;background:${deal.color}"></span>
      <span class="tick" style="left:${deal.pos}%"></span>
    </div>
    <div class="meter-note">${esc(dealNote(p))}</div>`;
}

function targetCellHTML(p) {
  if (p.targetPrice == null) return '<span class="target-cell target-unset">not set</span>';
  const hit = targetHit(p);
  return `<span class="target-cell ${hit ? 'target-hit' : ''}">${fmtMoney(p.targetPrice, p.currency)}${hit ? ' ✓' : ''}</span>`;
}

function rowHTML(p, { inGroup = false, best = false } = {}) {
  const st = statusMeta(p);
  const flag = best ? { text: 'best price', cls: 'pill-best' } : flagOf(p);
  const checkCell = state.selectMode
    ? `<td class="col-select"><input type="checkbox" class="rowcheck" data-check="${p.id}" ${
        state.selected.has(p.id) ? 'checked' : ''
      } aria-label="Select ${esc(p.title || p.domain)}"></td>`
    : '';
  const metaBits = [`<span class="prod-domain">${esc(p.domain)}</span>`];
  return `<tr data-id="${p.id}" class="${p.id === state.sel && !state.selectMode ? 'selected' : ''} ${
    inGroup ? 'in-group' : ''
  } ${flag ? 'flagged' : ''}"
              tabindex="0" role="button" aria-label="Show ${esc(p.title || p.domain)}">
    ${checkCell}
    <td class="col-prod">
      <div class="prod-cell">
        ${thumbHTML(p)}
        <div class="prod-main">
          <div class="prod-title">${esc(p.title || p.url)}</div>
          <div class="sub-meta">${metaBits.join('')}</div>
        </div>
        ${flag ? `<span class="pill ${flag.cls}">${esc(flag.text)}</span>` : ''}
      </div>
    </td>
    <td class="col-deal">${meterHTML(p)}</td>
    <td class="col-spark">${sparklineSVG(p)}</td>
    <td class="right col-price">${priceCellHTML(p, best)}</td>
    <td class="right col-target">${targetCellHTML(p)}</td>
    <td class="right col-check"><span class="check-cell" title="${esc(st.label)}"><span>${esc(
      relTime(p.lastChecked) || 'never'
    )}</span><span class="status-dot ${st.dot}"></span></span></td>
  </tr>`;
}

// Card variant of the same row — same facts, art-led instead of scan-led.
function cardHTML(p) {
  const deal = dealMeta(p);
  const flag = flagOf(p);
  const price = currentPrice(p);
  return `<button class="prod-card ${p.id === state.sel ? 'selected' : ''}" type="button" data-id="${p.id}">
    <span class="pc-art">
      ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="thumb-ph">${icon('package')}</span>`}
      ${flag ? `<span class="pill ${flag.cls}">${esc(flag.text)}</span>` : ''}
      <span class="pc-store">${esc(p.domain)}</span>
    </span>
    <span class="pc-body">
      <span class="pc-name">${esc(shortTitle(p.title || p.url, 64))}</span>
      <span class="pc-figures">
        <span>
          <span class="pc-price">${price != null ? fmtMoney(price, p.currency) : '—'}</span>
          <span class="pc-delta" style="color:${deltaColor(delta30(p))}">${deltaText(delta30(p))}</span>
        </span>
        ${sparklineSVG(p, 92, 34, { area: true })}
      </span>
      <span>
        ${
          deal
            ? `<span class="meter"><span class="fill" style="width:${deal.pos}%;background:${deal.color}"></span><span class="tick" style="left:${deal.pos}%"></span></span>`
            : ''
        }
        <span class="pc-meter-note">
          <span>${esc(dealNote(p))}</span>
          <span class="${targetHit(p) ? 'target-hit' : p.targetPrice == null ? 'target-unset' : ''}">${
            p.targetPrice != null ? esc(fmtMoney(p.targetPrice, p.currency)) + (targetHit(p) ? ' ✓' : '') : 'no target'
          }</span>
        </span>
      </span>
    </span>
  </button>`;
}

function groupHeadHTML(g, members, colCount) {
  const priced = members.filter((p) => currentPrice(p) != null);
  const sameCur = new Set(priced.map((p) => p.currency)).size <= 1;
  let meta = `${members.length} stores`;
  if (priced.length && sameCur) {
    // Cheapest/dearest by value — member order follows the active sort.
    const byPrice = [...priced].sort((a, b) => currentPrice(a) - currentPrice(b));
    const best = byPrice[0];
    const worst = byPrice[byPrice.length - 1];
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

const PAGE = 12;
const resetPaging = () => { state.limit = PAGE; };

// A zero-result list should say which filters produced it — a search that
// returns nothing because a category chip is still active reads as a broken
// search otherwise.
function emptyMatchHTML() {
  const active = [
    state.query.trim() ? `search “${esc(state.query.trim())}”` : '',
    state.catFilter ? `category “${esc(state.catFilter)}”` : '',
  ].filter(Boolean);
  return `Nothing matches ${active.join(' and ')}.
    <button class="link-btn" type="button" id="btn-clear-filters">Clear ${active.length > 1 ? 'them' : 'it'}</button>`;
}

function wireArchivedToggle(root) {
  $('#btn-archived', root)?.addEventListener('click', async () => {
    state.showArchived = !state.showArchived;
    state.selectMode = false;
    state.selected.clear();
    state.compare = null;
    state.sel = null;
    resetPaging();
    try {
      await loadState();
    } catch (err) {
      toast(err.message);
    }
  });
}

function renderWatch() {
  const root = $('#watch-section');
  const { products } = state.data;

  if (!products.length) {
    root.innerHTML = state.showArchived
      ? `<div class="card">
          <div class="card-head">
            <span class="eyebrow">Archived · 0</span>
            <button class="btn btn-sm btn-ghost" id="btn-archived" type="button">${icon('archive')}<span>Back to tracking</span></button>
          </div>
          <div class="empty">${icon('archive')}<p>No archived products.</p></div>
        </div>`
      : `<div class="card"><div class="empty">
      ${icon('tag')}
      <p><strong>Nothing tracked yet.</strong><br>
      Click the PriceWatch extension on any product page for one-click tracking,
      or paste a product URL here.</p>
      <button class="btn btn-primary" id="empty-add">${icon('plus')}<span>Track a product</span></button>
    </div></div>`;
    $('#empty-add')?.addEventListener('click', () => $('#dlg-add').showModal());
    wireArchivedToggle(root);
    renderSelectBar();
    return;
  }

  const colCount = state.selectMode ? 7 : 6;
  const allEntries = viewEntries();
  const matched = allEntries.reduce((n, e) => n + (e.type === 'single' ? 1 : e.members.length), 0);
  // Long lists render a page at a time; a group counts as one entry so its
  // members never get split across the fold.
  const entries = allEntries.slice(0, state.limit);
  const shown = entries.reduce((n, e) => n + (e.type === 'single' ? 1 : e.members.length), 0);
  const more = allEntries.length - entries.length;
  const entryHTML = (e) => {
    if (e.type === 'single') return rowHTML(e.p);
    const priced = e.members.filter((p) => currentPrice(p) != null);
    const sameCur = new Set(priced.map((p) => p.currency)).size <= 1;
    // By value, not by position — member order follows the active sort.
    const cheapest = priced.reduce((lo, p) => (lo && currentPrice(lo) <= currentPrice(p) ? lo : p), null);
    const bestId = sameCur && priced.length > 1 ? cheapest.id : null;
    return (
      groupHeadHTML(e.g, e.members, colCount) +
      e.members.map((p) => rowHTML(p, { inGroup: true, best: p.id === bestId })).join('')
    );
  };
  // Category sections only appear once something is categorized — a fresh
  // install keeps the familiar flat list.
  // Category sections bucket the list alphabetically, which silently overrides
  // any ordering applied across the whole list — "price low to high" would only
  // hold *within* Audio, then restart inside Camera gear. So sections are for
  // browsing the default order only: pick a sort or type a search and the list
  // goes flat, globally ordered, the way the design shows it.
  const grouped = products.some(catOf) && state.sort === 'newest' && !state.query.trim();
  const body = !entries.length
    ? `<tr><td colspan="${colCount}"><div class="empty-inline">${emptyMatchHTML()}</div></td></tr>`
    : grouped
      ? categorySections(entries)
          .map(
            (sec) =>
              `<tr class="cat-head"><td colspan="${colCount}"><span class="cat-name">${esc(sec.name)}</span><span class="cat-count">${sec.list.length}</span></td></tr>` +
              sec.list.map(entryHTML).join('')
          )
          .join('')
      : entries.map(entryHTML).join('');

  const cats = allCategories();
  const catCount = (c) =>
    products.filter((p) => (c === UNCAT ? !catOf(p) : (catOf(p) || '').toLowerCase() === c.toLowerCase())).length;
  const chipDefs = cats.length
    ? [['', 'All', products.length], ...cats.map((c) => [c, c, catCount(c)]), [UNCAT, 'Uncategorized', catCount(UNCAT)]]
    : [];
  const chips = `<span class="chips">${chipDefs
    .filter(([v, , n]) => n > 0 || v === '')
    .map(
      ([v, l, n]) =>
        `<button class="chip" data-cat="${esc(v)}" aria-pressed="${(state.catFilter || '') === v}" type="button">${esc(
          l
        )}<span class="chip-n">${n}</span></button>`
    )
    .join('')}<button class="chip chip-archive" id="btn-archived" type="button" aria-pressed="${
    state.showArchived
  }">${state.showArchived ? 'Tracking' : 'Archive'}</button></span>`;

  const controls = `<div class="list-controls">
      ${chips}
      <span class="head-actions" style="margin-left:auto">
        <span class="mono-label">Sort</span>
        <select id="sort-sel" class="sort-sel" aria-label="Sort products">
          ${SORTS.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="seg" role="group" aria-label="List layout">
          <button type="button" data-view="rows" aria-pressed="${state.listView === 'rows'}">Rows</button>
          <button type="button" data-view="cards" aria-pressed="${state.listView === 'cards'}">Cards</button>
        </span>
      </span>
    </div>`;

  // Cards flatten groups — the grid has no room for a group header, and the
  // per-store comparison lives in the detail panel anyway.
  const flat = entries.flatMap((e) => (e.type === 'single' ? [e.p] : e.members));
  const grid = !flat.length
    ? `<div class="empty-inline">${emptyMatchHTML()}</div>`
    : `<div class="card-grid">${flat.map(cardHTML).join('')}</div>`;

  root.innerHTML = `<div class="card">
    <div class="card-head">
      <span class="eyebrow">${state.showArchived ? 'Archived' : 'Watching'} · ${
        shown === products.length ? products.length : `${shown} of ${products.length}`
      }</span>
      <span class="head-actions">
        <button class="btn btn-sm btn-ghost" id="btn-select" type="button">
          ${state.selectMode ? icon('x') : icon('check')}<span>${state.selectMode ? 'Done selecting' : 'Select'}</span>
        </button>
      </span>
    </div>
    ${controls}
    ${state.showArchived ? '' : suggestHTML()}
    ${
      state.listView === 'cards'
        ? grid
        : `<table class="watch-table">
      <thead><tr>
        ${state.selectMode ? '<th class="col-select"></th>' : ''}
        <th>Product</th><th class="col-deal">Deal vs 90 days</th><th class="col-spark">Trend</th>
        <th class="right col-price">Price</th><th class="right col-target">Target</th><th class="right col-check">Last check</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`
    }
    ${
      shown
        ? `<div class="list-foot">
            <span>Showing ${shown} of ${matched === products.length ? products.length : `${matched} matched`}</span>
            ${
              more
                ? `<button class="load-more" type="button" id="btn-more">Load more ↓</button>`
                : `<span>${esc(
                    state.query ? `Filtered by “${state.query}”` : SORTS.find(([v]) => v === state.sort)?.[1] || ''
                  )}</span>`
            }
          </div>`
        : ''
    }
  </div>`;

  wireArchivedToggle(root);
  $('#sort-sel', root).addEventListener('change', (e) => {
    state.sort = e.target.value;
    resetPaging();
    renderWatch();
  });
  root.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      state.listView = b.dataset.view;
      localStorage.setItem('pricewatch.listView', state.listView);
      resetPaging();
      renderWatch();
    })
  );
  root.querySelectorAll('.chip[data-cat]').forEach((ch) =>
    ch.addEventListener('click', () => {
      state.catFilter = ch.dataset.cat || null;
      resetPaging();
      renderWatch();
    })
  );
  $('#btn-more', root)?.addEventListener('click', () => {
    state.limit += PAGE;
    renderWatch();
  });
  $('#btn-clear-filters', root)?.addEventListener('click', () => {
    state.query = '';
    state.catFilter = null;
    qEl.value = '';
    resetPaging();
    renderWatch();
  });
  root.querySelectorAll('.prod-card').forEach((el) =>
    el.addEventListener('click', () => {
      if (state.selectMode) toggleSelected(el.dataset.id);
      else selectProduct(el.dataset.id);
    })
  );

  $('#btn-select').addEventListener('click', () => {
    state.selectMode = !state.selectMode;
    if (!state.selectMode) state.selected.clear();
    render();
  });

  root.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    const pick = () => {
      if (state.selectMode) toggleSelected(id);
      else selectProduct(id);
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
        const name = await pwInput({ title: 'Rename group', label: 'Group name', value: g.name, submit: 'Rename' });
        if (!name || !name.trim()) return;
        try {
          await api(`/api/groups/${gid}`, 'PATCH', { name: name.trim() });
          await loadState();
        } catch (err) { toast(err.message); }
      }
      if (btn.dataset.gact === 'ungroup') {
        const ok = await pwConfirm({
          title: 'Ungroup?',
          message: `"${g.name}" — the products stay tracked, just no longer grouped.`,
          confirmLabel: 'Ungroup',
          danger: true,
        });
        if (!ok) return;
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
    <button class="btn btn-sm" data-bar="category" ${n ? '' : 'disabled'}>${icon('tag')}<span>Category</span></button>
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
    const ok = await pwConfirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'product' : 'products'}?`,
      message: `Price history goes with them.\n\n${preview}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
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
  $('[data-bar="category"]', bar).addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) return;
    const cats = allCategories();
    const first = state.data.products.find((p) => p.id === ids[0]);
    const c = await pwInput({
      title: `Category for ${ids.length} ${ids.length === 1 ? 'product' : 'products'}`,
      label: 'Category',
      value: (first && catOf(first)) || '',
      placeholder: 'e.g. Shoes, Camera gear',
      hint: 'Leave blank to remove the category.',
      options: cats,
    });
    if (c == null) return;
    try {
      for (const id of ids) await api(`/api/products/${id}`, 'PATCH', { category: c.trim() || null });
      state.selectMode = false;
      state.selected.clear();
      toast(c.trim() ? `Moved ${ids.length} to "${c.trim()}".` : 'Category cleared.');
      await loadState();
    } catch (err) { toast(err.message); }
  });
  $('[data-bar="group"]', bar).addEventListener('click', async () => {
    const ids = [...state.selected];
    const ps = ids.map((id) => state.data.products.find((p) => p.id === id)).filter(Boolean);
    const name = await pwInput({ title: 'Group products', label: 'Group name', value: commonName(ps), submit: 'Group' });
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

// Headline: today's price at display size, the 30-day move beside it, and the
// deal meter showing where that price sits inside its own 90-day band.
function renderPriceHead(p) {
  const price = currentPrice(p);
  const mrp = mrpOf(p);
  const off = discountPct(p);
  const deal = dealMeta(p);
  const band = bandStats(p);
  const d30 = delta30(p);
  const cur = p.currency;
  // The design pairs the percentage with the cash it represents — "8.3%" is
  // abstract, "8.3% · ₹1,991" is the number you actually feel.
  const then = priceAt(p.points, Date.now() - 30 * DAY);
  const moved = price != null && then != null ? Math.abs(price - then) : null;

  const context = [
    mrp != null ? `<span class="mrp-strike">${fmtMoney(mrp, cur)}</span>` : '',
    off ? `<span class="pill pill-off">${off}% off</span>` : '',
    p.availability === 'OutOfStock' ? `<span class="pill pill-oos">out of stock</span>` : '',
    atTrackedLow(p) ? `<span class="pill pill-low">all-time low</span>` : '',
  ].filter(Boolean);

  const meter = band
    ? `<div class="meter-band"><span class="tick" style="left:${deal ? deal.pos : 50}%"></span></div>
       <div class="meter-scale">
         <span>${fmtMoney(band.low, cur)} <span class="u">low</span></span>
         <span><b>${fmtMoney(band.typical, cur)}</b> <span class="u">typical</span></span>
         <span>${fmtMoney(band.high, cur)} <span class="u">high</span></span>
       </div>`
    : `<div class="meter-note">The meter fills in once there is a week of history.</div>`;

  return `<div class="price-head">
    <div class="price-now">
      <div class="mono-label">Current</div>
      <div class="price-figure" style="margin-top:6px">
        <span class="big">${price != null ? fmtMoney(price, cur) : '—'}</span>
        ${
          d30 != null && isFinite(d30) && Math.abs(d30) > 0.001
            ? `<span class="move" style="color:${deltaColor(d30)}">${deltaText(d30)}${
                moved ? ` · ${fmtMoney(moved, cur)}` : ''
              } · 30d</span>`
            : ''
        }
      </div>
      ${context.length ? `<div class="price-context">${context.join('')}</div>` : ''}
    </div>
    <div class="deal-block">
      <div class="deal-head">
        <span class="mono-label">Deal meter · 90 days</span>
        <span class="deal-verdict ${deal ? deal.cls : ''}">${esc(deal ? dealVerdict(p) : 'no reading yet')}</span>
      </div>
      ${meter}
    </div>
  </div>`;
}

function renderTiles(p) {
  const price = currentPrice(p);
  const band = bandStats(p);
  const d = deliveryInfo(p);
  const target = p.targetPrice;

  // All-time low, and when it happened — a low from last May reads very
  // differently from one set this morning.
  let allLow = null;
  let lowAt = null;
  for (const pt of p.points) {
    if (allLow == null || pt.p < allLow) { allLow = pt.p; lowAt = pt.t; }
  }
  let lowSub = 'since tracking began';
  if (allLow != null && price != null) {
    const below = price > allLow ? Math.round(((price - allLow) / price) * 1000) / 10 : 0;
    lowSub = below
      ? `${dateFmt.format(Date.parse(lowAt))} · ${below}% below now`
      : 'today matches it';
  }

  let targetSub = 'alerts you when the price drops to it';
  if (target != null && price != null) {
    targetSub =
      price <= target
        ? 'hit — re-arms when it rises above'
        : `${fmtMoney(price - target, p.currency)} above target`;
  }

  return `<div class="tiles">
    <div class="tile tile-low"><div class="t-label">All-time low</div>
      <div class="t-value">${allLow != null ? fmtMoney(allLow, p.currency) : '—'}</div>
      <div class="t-sub">${esc(lowSub)}</div></div>
    <div class="tile"><div class="t-label">Typical · 90d</div>
      <div class="t-value">${band ? fmtMoney(band.typical, p.currency) : '—'}</div>
      <div class="t-sub">${
        band ? `median of ${band.n} observations` : 'needs a week of history'
      }</div></div>
    <div class="tile tile-target" data-act="target" role="button" tabindex="0" title="Set a target price — you get an alert when the price reaches it">
      <div class="t-label">Target</div>
      <div class="t-value">${icon('target')}${target != null ? fmtMoney(target, p.currency) : '<span class="dim">Set…</span>'}</div>
      <div class="t-sub">${targetSub}</div></div>
    <div class="tile"><div class="t-label">Delivery</div>
      <div class="t-value" ${d ? `title="${esc(d.full)}"` : ''}>${
        d ? `${icon('truck')}<span>${esc(d.label)}</span>` : '<span class="dim">—</span>'
      }</div>
      <div class="t-sub">${
        d
          ? esc([p.deliveryPincode, relTime(p.deliveryAt)].filter(Boolean).join(' · ')) + (d.stale ? ' · re-click extension' : '')
          : 'captured on extension clicks'
      }</div></div>
  </div>`;
}

/* ---------- charts (single + multi series) ---------- */

// Shared x-domain for all series. 'all' spans back to the earliest point
// anywhere (minimum 7 days so a day-old product doesn't zoom to noise).
function chartWindow(seriesIn, days) {
  const now = Date.now();
  if (days === 'all') {
    let first = Infinity;
    for (const s of seriesIn) for (const pt of s.points) first = Math.min(first, Date.parse(pt.t));
    return { start: Number.isFinite(first) ? Math.min(first, now - 7 * DAY) : now - 90 * DAY, now };
  }
  return { start: now - days * DAY, now };
}

// Last value at-or-before t for the given key ('p' price, 'm' MRP — MRP rows
// are sparse, the last known value holds).
function valueAt(points, t, key) {
  let v = null;
  for (const pt of points) {
    if (Date.parse(pt.t) > t) break;
    if (pt[key] != null) v = pt[key];
  }
  return v;
}

function chartPoints(points, start, now, key = 'p') {
  const pts = [];
  const v0 = valueAt(points, start, key);
  if (v0 != null) pts.push({ t: start, p: v0 });
  for (const pt of points) {
    const t = Date.parse(pt.t);
    if (t >= start && pt[key] != null) pts.push({ t, p: pt[key] });
  }
  if (pts.length) pts.push({ t: now, p: pts[pts.length - 1].p });
  return pts.length >= 2 ? pts : null;
}

const dateYearFmt = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' });

// series: [{ label, color, currency, points }] — points are the raw API rows.
// Single-series charts additionally draw the MRP as a dashed step line, a
// dashed "typical" (median) guide, and the target price in amber.
function drawChart(mount, seriesIn, days = 90, { target = null } = {}) {
  const { start, now } = chartWindow(seriesIn, days);
  const series = seriesIn
    .map((s) => ({ ...s, pts: chartPoints(s.points, start, now, 'p') }))
    .filter((s) => s.pts);
  if (!series.length) {
    mount.innerHTML = `<div class="empty-inline">No price history yet — it builds up as checks run.</div>`;
    return;
  }

  const width = Math.max(320, mount.clientWidth);
  const H = 286;
  // Value labels sit to the RIGHT of the plot, where the latest price is —
  // reading a chart you scan to the newest point, not back to the axis.
  const M = { t: 14, r: 68, b: 30, l: 2 };
  const iw = width - M.l - M.r;
  const ih = H - M.t - M.b;

  const single = series.length === 1;
  const mrpPts = single ? chartPoints(series[0].points, start, now, 'm') : null;

  let median = null;
  if (single) {
    const vals = [];
    for (let i = 0; i <= 60; i++) {
      const v = valueAt(series[0].points, start + ((now - start) * i) / 60, 'p');
      if (v != null) vals.push(v);
    }
    if (vals.length >= 7) {
      vals.sort((a, b) => a - b);
      median = vals[Math.floor(vals.length / 2)];
    }
  }

  let min = Infinity, max = -Infinity;
  for (const s of series) for (const pt of s.pts) { min = Math.min(min, pt.p); max = Math.max(max, pt.p); }
  if (mrpPts) for (const pt of mrpPts) { min = Math.min(min, pt.p); max = Math.max(max, pt.p); }
  if (median != null) { min = Math.min(min, median); max = Math.max(max, median); }
  if (target != null) { min = Math.min(min, target); max = Math.max(max, target); }
  const pad = (max - min) * 0.06 || max * 0.02 || 1;
  min -= pad; max += pad;

  const x = (t) => M.l + ((t - start) / (now - start)) * iw;
  const y = (v) => M.t + (1 - (v - min) / (max - min)) * ih;
  const cur = series[0].currency;
  const xFmt = now - start > 330 * DAY ? dateYearFmt : dateFmt;
  const LABEL = 'font-family="IBM Plex Mono, monospace" font-size="10.5" letter-spacing="0.06em"';

  const labelX = M.l + iw + 10; // gutter every guide label shares

  // All the right-hand labels compete for one narrow gutter. Named guides win
  // (they carry meaning a gridline does not); a value label within 11px of an
  // already-placed one is dropped rather than overprinted.
  const taken = [];
  const canPlace = (py) => taken.every((t) => Math.abs(t - py) >= 11);
  const claim = (py) => { taken.push(py); return py; };

  let guides = '';
  if (mrpPts) {
    const lastM = mrpPts[mrpPts.length - 1];
    guides += `<text x="${labelX}" y="${claim(y(lastM.p)) + 4}" ${LABEL} fill="#8a9099">MRP</text>`;
  }
  if (target != null && canPlace(y(target))) {
    guides += `<text x="${labelX}" y="${claim(y(target)) + 4}" ${LABEL} fill="${C.amber}">TARGET</text>`;
  }
  if (median != null && canPlace(y(median))) {
    guides += `<text x="${labelX}" y="${claim(y(median)) + 4}" ${LABEL} fill="#8a9099">TYPICAL</text>`;
  }

  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const py = y(v);
    g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${py}" y2="${py}" stroke="rgba(255,255,255,0.055)" stroke-width="1"/>`;
    if (canPlace(py)) g += `<text x="${labelX}" y="${claim(py) + 4}" ${LABEL} fill="#5a5f66">${fmtCompact(v, cur)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const t = start + ((now - start) * i) / 4;
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle';
    g += `<text x="${x(t)}" y="${H - 8}" text-anchor="${anchor}" ${LABEL} fill="#5a5f66">${xFmt
      .format(t)
      .toUpperCase()}</text>`;
  }

  if (median != null) {
    const py = y(median);
    g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${py}" y2="${py}" stroke="rgba(255,255,255,0.22)" stroke-dasharray="1 5" stroke-width="1"/>`;
  }
  if (target != null) {
    const py = y(target);
    g += `<line x1="${M.l}" x2="${M.l + iw}" y1="${py}" y2="${py}" stroke="${C.amber}" stroke-opacity="0.55" stroke-dasharray="5 4" stroke-width="1"/>`;
  }
  if (mrpPts) {
    let d = '';
    mrpPts.forEach((pt, i) => {
      const px = x(pt.t).toFixed(1), py = y(pt.p).toFixed(1);
      d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`;
    });
    g += `<path d="${d}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1" stroke-dasharray="1 5" stroke-linejoin="round"/>`;
  }
  g += guides;

  let defs = '';
  series.forEach((s) => {
    let d = '';
    s.pts.forEach((pt, i) => {
      const px = x(pt.t).toFixed(1), py = y(pt.p).toFixed(1);
      d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`; // step-after
    });
    if (series.length === 1) {
      // Soft area fill under a single line, plus a glow on the line itself —
      // the one place this design lets a stroke bloom.
      defs = `<defs><linearGradient id="pw-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${C.accent}" stop-opacity="0.28"/>
        <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
      </linearGradient></defs>`;
      const first = s.pts[0], lastPt = s.pts[s.pts.length - 1];
      g += `<path d="${d}L${x(lastPt.t).toFixed(1)} ${M.t + ih}L${x(first.t).toFixed(1)} ${M.t + ih}Z" fill="url(#pw-area)" stroke="none"/>`;
    }
    const last = s.pts[s.pts.length - 1];
    const glow = series.length === 1 ? ` style="filter:drop-shadow(0 0 9px rgba(92,224,168,0.4))"` : '';
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"${glow}/>`;
    g += `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="10" fill="${s.color}" fill-opacity="0.13"/>`;
    g += `<circle cx="${x(last.t).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="3.6" fill="${s.color}"/>`;
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
    <line id="xhair" y1="${M.t}" y2="${M.t + ih}" stroke="rgba(255,255,255,0.28)" stroke-dasharray="3 3" visibility="hidden"/>
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
      dotHtml += `<circle cx="${px}" cy="${y(v)}" r="4" fill="#0a0b0d" stroke="${s.color}" stroke-width="1.8"/>`;
      rows +=
        series.length === 1
          ? `<div class="tt-row"><span class="dim">Price</span><span class="num">${fmtMoney(v, s.currency)}</span></div>`
          : `<div class="tt-row"><span class="tt-name"><span class="lg-dot" style="background:${s.color}"></span><span>${esc(s.label)}</span></span><span class="num">${fmtMoney(v, s.currency)}</span></div>`;
    }
    if (mrpPts) {
      const mv = valueAt(series[0].points, clamped, 'm');
      if (mv != null) rows += `<div class="tt-row"><span class="dim">MRP</span><span class="num dim">${fmtMoney(mv, series[0].currency)}</span></div>`;
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

/* ---------- chart range control ---------- */

const rangeLabel = () => (state.chartDays === 'all' ? 'all time' : `${state.chartDays}d`);

function rangeSegHTML() {
  const opts = [[30, '30d'], [90, '90d'], [180, '180d'], ['all', 'All']];
  return `<div class="seg seg-range" role="group" aria-label="Chart range">${opts
    .map(([v, l]) => `<button type="button" data-range="${v}" aria-pressed="${String(state.chartDays) === String(v)}">${l}</button>`)
    .join('')}</div>`;
}

function wireRangeSeg(root, rerender) {
  root.querySelectorAll('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.range;
      state.chartDays = v === 'all' ? 'all' : Number(v);
      rerender();
    })
  );
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
    <div class="chart-tools"><span class="eyebrow">Price history · ${rangeLabel()} · overlaid</span>${rangeSegHTML()}</div>
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
    ps.map((p, i) => ({ label: `${p.domain}`, color: colors[i], currency: p.currency, points: pointsFor(p) })),
    state.chartDays
  );
  wireRangeSeg(root, () => renderCompare(root));
  if (needsFullHistory()) {
    ensureFullPoints(ps.map((p) => p.id)).then((fetched) => {
      if (fetched && state.compare) renderCompare($('#detail-section'));
    });
  }

  $('[data-act="close-compare"]', root).addEventListener('click', () => {
    state.compare = null;
    render();
  });
  $('[data-act="rename-group"]', root)?.addEventListener('click', async () => {
    const g = groupsById().get(gid);
    const name = await pwInput({ title: 'Rename group', label: 'Group name', value: g?.name || '', submit: 'Rename' });
    if (!name || !name.trim()) return;
    try {
      await api(`/api/groups/${gid}`, 'PATCH', { name: name.trim() });
      await loadState();
    } catch (err) { toast(err.message); }
  });
}

/* ---------- sidebar panels ---------- */

const unseenAlerts = () => {
  const seen = localStorage.getItem('pricewatch.alertsSeen') || '';
  return state.alerts.filter((a) => a.at > seen).length;
};

// Standing alerts feed. The bell dialog holds the full history; this shows the
// three most recent so a drop you have not looked at yet is never a click away.
function alertsCardHTML() {
  if (!state.alerts.length) return '';
  const unseen = unseenAlerts();
  const rows = state.alerts.slice(0, 3).map((a) => {
    const line = (a.message || '').split('\n')[1] || (a.message || '').split('\n')[0] || '';
    const img = a.image
      ? `<img class="thumb" src="${esc(a.image)}" alt="" loading="lazy">`
      : `<span class="thumb-ph">${icon('package')}</span>`;
    return `<div class="alert-row" data-pid="${esc(a.productId)}" role="button" tabindex="0">
      ${img}
      <div class="alert-main">
        <div class="alert-title">${esc(shortTitle(a.title || a.url || 'Product', 44))}</div>
        <div class="alert-msg">${esc(line)}</div>
      </div>
      <div class="alert-side">
        <span class="alert-type alert-${esc(a.type)}">${esc(a.type)}</span>
        <div class="alert-meta" title="${esc(relTime(a.at) || '')}">${esc(clockTime(a.at))}</div>
      </div>
    </div>`;
  });
  const delivered = state.alerts.slice(0, 3).some((a) => a.delivered);
  return `<div class="card card-alerts">
    <div class="panel-head">
      <span class="mono-label label-alert">Alerts${unseen ? ` · ${unseen} new` : ''}</span>
      <span class="panel-note">${
        delivered ? `${icon('check', 'icon')}emailed` : state.data?.meta?.email ? 'email armed' : 'in-app only'
      }</span>
    </div>
    ${rows.join('')}
    <button class="panel-foot" type="button" data-act="all-alerts">All ${state.alerts.length} alerts</button>
  </div>`;
}

function wireAlertsCard(root) {
  root.querySelectorAll('.card-alerts .alert-row').forEach((row) => {
    const go = () => {
      const pid = row.dataset.pid;
      if (state.data.products.some((p) => p.id === pid)) selectProduct(pid);
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
  $('[data-act="all-alerts"]', root)?.addEventListener('click', openAlerts);
}

// Store comparison for a grouped product: every store carrying it, cheapest
// first, with what each one costs you over the best price.
function storesCardHTML(p) {
  if (!p.groupId) return '';
  const g = groupsById().get(p.groupId);
  const members = state.data.products
    .filter((x) => x.groupId === p.groupId && currentPrice(x) != null)
    .sort((a, b) => currentPrice(a) - currentPrice(b));
  if (!g || members.length < 2) return '';
  const sameCur = new Set(members.map((m) => m.currency)).size === 1;
  const best = currentPrice(members[0]);
  const rows = members.map((m, i) => {
    const price = currentPrice(m);
    const over = price - best;
    const note = !sameCur ? '' : i === 0 ? 'best' : `+${fmtMoney(over, m.currency)}`;
    return `<div class="store-row ${m.id === p.id ? 'store-current' : ''}" data-id="${m.id}" role="button" tabindex="0">
      <span class="store-dot" style="background:${SERIES_COLORS[i % SERIES_COLORS.length]}"></span>
      <span class="store-name">${esc(m.domain)}</span>
      <span class="store-price ${sameCur && i === 0 ? 'is-best' : ''}">${fmtMoney(price, m.currency)}</span>
      <span class="store-note">${esc(note)}</span>
    </div>`;
  });
  return `<div class="card card-stores">
    <div class="panel-head">
      <span class="mono-label">${icon('layers', 'icon')}Same product · ${members.length} stores</span>
      <button class="btn btn-sm" type="button" data-act="compare-group">Compare</button>
    </div>
    ${rows.join('')}
  </div>`;
}

// Everything about the listing that is not a price.
function specsCardHTML(p) {
  const avail =
    p.availability === 'OutOfStock'
      ? ['Out of stock', 'var(--rose)']
      : p.availability === 'InStock'
        ? ['In stock', 'var(--accent)']
        : ['Not reported', 'var(--dim-2)'];
  // Where the latest price actually came from: bot-walled stores are kept
  // fresh by extension clicks, everything else by the server sweep.
  const when = relTime(p.lastChecked);
  const source = !p.lastChecked
    ? ['Not checked yet', 'var(--faint-2)']
    : p.lastStatus === 'blocked'
      ? [`Extension · ${when}`, 'var(--amber)']
      : p.lastStatus === 'error'
        ? [`Check failed · ${when}`, 'var(--rose)']
        : [`Server check · ${when}`, ''];
  const specs = [
    ['Model number', p.model || 'not detected', p.model ? '' : 'var(--faint-2)'],
    ['Availability', avail[0], avail[1]],
    ['Observations', `${p.points.length} in 90 days`, ''],
    ['Source', source[0], source[1]],
    ['Category', catOf(p) || 'none', catOf(p) ? '' : 'var(--faint-2)'],
  ];
  return `<div class="card card-specs">
    <div class="panel-head"><span class="mono-label">Details</span></div>
    <div class="spec-list">
      ${specs
        .map(
          ([k, v, color]) =>
            `<div class="spec-row"><span class="spec-k">${k}</span><span class="spec-v"${
              color ? ` style="color:${color}"` : ''
            }>${esc(v)}</span></div>`
        )
        .join('')}
      <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">
        Open on ${esc(p.domain)}${icon('external')}
      </a>
    </div>
  </div>`;
}

// Narrow screens lose the four-across tiles, so the target — the one tile you
// act on — gets its own callout under them, as in the mobile design.
function targetCalloutHTML(p) {
  const price = currentPrice(p);
  const t = p.targetPrice;
  const hit = targetHit(p);
  const line = t == null
    ? 'No target set'
    : hit
      ? `Target ${fmtMoney(t, p.currency)} — hit`
      : `Target ${fmtMoney(t, p.currency)} — ${price != null ? `${fmtMoney(price - t, p.currency)} to go` : 'waiting'}`;
  const sub = t == null ? 'Tap to set one' : hit ? 'Re-arms when it rises above · tap to edit' : 'Tap to edit';
  return `<button class="target-callout ${hit ? 'is-hit' : ''}" type="button" data-act="target">
    ${icon('target')}
    <span class="tc-main"><span class="tc-line">${esc(line)}</span><span class="tc-sub">${esc(sub)}</span></span>
  </button>`;
}

/* ---------- detail ---------- */

// The right-hand column: what needs attention, where else it is sold, and
// everything about the listing that is not a price.
function renderSide() {
  const root = $('#side-section');
  const p = state.compare ? null : state.data.products.find((x) => x.id === state.sel);
  root.innerHTML = alertsCardHTML() + (p ? storesCardHTML(p) + specsCardHTML(p) : '');

  wireAlertsCard(root);
  if (p) {
    $('[data-act="compare-group"]', root)?.addEventListener('click', () => openCompareForGroup(p.groupId));
    root.querySelectorAll('.store-row').forEach((row) => {
      const go = () => selectProduct(row.dataset.id);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }
}

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

  const pts = pointsFor(p);
  const win = chartWindow([{ points: pts }], state.chartDays);
  const hasPts = chartPoints(pts, win.start, win.now, 'p');
  const gname = p.groupId ? groupsById().get(p.groupId)?.name : null;

  const toggle = `<div class="seg" role="group" aria-label="Chart or table view">
    <button type="button" data-mode="chart" aria-pressed="${state.chartMode === 'chart'}">Chart</button>
    <button type="button" data-mode="table" aria-pressed="${state.chartMode === 'table'}">Table</button>
  </div>`;

  let bodyHTML;
  if (!hasPts) {
    bodyHTML = `<div class="empty-inline">No price history yet — it builds up as checks run.</div>`;
  } else if (state.chartMode === 'table') {
    const anyMrp = pts.some((pt) => pt.m != null);
    const rows = [...pts].reverse().slice(0, 200).map((pt) =>
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
        <div class="detail-meta">
          <h2>${esc(p.title || p.url)}</h2>
          <div class="detail-sub">
            <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.domain)}</a>
            ${p.model ? `<span class="sep">/</span><span title="Model number">${esc(p.model)}</span>` : ''}
            ${p.rating != null ? `<span class="sep">/</span>${ratingInline(p)}` : ''}
            ${
              p.availability
                ? `<span class="sep">/</span><span class="${
                    p.availability === 'OutOfStock' ? 'avail-out' : 'avail-in'
                  }">${p.availability === 'OutOfStock' ? 'out of stock' : 'in stock'}</span>`
                : ''
            }
            <span class="sep">/</span>
            ${statusLineHTML(p)}
            ${catOf(p) ? `<span class="tag">${esc(catOf(p))}</span>` : ''}
            ${gname ? `<span class="tag tag-low">${esc(gname)}
              <button type="button" class="btn-ghost" data-act="leave-group" style="border:none;background:none;cursor:pointer;padding:0 0 0 4px" title="Remove from group" aria-label="Remove from group">${icon('x')}</button></span>` : ''}
          </div>
        </div>
      </div>
      <div class="detail-tools">
        ${rangeSegHTML()}
        <div class="detail-actions">
          ${toggle}
          <button class="btn btn-icon" data-act="rename" title="Rename" aria-label="Rename product">${icon('pencil')}</button>
          <button class="btn btn-icon" data-act="category" title="Set category" aria-label="Set category">${icon('tag')}</button>
          <button class="btn btn-icon" data-act="refresh" title="Check price now" aria-label="Check price now">${icon('refresh')}</button>
          <a class="btn btn-icon" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" title="Open product page" aria-label="Open product page">${icon('external')}</a>
          <button class="btn btn-icon" data-act="archive" title="${p.archived ? 'Restore to tracking' : 'Archive (keeps history, stops checks)'}" aria-label="${p.archived ? 'Unarchive' : 'Archive'}">${icon('archive')}</button>
          <button class="btn btn-icon" data-act="delete" title="Stop tracking" aria-label="Stop tracking">${icon('trash')}</button>
        </div>
      </div>
    </div>
    ${renderPriceHead(p)}
    ${bodyHTML}
    ${renderTiles(p)}
    ${targetCalloutHTML(p)}
  </div>`;

  if (hasPts && state.chartMode === 'chart') {
    drawChart(
      $('#chart-mount', root),
      [{ label: p.domain, color: SERIES_COLORS[0], currency: p.currency, points: pts }],
      state.chartDays,
      { target: p.targetPrice ?? null }
    );
  }
  wireRangeSeg(root, renderDetail);
  if (needsFullHistory() && !state.fullPoints.has(p.id)) {
    ensureFullPoints([p.id]).then((fetched) => {
      if (fetched && !state.compare && state.sel === p.id) renderDetail();
    });
  }

  root.querySelectorAll('.seg [data-mode]').forEach((b) =>
    b.addEventListener('click', () => { state.chartMode = b.dataset.mode; renderDetail(); }));

  const setTarget = async () => {
    const v = await pwInput({
      title: 'Target price',
      label: `Alert when the price drops to (${p.currency})`,
      value: p.targetPrice != null ? String(p.targetPrice) : '',
      placeholder: 'e.g. 3999',
      hint: 'Leave blank to remove the target. One alert per crossing — it re-arms when the price rises back above the target.',
      submit: 'Save target',
    });
    if (v == null) return;
    const t = v.trim();
    const num = t === '' ? null : Number(t.replace(/[^\d.]/g, ''));
    if (t !== '' && (!Number.isFinite(num) || num <= 0)) { toast('Enter a number, e.g. 3999.'); return; }
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { targetPrice: num });
      toast(num == null ? 'Target removed.' : `Target set — you'll hear when it hits ${fmtMoney(num, p.currency)}.`);
      await loadState();
    } catch (err) { toast(err.message); }
  };
  const tileTarget = $('[data-act="target"]', root);
  tileTarget?.addEventListener('click', setTarget);
  tileTarget?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTarget(); }
  });

  $('[data-act="archive"]', root).addEventListener('click', async () => {
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { archived: !p.archived });
      toast(p.archived ? 'Restored to tracking.' : 'Archived — find it under Archived in the list header.');
      state.sel = null;
      await loadState();
    } catch (err) { toast(err.message); }
  });

  $('[data-act="rename"]', root).addEventListener('click', async () => {
    const name = await pwInput({ title: 'Rename product', label: 'Product name', value: p.title || '', submit: 'Rename' });
    if (!name || !name.trim()) return;
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { title: name.trim() });
      await loadState();
    } catch (err) { toast(err.message); }
  });

  $('[data-act="category"]', root).addEventListener('click', async () => {
    const c = await pwInput({
      title: 'Set category',
      label: 'Category',
      value: catOf(p) || '',
      placeholder: 'e.g. Shoes, Camera gear',
      hint: 'Leave blank to remove the category.',
      options: allCategories(),
    });
    if (c == null) return;
    try {
      await api(`/api/products/${p.id}`, 'PATCH', { category: c.trim() || null });
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
    const ok = await pwConfirm({
      title: 'Stop tracking?',
      message: `"${p.title || p.url}" and its price history will be deleted. Archiving keeps the history instead.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
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

/* ---------- alerts panel ---------- */

const ALERT_ICON = { target: 'target', low: 'down', drop: 'down', restock: 'package' };

const latestAlertAt = () => state.alerts[0]?.at || '';

function updateAlertDot() {
  const dot = $('#alert-dot');
  if (!dot) return;
  const seen = localStorage.getItem('pricewatch.alertsSeen') || '';
  dot.hidden = !latestAlertAt() || latestAlertAt() <= seen;
}

function openAlerts() {
  const list = $('#alerts-list');
  if (!state.alerts.length) {
    list.innerHTML = `<div class="empty-inline">No alerts yet. Set a target price on a product (its Target tile) and you'll hear when the price drops to it — plus automatic all-time-low, big-drop and restock alerts.</div>`;
  } else {
    list.innerHTML = state.alerts
      .map((a) => {
        const line = (a.message || '').split('\n')[1] || (a.message || '').split('\n')[0] || '';
        const img = a.image
          ? `<img class="thumb" src="${esc(a.image)}" alt="" loading="lazy">`
          : `<span class="thumb-ph">${icon('package')}</span>`;
        return `<div class="alert-row" data-pid="${esc(a.productId)}" role="button" tabindex="0">
          ${img}
          <div class="alert-main">
            <div class="alert-title">${esc(shortTitle(a.title || a.url || 'Product', 64))}</div>
            <div class="alert-msg">${esc(line)}</div>
          </div>
          <div class="alert-side">
            <span class="alert-type alert-${esc(a.type)}">${icon(ALERT_ICON[a.type] || 'alert')}${esc(a.type)}</span>
            <div class="alert-meta">${esc(relTime(a.at) || '')}${a.delivered ? ' · emailed' : ''}</div>
          </div>
        </div>`;
      })
      .join('');
  }
  $('#alerts-note').textContent = state.data?.meta?.email
    ? 'Alerts are also emailed to you.'
    : 'Tip: set the Gmail alert secrets (see README → Price alerts) to get these emailed to your inbox.';
  const dlg = $('#dlg-alerts');
  dlg.showModal();
  if (latestAlertAt()) localStorage.setItem('pricewatch.alertsSeen', latestAlertAt());
  updateAlertDot();
  list.querySelectorAll('.alert-row').forEach((row) => {
    row.addEventListener('click', () => {
      const pid = row.dataset.pid;
      if (state.data.products.some((p) => p.id === pid)) {
        state.sel = pid;
        state.compare = null;
        localStorage.setItem('pricewatch.sel', pid);
        dlg.close();
        render();
      }
    });
  });
}

/* ---------- per-store health ---------- */

function renderHealth() {
  const el = $('#health-line');
  if (!el || !state.data) return;
  const byDomain = new Map();
  for (const p of state.data.products) {
    if (!byDomain.has(p.domain)) byDomain.set(p.domain, { ok: 0, blocked: 0, error: 0, total: 0 });
    const d = byDomain.get(p.domain);
    d.total++;
    if (p.lastStatus === 'ok') d.ok++;
    else if (p.lastStatus === 'blocked') d.blocked++;
    else if (p.lastStatus === 'error') d.error++;
  }
  const trouble = [...byDomain].filter(([, d]) => d.blocked + d.error > 0);
  el.textContent = !state.data.products.length
    ? ''
    : trouble.length
      ? 'Store health: ' +
        trouble
          .map(([dom, d]) => `${dom} ${d.ok}/${d.total} ok${d.blocked ? ' — bot-walled, the extension keeps it fresh' : ''}`)
          .join(' · ')
      : 'Store health: all server checks passing.';
}

/* ---------- root render + global wiring ---------- */

function render() {
  renderHeader();
  renderSummary();
  renderWatch();
  renderDetail();
  renderSide();
  renderHealth();
  updateAlertDot();
}

// Search lives in the top bar, so it survives list re-renders and never has to
// hand focus back to itself mid-typing.
const qEl = $('#q');
qEl.addEventListener('input', () => {
  state.query = qEl.value;
  resetPaging();
  if (state.data) renderWatch();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  qEl.focus();
  qEl.select();
});

$('#btn-check-all').addEventListener('click', () => checkAll().catch((err) => toast(err.message)));

$('#btn-alerts').addEventListener('click', openAlerts);

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

function fillCatList() {
  const dl = $('#cat-list');
  if (dl) dl.innerHTML = allCategories().map((c) => `<option value="${esc(c)}">`).join('');
}

$('#btn-add').addEventListener('click', () => { fillCatList(); $('#dlg-add').showModal(); });
// Appearance changes apply live — you pick a colour and the board is already
// wearing it, so Save only ever concerns the token.
function renderPrefControls() {
  $('#pref-accent').innerHTML = ACCENTS.map(
    ([hex, name]) =>
      `<button type="button" class="swatch" data-accent="${hex}" role="radio" aria-checked="${
        prefs.accent === hex
      }" title="${name}" aria-label="${name}"><span style="background:${hex}"></span></button>`
  ).join('');
  $('#pref-density').innerHTML = DENSITIES.map(
    ([v, l]) => `<button type="button" data-density="${v}" aria-pressed="${prefs.density === v}">${l}</button>`
  ).join('');
  $('#pref-glow').checked = prefs.glow;
}

function wirePrefControls() {
  const repaint = () => {
    savePrefs();
    renderPrefControls();
    if (state.data) render();
  };
  $('#pref-accent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (!b) return;
    prefs.accent = b.dataset.accent;
    repaint();
  });
  $('#pref-density').addEventListener('click', (e) => {
    const b = e.target.closest('[data-density]');
    if (!b) return;
    prefs.density = b.dataset.density;
    repaint();
  });
  $('#pref-glow').addEventListener('change', (e) => {
    prefs.glow = e.target.checked;
    repaint();
  });
}

wirePrefControls();

$('#btn-settings').addEventListener('click', () => {
  $('#form-settings [name="token"]').value = token();
  renderPrefControls();
  $('#dlg-settings').showModal();
});

document.querySelectorAll('dialog').forEach((dlg) =>
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close())));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('dialog[open]')) return; // the dialog eats its own Escape
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
  const category = String(fd.get('category') || '').trim();
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    const r = await api('/api/products', 'POST', { url, title: title || undefined, category: category || undefined });
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

// PWA: installable + instant loads. API calls bypass the cache entirely.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

loadState().catch((err) => toast('Could not reach the server: ' + err.message));
