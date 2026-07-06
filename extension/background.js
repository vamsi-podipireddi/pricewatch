// PriceWatch extension service worker.
// One click on the toolbar icon: scrape the current tab's DOM (title, price,
// currency, image), POST it to the PriceWatch Worker, flash a badge.
// The in-page scrape is what beats bot walls — the page is already rendered
// in a real browser session, so Amazon/Flipkart prices come through even when
// the server-side cron gets blocked.

chrome.action.onClicked.addListener(async (tab) => {
  const cfg = await chrome.storage.sync.get({ server: '', token: '' });
  if (!cfg.server) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
    flash('n/a', '#898781');
    return;
  }

  let scraped = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
    scraped = res?.result ?? null;
  } catch {
    // Restricted page (chrome://, web store, PDF viewer) — fall back to URL only.
  }

  const payload = {
    url: scraped?.url || tab.url,
    title: scraped?.title || tab.title || undefined,
    price: scraped?.price ?? undefined,
    currency: scraped?.currency || undefined,
    image: scraped?.image || undefined,
    source: 'extension',
  };

  try {
    const res = await fetch(cfg.server.replace(/\/+$/, '') + '/api/products', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { 'x-auth-token': cfg.token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return flash('auth', '#d03b3b');
    if (!res.ok) return flash('err', '#d03b3b');
    const data = await res.json().catch(() => ({}));
    // "add" for a new product, "upd" when re-clicking records a fresh price.
    flash(data.existing ? 'upd' : 'add', '#1baf7a');
  } catch {
    flash('err', '#d03b3b');
  }
});

function flash(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
}

// Injected into the page. Must be fully self-contained (no closures).
// Extraction order: JSON-LD -> meta tags -> site selectors -> generic
// "biggest visible price-looking element" heuristic.
function scrapePage() {
  function parseNum(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw > 0 && raw < 1e9 ? raw : null;
    let s = String(raw).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.');
    const lastCom = s.lastIndexOf(',');
    if (lastDot !== -1 && lastCom !== -1) {
      // Both separators: the later one is the decimal mark.
      s = lastCom > lastDot ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '');
    } else if (lastCom !== -1) {
      // Only commas: 2 trailing digits reads as decimal ("9,99"), else thousands.
      s = s.length - lastCom - 1 === 2 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
  }

  function currencyFrom(text) {
    if (!text) return null;
    if (/₹|\bRs\.?\s?\d|\bINR\b/.test(text)) return 'INR';
    if (/£|\bGBP\b/.test(text)) return 'GBP';
    if (/€|\bEUR\b/.test(text)) return 'EUR';
    if (/\bJPY\b/.test(text)) return 'JPY';
    if (/\bAED\b/.test(text)) return 'AED';
    if (/C\$|\bCAD\b/.test(text)) return 'CAD';
    if (/A\$|\bAUD\b/.test(text)) return 'AUD';
    if (/\$|\bUSD\b/.test(text)) return 'USD';
    return null;
  }

  const MONEY_RE = /(₹|\$|€|£|¥|Rs\.?\s?|INR\s?|USD\s?|EUR\s?|GBP\s?|AED\s?)\s?([\d][\d.,]{1,14})/;

  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || null;

  let price = null;
  let currency = null;
  let title = null;
  let image = null;

  // 1. JSON-LD Product
  (function () {
    const walk = (node, depth) => {
      if (!node || depth > 6) return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const f = walk(item, depth + 1);
          if (f) return f;
        }
        return null;
      }
      if (typeof node !== 'object') return null;
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (types.includes('Product')) return node;
      if (node['@graph']) return walk(node['@graph'], depth + 1);
      return null;
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let block;
      try { block = JSON.parse(script.textContent); } catch { continue; }
      const product = walk(block, 0);
      if (!product || !product.offers) continue;
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      for (const offer of offers) {
        if (!offer || typeof offer !== 'object') continue;
        const pr = parseNum(offer.price ?? offer.lowPrice);
        if (pr == null) continue;
        price = pr;
        if (typeof offer.priceCurrency === 'string' && /^[A-Za-z]{3}$/.test(offer.priceCurrency)) {
          currency = offer.priceCurrency.toUpperCase();
        }
        break;
      }
      if (price != null) {
        if (typeof product.name === 'string') title = product.name.trim();
        const img = Array.isArray(product.image) ? product.image[0] : product.image;
        if (typeof img === 'string') image = img;
        else if (img && typeof img.url === 'string') image = img.url;
        return;
      }
    }
  })();

  // 2. Meta tags / microdata
  if (price == null) {
    const amount =
      meta('meta[property="og:price:amount"]') ??
      meta('meta[property="product:price:amount"]') ??
      document.querySelector('[itemprop="price"][content]')?.getAttribute('content');
    price = parseNum(amount);
    if (price != null) {
      const cur =
        meta('meta[property="og:price:currency"]') ??
        meta('meta[property="product:price:currency"]') ??
        document.querySelector('[itemprop="priceCurrency"][content]')?.getAttribute('content');
      if (cur && /^[A-Za-z]{3}$/.test(cur)) currency = cur.toUpperCase();
    }
  }

  // 3. Site-specific fast paths
  if (price == null) {
    const amazonEl = document.querySelector(
      '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, ' +
      '#corePrice_feature_div .a-price .a-offscreen, ' +
      '.priceToPay .a-offscreen, #priceblock_ourprice, #priceblock_dealprice'
    );
    if (amazonEl) {
      price = parseNum(amazonEl.textContent);
      currency = currency || currencyFrom(amazonEl.textContent);
    }
  }

  // 4. Generic: visible price-classed elements, biggest font wins (page's main
  //    price is nearly always the most prominent). Struck-through MRPs excluded.
  if (price == null) {
    const candidates = document.querySelectorAll(
      '[class*="price" i], [id*="price" i], [data-price], [itemprop="price"]'
    );
    let best = null;
    let bestSize = 0;
    let scanned = 0;
    for (const el of candidates) {
      if (++scanned > 400) break;
      if (el.closest('s, del, strike')) continue;
      if (/strike|old|mrp|was|list|compare|cross|regular|original/i.test(el.className)) continue;
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 60) continue;
      const m = MONEY_RE.exec(text);
      if (!m) continue;
      const n = parseNum(m[2]);
      if (n == null) continue;
      const size = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (size > bestSize) {
        bestSize = size;
        best = { n, text };
      }
    }
    if (best) {
      price = best.n;
      currency = currency || currencyFrom(best.text);
    }
  }

  if (!currency) currency = currencyFrom(document.body?.innerText?.slice(0, 4000) || '') || undefined;

  if (!title) {
    title =
      meta('meta[property="og:title"]') ||
      document.querySelector('#productTitle')?.textContent?.trim() ||
      document.title || null;
  }
  if (!image) {
    image = meta('meta[property="og:image"]') || document.querySelector('#landingImage')?.src || null;
  }
  if (image && !/^https?:\/\//i.test(image)) image = null;

  return {
    url: location.href,
    title: title ? title.slice(0, 300) : null,
    price,
    currency: currency || null,
    image,
  };
}
