// DOM-free product-page parser for auto-sync. The alarm handler fetches raw
// HTML from the service worker (no tab, no DOM), so everything here is regex +
// JSON over text — same adapter order as the Worker's extract.js:
// JSON-LD -> meta tags -> Myntra app state, then a strike-through MRP scan.

function parseProductHtml(html) {
  function parseNum(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw > 0 && raw < 1e9 ? raw : null;
    let s = String(raw).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.');
    const lastCom = s.lastIndexOf(',');
    if (lastDot !== -1 && lastCom !== -1) {
      s = lastCom > lastDot ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '');
    } else if (lastCom !== -1) {
      s = s.length - lastCom - 1 === 2 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
  }

  const meta = (prop) => {
    const a = new RegExp(`<meta[^>]*(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)?.[1];
    if (a) return a;
    return new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`, 'i').exec(html)?.[1] ?? null;
  };

  const out = { price: null, mrp: null, currency: null };

  // 1. JSON-LD Product offers
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (out.price == null && (m = ldRe.exec(html))) {
    let block;
    try { block = JSON.parse(m[1].trim()); } catch { continue; }
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
    const product = walk(block, 0);
    if (!product || !product.offers) continue;
    const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object') continue;
      const pr = parseNum(offer.price ?? offer.lowPrice);
      if (pr == null) continue;
      out.price = pr;
      if (typeof offer.priceCurrency === 'string' && /^[A-Za-z]{3}$/.test(offer.priceCurrency)) {
        out.currency = offer.priceCurrency.toUpperCase();
      }
      break;
    }
  }

  // 2. Meta tags / microdata
  if (out.price == null) {
    out.price = parseNum(
      meta('og:price:amount') ??
        meta('product:price:amount') ??
        /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1]
    );
  }
  if (out.price != null && !out.currency) {
    const cur = meta('og:price:currency') ?? meta('product:price:currency');
    if (cur && /^[A-Za-z]{3}$/.test(cur)) out.currency = cur.toUpperCase();
  }

  // 3. Myntra-style embedded app state: "price":{"mrp":7495,"discounted":7095}
  if (out.price == null) {
    const mm = /"price"\s*:\s*\{\s*"mrp"\s*:\s*(\d+(?:\.\d+)?)\s*,\s*"discounted"\s*:\s*(\d+(?:\.\d+)?)/.exec(html);
    if (mm) {
      out.price = parseNum(mm[2]);
      const mrp = parseNum(mm[1]);
      if (out.price != null && mrp != null && mrp > out.price) out.mrp = mrp;
      out.currency = out.currency || 'INR';
    }
  }

  // Strike-through / "list price"-classed MRP; smallest valid candidate wins.
  if (out.price != null && out.mrp == null) {
    const cands = [];
    const push = (frag) => {
      const t = frag.replace(/<[^>]+>/g, ' ');
      const mv = /([\d][\d,.]{1,14})/.exec(t);
      if (mv) {
        const v = parseNum(mv[1]);
        if (v != null) cands.push(v);
      }
    };
    let s;
    let n = 0;
    const strikeRe = /<(?:del|s|strike)\b[^>]*>([\s\S]{0,140}?)<\/(?:del|s|strike)>/gi;
    while ((s = strikeRe.exec(html)) && ++n < 40) push(s[1]);
    n = 0;
    const clsRe =
      /class=["'][^"']*(?:compare-at|list-price|old-price|was-price|regular-price|price--old|text-price|mrp)[^"']*["'][^>]*>([\s\S]{0,140}?)<\//gi;
    while ((s = clsRe.exec(html)) && ++n < 40) push(s[1]);
    const valid = cands.filter((v) => v > out.price + 0.009 && v < out.price * 20);
    if (valid.length) out.mrp = Math.min(...valid);
  }

  if (out.price != null && !out.currency) {
    if (/₹|&#8377;|\bRs\.?\s?\d|\bINR\b/.test(html)) out.currency = 'INR';
    else if (/£|&pound;/.test(html)) out.currency = 'GBP';
    else if (/€|&euro;/.test(html)) out.currency = 'EUR';
  }

  return out;
}

// Node test hook; ignored by the extension service worker.
if (typeof module !== 'undefined') module.exports = { parseProductHtml };
