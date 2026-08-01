// PriceWatch extension service worker.
//
// The toolbar POPUP (popup.html) is the primary UI now: it shows whether the
// current page is tracked (price, trend, status) and records prices on demand
// through captureTab() below. The in-page scrape (parse-dom.js) is what beats
// bot walls — the page is already rendered in a real browser session, so
// Amazon/Flipkart/Myntra prices come through even when the server-side cron
// gets blocked. It is also the ONLY source of pincode-specific delivery
// estimates.
//
// Passive capture: parse-dom.js + capture.js run as a content script,
// registered dynamically for ONLY the origins of products you already track.
// Browsing a tracked product page records a fresh observation automatically
// (observeOnly — an untracked page is a server-side no-op, never an add).
//
// Auto-sync (bottom): an alarm re-fetches bot-walled products' HTML from this
// browser's IP with the site's own cookies and posts what parse.js finds.

importScripts('parse.js');

/* ---------- config helpers ---------- */

const getCfg = () =>
  chrome.storage.sync.get({ server: '', token: '', autosync: true, autosyncMins: 240, passive: true });
const baseOf = (cfg) => cfg.server.replace(/\/+$/, '');
const authOf = (cfg) => (cfg.token ? { 'x-auth-token': cfg.token } : {});

function buildPayload(scraped, fallbackUrl, fallbackTitle) {
  return {
    url: scraped?.url || fallbackUrl,
    title: scraped?.title || fallbackTitle || undefined,
    price: scraped?.price ?? undefined,
    mrp: scraped?.mrp ?? undefined,
    currency: scraped?.currency || undefined,
    availability: scraped?.availability || undefined,
    image: scraped?.image || undefined,
    rating: scraped?.rating ?? undefined,
    reviewCount: scraped?.reviewCount ?? undefined,
    model: scraped?.model || undefined,
    deliveryText: scraped?.deliveryText || undefined,
    deliveryDate: scraped?.deliveryDate || undefined,
    deliveryPincode: scraped?.deliveryPincode || undefined,
    source: 'extension',
  };
}

/* ---------- on-demand capture (popup "record price" button) ---------- */

async function scrapeTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['parse-dom.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (globalThis.__pwScrapePage ? globalThis.__pwScrapePage() : null),
    });
    return res?.result ?? null;
  } catch {
    return null; // restricted page (chrome://, web store, PDF viewer)
  }
}

// Every failure carries why it failed: "could not reach the server" is a very
// different problem from "the server said 500" or "this page hid its price",
// and the popup can only tell the user what to do if it knows which happened.
async function captureTab(tab) {
  const cfg = await getCfg();
  if (!cfg.server) return { status: 'no-server' };
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) return { status: 'na' };

  const scraped = await scrapeTab(tab.id);
  const payload = buildPayload(scraped, tab.url, tab.title);
  const url = baseOf(cfg) + '/api/products';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authOf(cfg) },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Never reached the origin at all: server down, wrong URL, DNS, offline.
    return { status: 'unreachable', detail: `${new URL(url).origin} — ${err?.message || 'network error'}` };
  }
  if (res.status === 401) return { status: 'auth' };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = `HTTP ${res.status}`;
    try { detail += ` — ${JSON.parse(body).error}`; } catch { /* non-JSON body */ }
    return { status: 'http-error', detail };
  }
  const data = await res.json().catch(() => ({}));
  // A newly tracked product changes the origin set passive capture watches.
  if (!data.existing) syncContentScripts().catch(() => {});
  // The Worker only records an observation when a price came with it, so a page
  // whose price we could not read is a no-op — say so rather than claim success.
  return {
    status: 'ok',
    existing: Boolean(data.existing),
    priced: payload.price != null,
    product: data.product ?? null,
  };
}

/* ---------- passive capture ---------- */

async function passiveObserve(scraped) {
  if (!scraped || scraped.price == null) return;
  const cfg = await getCfg();
  if (!cfg.server || !cfg.passive) return;
  // observeOnly: the Worker updates a matching tracked product and ignores
  // everything else — browsing must never auto-add products.
  const payload = { ...buildPayload(scraped, scraped.url, undefined), observeOnly: true };
  try {
    await fetch(baseOf(cfg) + '/api/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authOf(cfg) },
      body: JSON.stringify(payload),
    });
  } catch {
    // Offline / server down — the next visit records it.
  }
}

