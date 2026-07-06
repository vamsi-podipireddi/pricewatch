// PriceWatch extension service worker.
// One click on the toolbar icon: scrape the current tab's DOM (title, price,
// MRP, rating, reviews, delivery estimate, image), POST it to the PriceWatch
// Worker, flash a badge.
// The in-page scrape is what beats bot walls — the page is already rendered
// in a real browser session, so Amazon/Flipkart prices come through even when
// the server-side cron gets blocked. It is also the ONLY source of
// pincode-specific delivery estimates: the store renders them for the
// location set in this browser, which a server-side fetch never has.

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
    mrp: scraped?.mrp ?? undefined,
    currency: scraped?.currency || undefined,
    image: scraped?.image || undefined,
    rating: scraped?.rating ?? undefined,
    reviewCount: scraped?.reviewCount ?? undefined,
    model: scraped?.model || undefined,
    deliveryText: scraped?.deliveryText || undefined,
    deliveryDate: scraped?.deliveryDate || undefined,
    deliveryPincode: scraped?.deliveryPincode || undefined,
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
// "biggest visible price-looking element" heuristic. Then the extras pass:
// MRP (strike-through), rating/reviews, model, delivery estimate + pincode.
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

  const visible = (el) => {
    if (el.closest('del, s, strike')) return true; // struck != hidden
    if (el.offsetParent) return true;
    try {
      return getComputedStyle(el).position === 'fixed';
    } catch {
      return false;
    }
  };

  let price = null;
  let currency = null;
  let title = null;
  let image = null;
  let ldProduct = null; // first JSON-LD Product node, reused for rating/model

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
      if (!product) continue;
      if (!ldProduct) ldProduct = product;
      if (!product.offers) continue;
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
        ldProduct = product;
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

  /* ----- extras: MRP ----- */

  // Struck-through / "list price"-classed money near the price. Smallest
  // candidate above the price wins (bigger ones are bundles or unrelated).
  function findMrp() {
    let best = null;
    const els = document.querySelectorAll(
      'del, s, strike, .a-text-price, [class*="mrp" i], [class*="strike" i], ' +
      '[class*="old" i], [class*="was" i], [class*="list-price" i], [class*="compare" i], [class*="price" i]'
    );
    let scanned = 0;
    for (const el of els) {
      if (++scanned > 500) break;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 45) continue;
      const m = MONEY_RE.exec(text);
      if (!m) continue;
      const cls = String(el.className || '');
      const struckTag = Boolean(el.closest('del, s, strike'));
      const hint = /a-text-price|mrp|strike|old|was|list-price|compare|regular|cross/i.test(cls);
      let struckStyle = false;
      if (!struckTag && !hint) {
        try {
          struckStyle = /line-through/.test(getComputedStyle(el).textDecorationLine || '');
        } catch { /* detached node */ }
      }
      if (!struckTag && !hint && !struckStyle) continue;
      if (!visible(el)) continue;
      const n = parseNum(m[2]);
      if (n == null) continue;
      if (price != null && (n <= price || n > price * 20)) continue;
      if (best == null || n < best) best = n;
    }
    return best;
  }

  /* ----- extras: rating / review count ----- */

  function findRating() {
    const ar = ldProduct?.aggregateRating;
    if (ar && typeof ar === 'object') {
      const r = parseFloat(ar.ratingValue);
      if (Number.isFinite(r) && r > 0 && r <= 5) return Math.round(r * 10) / 10;
    }
    const t =
      document.querySelector('#acrPopover')?.getAttribute('title') ||
      document.querySelector('span[data-hook="rating-out-of-text"]')?.textContent ||
      '';
    const m = /([\d.]+)\s+out of\s+5/.exec(t);
    if (m) {
      const r = parseFloat(m[1]);
      if (r > 0 && r <= 5) return Math.round(r * 10) / 10;
    }
    return null;
  }

  function findReviewCount() {
    const ar = ldProduct?.aggregateRating;
    if (ar && typeof ar === 'object') {
      const n = parseInt(String(ar.ratingCount ?? ar.reviewCount ?? '').replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const m = /([\d,]+)/.exec(document.querySelector('#acrCustomerReviewText')?.textContent || '');
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (n > 0) return n;
    }
    return null;
  }

  /* ----- extras: model number ----- */

  function findModel() {
    const raw = ldProduct?.model && typeof ldProduct.model === 'object' ? ldProduct.model.name : ldProduct?.model;
    const ld = typeof raw === 'string' ? raw : typeof ldProduct?.mpn === 'string' ? ldProduct.mpn : null;
    if (ld && ld.trim().length >= 2 && ld.trim().length <= 80) return ld.trim();

    for (const row of document.querySelectorAll(
      '#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr'
    )) {
      if (/item model number/i.test(row.textContent || '')) {
        const v = row.querySelector('td')?.textContent?.replace(/\s+/g, ' ').trim();
        if (v && v.length >= 2 && v.length <= 80) return v;
      }
    }
    for (const li of document.querySelectorAll('#detailBullets_feature_div li')) {
      const t = li.textContent || '';
      if (/item model number/i.test(t)) {
        const v = t.split(':').pop().replace(/[‎‏]/g, '').replace(/\s+/g, ' ').trim();
        if (v && v.length >= 2 && v.length <= 80) return v;
      }
    }
    let scanned = 0;
    for (const row of document.querySelectorAll('table tr')) {
      if (++scanned > 250) break;
      const cells = row.querySelectorAll('td, th');
      if (cells.length >= 2 && /^\s*model\s*(number|name)?\s*$/i.test(cells[0].textContent || '')) {
        const v = cells[1].textContent?.replace(/\s+/g, ' ').trim();
        if (v && v.length >= 2 && v.length <= 80) return v;
      }
    }
    return null;
  }

  /* ----- extras: delivery estimate + pincode ----- */

  function findDelivery() {
    // Amazon exposes a clean machine-readable attribute.
    const csa = document.querySelector('#mir-layout-DELIVERY_BLOCK [data-csa-c-delivery-time]');
    const attr = csa?.getAttribute('data-csa-c-delivery-time');
    if (attr && attr.trim()) return ('Delivery ' + attr.trim()).slice(0, 120);
    const blk = document.querySelector('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage');
    if (blk && blk.innerText) {
      const line = blk.innerText.trim().split('\n')[0];
      if (line && line.length >= 8) return line.slice(0, 120);
    }
    // Generic (covers Flipkart): first delivery-ish phrase in the page text.
    const body = (document.body?.innerText || '').slice(0, 80000);
    for (const re of [
      /free delivery\s+(?:by\s+)?[^\n.!|]{2,60}/i,
      /delivery by\s+[^\n.!|]{2,60}/i,
      /get it by\s+[^\n.!|]{2,60}/i,
      /delivery in\s+[^\n.!|]{2,40}/i,
      /(?:^|\n)\s*(?:estimated |expected )?delivery[:\s]+[^\n.!|]{2,60}/i,
    ]) {
      const m = re.exec(body);
      if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 120);
    }
    return null;
  }

  function parseDeliveryDate(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    const now = new Date();
    const plus = (d) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const iso = (x) =>
      x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    if (/\btoday\b/.test(t)) return iso(plus(0));
    if (/\btomorrow\b/.test(t)) return iso(plus(1));
    const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    let dd = null;
    let mm = null;
    let m = /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.exec(t);
    if (m) { dd = +m[1]; mm = MONTHS[m[2]]; }
    else if ((m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/.exec(t))) {
      mm = MONTHS[m[1]];
      dd = +m[2];
    }
    if (dd != null && mm != null && dd >= 1 && dd <= 31) {
      let cand = new Date(now.getFullYear(), mm, dd);
      if (cand.getTime() < now.getTime() - 3 * 86400000) cand = new Date(now.getFullYear() + 1, mm, dd);
      if (cand.getTime() > now.getTime() + 200 * 86400000) return null;
      return iso(cand);
    }
    const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const wd = DAYS.findIndex((d) => t.includes(d));
    if (wd !== -1) {
      let diff = (wd - now.getDay() + 7) % 7;
      if (!diff) diff = 7;
      return iso(plus(diff));
    }
    return null;
  }

  function findPincode() {
    const glow = /(\d{6})/.exec(document.querySelector('#glow-ingress-line2')?.textContent || '');
    if (glow) return glow[1];
    for (const inp of document.querySelectorAll('input[maxlength="6"]')) {
      const v = (inp.value || '').trim();
      if (/^\d{6}$/.test(v)) return v;
    }
    const m = /deliver(?:y| to)[^\n]{0,60}?(\d{6})/i.exec((document.body?.innerText || '').slice(0, 30000));
    return m ? m[1] : null;
  }

  const deliveryText = findDelivery();

  return {
    url: location.href,
    title: title ? title.slice(0, 300) : null,
    price,
    mrp: findMrp(),
    currency: currency || null,
    image,
    rating: findRating(),
    reviewCount: findReviewCount(),
    model: findModel(),
    deliveryText,
    deliveryDate: parseDeliveryDate(deliveryText),
    deliveryPincode: findPincode(),
  };
}
