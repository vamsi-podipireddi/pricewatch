// PriceWatch popup: is this page tracked? Show price/trend/status and let the
// user record the price (or start tracking) with one button. The actual
// scrape+POST runs in the service worker (captureTab) so popup close mid-way
// doesn't lose the observation.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let cfg = { server: '', token: '' };
let tab = null;

const base = () => cfg.server.replace(/\/+$/, '');
const auth = () => (cfg.token ? { 'x-auth-token': cfg.token } : {});

function fmtMoney(n, cur = 'INR') {
  try {
    return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: cur,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${cur} ${Math.round(n)}`;
  }
}

function relTime(iso) {
  if (!iso) return null;
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// 90-day step sparkline from API points [{t, p}].
function sparkline(points) {
  if (!points || points.length < 2) return '';
  const now = Date.now();
  const start = now - 90 * 86400_000;
  const pts = [];
  let v0 = null;
  for (const pt of points) {
    const t = Date.parse(pt.t);
    if (t <= start) v0 = pt.p;
    else pts.push({ t, p: pt.p });
  }
  if (v0 != null) pts.unshift({ t: start, p: v0 });
  if (pts.length) pts.push({ t: now, p: pts[pts.length - 1].p });
  if (pts.length < 2) return '';
  const W = 312, H = 44, P = 3;
  let min = Infinity, max = -Infinity;
  for (const s of pts) { min = Math.min(min, s.p); max = Math.max(max, s.p); }
  if (min === max) { min -= 1; max += 1; }
  const x = (t) => P + ((t - start) / (now - start)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  let d = '';
  pts.forEach((s, i) => {
    const px = x(s.t).toFixed(1), py = y(s.p).toFixed(1);
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`;
  });
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-label="90-day price trend">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${x(last.t).toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="2.5" fill="var(--ink)"/>
  </svg>`;
}

function statusLine(p) {
  if (!p.lastChecked) return `<span class="status">first check pending</span>`;
  if (p.lastStatus === 'ok') return `<span class="status ok">checked ${relTime(p.lastChecked)}</span>`;
  if (p.lastStatus === 'blocked') return `<span class="status blocked">bot-walled — this popup and passive capture keep it fresh</span>`;
  return `<span class="status error">last server check failed</span>`;
}

function renderMessage(html) {
  $('#app').innerHTML = `<div class="msg">${html}</div>`;
}

function renderProduct(p, resultHTML = '') {
  const mrp = p.mrp != null && p.currentPrice != null && p.mrp > p.currentPrice ? p.mrp : null;
  const off = mrp ? Math.round((1 - p.currentPrice / mrp) * 100) : null;
  $('#app').innerHTML = `
    <div class="row">
      ${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : ''}
      <div style="min-width:0">
        <div class="title">${esc(p.title || p.url)}</div>
        <div class="sub">${esc(p.domain)}${p.category ? ` · ${esc(p.category)}` : ''}</div>
      </div>
    </div>
    <div class="price-line">
      <span class="price">${p.currentPrice != null ? fmtMoney(p.currentPrice, p.currency) : '—'}</span>
      ${mrp ? `<span class="mrp">${fmtMoney(mrp, p.currency)}</span>` : ''}
      ${off ? `<span class="pill pill-off">-${off}%</span>` : ''}
      ${p.targetPrice != null ? `<span class="pill pill-target">target ${fmtMoney(p.targetPrice, p.currency)}</span>` : ''}
    </div>
    ${sparkline(p.points)}
    ${statusLine(p)}
    <button id="record">Record price now</button>
    <div class="result" id="result">${resultHTML}</div>`;
  $('#record').addEventListener('click', () => capture('Recording…'));
}

function renderUntracked(resultHTML = '') {
  $('#app').innerHTML = `
    <div class="title">${esc(tab.title || tab.url)}</div>
    <div class="sub">Not tracked yet.</div>
    <button id="record">Track this product</button>
    <div class="result" id="result">${resultHTML}</div>`;
  $('#record').addEventListener('click', () => capture('Adding…'));
}

async function lookup() {
  const res = await fetch(`${base()}/api/products/lookup?url=${encodeURIComponent(tab.url)}`, { headers: auth() });
  if (res.status === 401) throw new Error('auth');
  if (!res.ok) throw new Error('http');
  return (await res.json()).product;
}

async function capture(busyLabel) {
  const btn = $('#record');
  btn.disabled = true;
  btn.textContent = busyLabel;
  let r;
  try {
    r = await chrome.runtime.sendMessage({
      kind: 'pw-capture-tab',
      tab: { id: tab.id, url: tab.url, title: tab.title },
    });
  } catch (err) {
    // The service worker died mid-capture, so no response ever came back.
    r = { status: 'no-reply', detail: err?.message || 'background script did not respond' };
  }

  if (r?.status === 'ok') {
    // A capture with no price changed nothing — the store hid it from the page.
    const note = !r.priced
      ? `<span class="err">No price found on this page — nothing recorded.</span>`
      : `<span class="ok">${r.existing ? 'Price recorded.' : 'Now tracking.'}</span>`;
    try {
      const p = await lookup();
      if (p) return renderProduct(p, note);
    } catch { /* fall through to plain message */ }
    renderMessage(r.priced ? 'Saved.' : 'No price found on this page.');
    return;
  }

  const MSG = {
    auth: 'Token rejected — fix it in Settings.',
    'no-server': 'Set the server URL in Settings first.',
    na: 'This page cannot be tracked — open the product page itself.',
    unreachable: 'Could not reach the server.',
    'http-error': 'The server rejected it.',
    'no-reply': 'The extension background stopped before replying.',
  };
  const el = $('#result');
  if (el) {
    el.innerHTML =
      `<span class="err">${esc(MSG[r?.status] || 'Capture failed.')}</span>` +
      (r?.detail ? `<span class="detail">${esc(r.detail)}</span>` : '');
  }
  btn.disabled = false;
  btn.textContent = 'Try again';
}

async function init() {
  cfg = await chrome.storage.sync.get({ server: '', token: '' });
  $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#open-dash').addEventListener('click', () => {
    if (cfg.server) chrome.tabs.create({ url: base() });
  });
  if (!cfg.server) {
    renderMessage('Set your PriceWatch server URL first — open <b>Settings</b> below.');
    return;
  }
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    renderMessage('Open a product page, then use this popup to track it.');
    return;
  }
  try {
    const p = await lookup();
    if (p) renderProduct(p);
    else renderUntracked();
  } catch (err) {
    if (err.message === 'auth') renderMessage('This deployment requires a token for reads — set it in <b>Settings</b>.');
    else renderUntracked('<span class="err">Could not check tracking status.</span>');
  }
}

init();