const CAPTURE_SCRIPT_ID = 'pw-capture';

// Register the capture content script for exactly the origins of tracked
// products — never the whole web. Re-run whenever the tracked set changes.
async function syncContentScripts() {
  const cfg = await getCfg();
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [CAPTURE_SCRIPT_ID] })
    .catch(() => []);
  const unregister = async () => {
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT_ID] }).catch(() => {});
    }
  };
  if (!cfg.server || !cfg.passive) return unregister();

  let origins = [];
  try {
    const res = await fetch(baseOf(cfg) + '/api/products', { headers: authOf(cfg) });
    if (!res.ok) return;
    const { products = [] } = await res.json();
    origins = [
      ...new Set(
        products
          .map((p) => {
            try {
              return new URL(p.url).origin + '/*';
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      ),
    ];
  } catch {
    return; // keep the current registration rather than flapping
  }
  if (!origins.length) return unregister();

  const script = {
    id: CAPTURE_SCRIPT_ID,
    js: ['parse-dom.js', 'capture.js'],
    matches: origins,
    runAt: 'document_idle',
  };
  if (existing.length) await chrome.scripting.updateContentScripts([script]).catch(() => {});
  else await chrome.scripting.registerContentScripts([script]).catch(() => {});
}

/* ---------- messages (popup + content script) ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.kind === 'pw-capture-tab') {
    captureTab(msg.tab).then(sendResponse);
    return true; // async response
  }
  if (msg?.kind === 'pw-passive-capture') {
    passiveObserve(msg.scraped).then(() => sendResponse({ ok: true }));
    return true;
  }
});

/* ---------- auto-sync ----------
The server cron can't reach bot-walled stores (Myntra 520s every datacenter
IP), but a plain fetch from this browser — home IP, real Chrome TLS, the
site's own cookies — returns the full page. An alarm re-checks the products
the server marked blocked/error and posts whatever parse.js finds, so those
stay fresh without opening the popup. Only cost: the browser must be
running. */

const SYNC_ALARM = 'pricewatch-autosync';
const SYNC_MAX_PER_RUN = 15;

async function ensureSyncAlarm() {
  const cfg = await getCfg();
  await chrome.alarms.clear(SYNC_ALARM);
  if (!cfg.autosync) return;
  chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: 3, // near-term first run also covers "browser was closed all night"
    periodInMinutes: Math.max(30, Number(cfg.autosyncMins) || 240),
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSyncAlarm();
  syncContentScripts().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  ensureSyncAlarm();
  syncContentScripts().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.autosync || changes.autosyncMins) ensureSyncAlarm();
  if (changes.passive || changes.server || changes.token) syncContentScripts().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) autoSync().catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function autoSync() {
  const cfg = await getCfg();
  if (!cfg.server || !cfg.autosync) return;
  const base = baseOf(cfg);
  const auth = authOf(cfg);

  const res = await fetch(base + '/api/products', { headers: auth });
  if (!res.ok) return;
  const { products = [] } = await res.json();
  const targets = products
    .filter((p) => p.lastStatus === 'blocked' || p.lastStatus === 'error')
    .slice(0, SYNC_MAX_PER_RUN);

  for (const p of targets) {
    try {
      const page = await fetch(p.url, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (page.ok) {
        const parsed = parseProductHtml(await page.text());
        if (parsed.price != null) {
          await fetch(base + '/api/products', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...auth },
            body: JSON.stringify({
              url: p.url,
              price: parsed.price,
              mrp: parsed.mrp ?? undefined,
              currency: parsed.currency ?? undefined,
              availability: parsed.availability ?? undefined,
              source: 'extension',
            }),
          });
        }
      }
    } catch {
      // One store failing must not stop the rest of the batch.
    }
    await sleep(3000 + Math.random() * 2000); // gentle pacing, not a crawl burst
  }
  syncContentScripts().catch(() => {}); // tracked-origin set may have changed
}
