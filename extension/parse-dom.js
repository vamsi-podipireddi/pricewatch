// PriceWatch shared DOM scraper. One file, three consumers:
//   - popup "record price" -> injected via chrome.scripting.executeScript({files})
//   - passive capture      -> loaded as a content script before capture.js
// Defines globalThis.__pwScrapePage(); repeat injection is a no-op.
// Extraction order: JSON-LD -> meta tags -> site selectors -> generic
// "biggest visible price-looking element" heuristic. Then the extras pass:
// MRP (strike-through), rating/reviews, model, delivery estimate + pincode.

(() => {
  if (globalThis.__pwScrapePage) return;

  globalThis.__pwScrapePage = function scrapePage() {
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
    let priceEl = null; // DOM element the price came from — anchors the MRP scan
    let currency = null;
    let availability = null; // 'InStock' | 'OutOfStock' | null, from JSON-LD offers
    let title = null;
    let image = null;
    let ldProduct = null; // first JSON-LD Product node, reused for rating/model

    const availabilityOf = (v) => {
      if (typeof v !== 'string') return null;
      const m = /(InStock|LimitedAvailability|InStoreOnly|OnlineOnly|OutOfStock|SoldOut|Discontinued)/i.exec(v);
      if (!m) return null;
      return /InStock|LimitedAvailability|InStoreOnly|OnlineOnly/i.test(m[1]) ? 'InStock' : 'OutOfStock';
    };

    // Containers that show OTHER products' prices (carousels, "similar items",
    // sponsored rails). Their strike-through prices must never become this
    // product's MRP.
    const CROSS_SELL =
      '[class*="carousel" i], [id*="carousel" i], [id*="sims" i], [id*="similar" i], ' +
      '[class*="related" i], [class*="recommend" i], [id*="recommend" i], ' +
      '[id*="sponsored" i], [class*="sponsored" i], [data-component-type="s-search-result"]';

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
          availability = availabilityOf(offer.availability);
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
        priceEl = amazonEl;
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
          best = { n, text, el };
        }
      }
      if (best) {
        price = best.n;
        priceEl = best.el;
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

    const MRP_SEL =
      'del, s, strike, .a-text-price, [class*="mrp" i], [class*="strike" i], ' +
      '[class*="old" i], [class*="was" i], [class*="list-price" i], [class*="compare" i], [class*="price" i]';

    // Struck/"list price"-classed money that could be this product's MRP.
    // Returns the parsed value or null.
    function mrpCandidate(el) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 45) return null;
      const m = MONEY_RE.exec(text);
      if (!m) return null;
      if (el.closest(CROSS_SELL)) return null;
      const cls = String(el.className || '');
      const struckTag = Boolean(el.closest('del, s, strike'));
      const hint = /a-text-price|mrp|strike|old|was|list-price|compare|regular|cross/i.test(cls);
      let struckStyle = false;
      if (!struckTag && !hint) {
        try {
          struckStyle = /line-through/.test(getComputedStyle(el).textDecorationLine || '');
        } catch { /* detached node */ }
      }
      if (!struckTag && !hint && !struckStyle) return null;
      if (!visible(el)) return null;
      const n = parseNum(m[2]);
      if (n == null) return null;
      if (price != null && (n <= price || n > price * 20)) return null;
      return n;
    }

    // MRP resolution order:
    //   1. Amazon buy box — "basisPrice" is the M.R.P. row; it must beat a
    //      deal's "Was:" strike, which is also a-text-price.
    //   2. Struck prices inside the price element's own block, walking outward —
    //      the visual MRP always sits next to the price, so the nearest struck
    //      value wins over anything elsewhere on the page.
    //   3. Whole-document scan (previous behaviour), minus cross-sell rails —
    //      a carousel item's small strike price used to win here and become a
    //      bogus MRP.
    function findMrp() {
      for (const sel of [
        '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
        '#corePrice_feature_div .basisPrice .a-offscreen',
        '#apex_desktop .basisPrice .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen',
        '#corePrice_feature_div .a-text-price .a-offscreen',
      ]) {
        const n = parseNum(document.querySelector(sel)?.textContent);
        if (n != null && price != null && n > price && n < price * 20) return n;
      }

      // No price element yet (price came from JSON-LD / meta): locate the most
      // prominent visible element showing exactly the price, to anchor step 2.
      if (!priceEl && price != null) {
        let bestSize = 0;
        let scanned = 0;
        for (const el of document.querySelectorAll('span, div, b, strong, ins, h1, h2')) {
          if (++scanned > 2500) break;
          if (el.children.length > 2) continue;
          const text = (el.textContent || '').trim();
          if (!text || text.length > 25) continue;
          const m = MONEY_RE.exec(text);
          if (!m || parseNum(m[2]) !== price) continue;
          if (el.closest('del, s, strike') || el.closest(CROSS_SELL)) continue;
          if (!visible(el)) continue;
          const size = parseFloat(getComputedStyle(el).fontSize) || 0;
          if (size > bestSize) {
            bestSize = size;
            priceEl = el;
          }
        }
      }

      if (priceEl) {
        let node = priceEl.parentElement;
        for (let depth = 0; node && node !== document.body && depth < 7; depth++, node = node.parentElement) {
          let best = null;
          let scanned = 0;
          for (const el of node.querySelectorAll(MRP_SEL)) {
            if (++scanned > 300) break;
            const n = mrpCandidate(el);
            if (n != null && (best == null || n < best)) best = n;
          }
          if (best != null) return best;
        }
      }

      let best = null;
      let scanned = 0;
      for (const el of document.querySelectorAll(MRP_SEL)) {
        if (++scanned > 500) break;
        const n = mrpCandidate(el);
        if (n != null && (best == null || n < best)) best = n;
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
      availability,
      image,
      rating: findRating(),
      reviewCount: findReviewCount(),
      model: findModel(),
      deliveryText,
      deliveryDate: parseDeliveryDate(deliveryText),
      deliveryPincode: findPincode(),
    };
  };
})();
