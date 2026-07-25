// Price extraction for arbitrary product pages. Workers-runtime compatible
// (fetch + regex only, no DOM). Adapter chain, cheapest/cleanest first:
//   Shopify /products/<handle>.js  ->  JSON-LD  ->  meta tags  ->  site-specific
// extract(url) resolves to:
//   { ok: true,  price, mrp, currency, title, image, rating, reviewCount, model, method }
//   { ok: false, error, blocked? }
// MRP is only reported when it is strictly greater than the price — anything
// else is almost always a misparse, and equal-MRP carries no discount info.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// Regex over huge HTML costs CPU (free tier: ~10 ms per invocation). Real
// pages carry price markup early; cap what we scan.
const MAX_HTML = 900_000;

async function fetchPage(url, { accept, cookie } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const headers = { ...HEADERS };
    if (accept) headers.Accept = accept;
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text: text.length > MAX_HTML ? text.slice(0, MAX_HTML) : text };
  } finally {
    clearTimeout(timer);
  }
}

export function parsePrice(value) {
  if (typeof value === 'number') return value > 0 && value < 1e9 ? value : null;
  if (typeof value !== 'string') return null;
  // First number-looking token — keeps "Rs." / "₹" / "INR" prefixes from
  // leaking a stray dot into the digits.
  const m = /(\d[\d.,]*)/.exec(value);
  if (!m) return null;
  let s = m[1].replace(/[.,]+$/, '');
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

export function parseRating(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 && n <= 5 ? Math.round(n * 10) / 10 : null;
}

export function parseCount(value) {
  if (value == null) return null;
  const n = parseInt(String(value).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
}

export function validMrp(mrp, price) {
  return mrp != null && price != null && mrp > price + 0.009 && mrp < price * 20 ? mrp : null;
}

const decodeEntities = (s) =>
  s == null
    ? null
    : s
        .replace(/&amp;/g, '&')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim() || null;

const cleanModel = (v) => {
  if (typeof v !== 'string') return null;
  const s = decodeEntities(v)?.replace(/\s+/g, ' ').trim() ?? null;
  return s && s.length >= 2 && s.length <= 80 && !/^https?:/i.test(s) && !/^[?‏:.-]+$/.test(s) ? s : null;
};

/* ---------- URL normalization + canonical product identity (shared with the API) ---------- */

const JUNK_PARAM =
  /^(utm_\w*|fbclid|gclid|igshid|srsltid|mc_[ce]id|_ga|spm|scm\w*|ref\w*|pf_rd_\w+|pd_rd_\w+|th|psc|smid|linkcode|linkid|ascsubtag|camp|creative)$/i;

export function normalizeUrl(raw) {
  const u = new URL(String(raw).trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are supported');
  u.hash = '';
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(u.pathname + '/');
  if (/(^|\.)amazon\./i.test(u.hostname) && asin) {
    u.pathname = `/dp/${asin[1].toUpperCase()}`;
    u.search = '';
  } else if (/(^|\.)flipkart\.com$/i.test(u.hostname)) {
    // Same listing circulates with different lid/marketplace/ref params; the
    // pid alone identifies it.
    const pid = u.searchParams.get('pid');
    u.search = pid ? `?pid=${pid.toUpperCase()}` : '';
  } else {
    for (const k of [...u.searchParams.keys()]) {
      if (JUNK_PARAM.test(k)) u.searchParams.delete(k);
    }
  }
  return u.toString();
}

// Store-stable product identity ("amazon.in:B0ABC12345"). Lets the API treat
// a re-add of the same listing as an observation even when the URL string
// differs (old rows normalized under v1 rules, slug changes, etc.).
export function canonicalKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (/(^|\.)amazon\./.test(host)) {
    const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(u.pathname + '/')?.[1];
    if (asin) return `${host}:${asin.toUpperCase()}`;
  }
  if (/(^|\.)flipkart\.com$/.test(host)) {
    const pid = u.searchParams.get('pid');
    if (pid) return `${host}:${pid.toUpperCase()}`;
    const itm = /\/p\/(itm[a-z0-9]+)(?:[/?]|$)/i.exec(u.pathname)?.[1];
    if (itm) return `${host}:${itm.toUpperCase()}`;
  }
  return null;
}

/* ---------- shared page metadata ---------- */

function metaContent(html, prop) {
  const a = new RegExp(`<meta[^>]*(?:property|name|itemprop)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)?.[1];
  if (a) return a;
  return new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${prop}["']`, 'i').exec(html)?.[1] ?? null;
}

function pageTitle(html) {
  return decodeEntities(metaContent(html, 'og:title') ?? /<title[^>]*>([^<]+)/i.exec(html)?.[1] ?? null);
}

function pageImage(html) {
  const img = metaContent(html, 'og:image:secure_url') ?? metaContent(html, 'og:image');
  return img && /^https?:\/\//i.test(img) ? decodeEntities(img) : null;
}

function guessCurrency(html, host) {
  const explicit =
    metaContent(html, 'og:price:currency') ?? metaContent(html, 'product:price:currency') ?? metaContent(html, 'priceCurrency');
  if (explicit && /^[A-Za-z]{3}$/.test(explicit)) return explicit.toUpperCase();
  if (/₹|&#8377;|Rs\.\s?\d/.test(html) || /\.in$/i.test(host)) return 'INR';
  if (/£|&pound;/.test(html) || /\.uk$/i.test(host)) return 'GBP';
  if (/€|&euro;/.test(html)) return 'EUR';
  if (/\.jp$/i.test(host)) return 'JPY';
  return 'USD';
}

/* ---------- generic: JSON-LD ---------- */

function* jsonLdBlocks(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      yield JSON.parse(m[1].trim());
    } catch {
      // Malformed block on an otherwise fine page — skip it.
    }
  }
}

function findProductNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.includes('Product')) return node;
  if (node['@graph']) return findProductNode(node['@graph'], depth + 1);
  return null;
}

function offerFields(offers) {
  const list = Array.isArray(offers) ? offers : [offers];
  for (const offer of list) {
    if (!offer || typeof offer !== 'object') continue;
    const price = parsePrice(offer.price ?? offer.lowPrice);
    if (price == null) continue;
    const cur = typeof offer.priceCurrency === 'string' && /^[A-Za-z]{3}$/.test(offer.priceCurrency)
      ? offer.priceCurrency.toUpperCase()
      : null;
    return { price, currency: cur };
  }
  return null;
}

function ldImage(image) {
  const first = Array.isArray(image) ? image[0] : image;
  if (typeof first === 'string' && /^https?:\/\//i.test(first)) return first;
  if (first && typeof first === 'object' && typeof first.url === 'string') return first.url;
  return null;
}

function ratingFromLd(node) {
  const ar = node?.aggregateRating;
  if (!ar || typeof ar !== 'object') return { rating: null, reviewCount: null };
  return {
    rating: parseRating(ar.ratingValue),
    reviewCount: parseCount(ar.ratingCount ?? ar.reviewCount),
  };
}

function modelFromLd(node) {
  const raw = node?.model && typeof node.model === 'object' ? node.model.name : node?.model;
  return cleanModel(typeof raw === 'string' ? raw : typeof node?.mpn === 'string' ? node.mpn : null);
}

export function extractJsonLd(html) {
  for (const block of jsonLdBlocks(html)) {
    const product = findProductNode(block);
    if (!product || !product.offers) continue;
    const fields = offerFields(product.offers);
    if (!fields) continue;
    return {
      ok: true,
      price: fields.price,
      currency: fields.currency,
      title: typeof product.name === 'string' ? decodeEntities(product.name) : null,
      image: ldImage(product.image),
      ...ratingFromLd(product),
      model: modelFromLd(product),
      method: 'jsonld',
    };
  }
  return null;
}

// Rating / review count / model even when the price came from another adapter.
// JSON-LD first, then a raw "aggregateRating" fragment (embedded app state on
// Flipkart-style pages is JSON but not JSON-LD).
export function extractLdExtras(html) {
  for (const block of jsonLdBlocks(html)) {
    const product = findProductNode(block);
    if (!product) continue;
    const { rating, reviewCount } = ratingFromLd(product);
    const model = modelFromLd(product);
    if (rating != null || model) return { rating, reviewCount, model };
  }
  const i = html.indexOf('"aggregateRating"');
  if (i !== -1) {
    const win = html.slice(i, i + 500);
    const rating = parseRating(/"ratingValue"\s*:\s*"?([\d.]+)/.exec(win)?.[1]);
    const reviewCount = parseCount(/"(?:ratingCount|reviewCount)"\s*:\s*"?([\d,]+)/.exec(win)?.[1]);
    if (rating != null) return { rating, reviewCount, model: null };
  }
  return { rating: null, reviewCount: null, model: null };
}

/* ---------- generic: meta tags / microdata ---------- */

export function extractMeta(html) {
  let priceTag =
    metaContent(html, 'og:price:amount') ??
    metaContent(html, 'product:price:amount') ??
    metaContent(html, 'price');
  if (!priceTag) {
    // <span itemprop="price" content="159990">
    priceTag = /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  }
  const price = parsePrice(priceTag);
  if (price == null) return null;
  return { ok: true, price, currency: null, title: null, image: null, method: 'meta' };
}

/* ---------- generic: strike-through MRP ---------- */

// <del>/<s>/<strike> and "was/list/compare/mrp"-classed elements. The smallest
// candidate above the price is the plausible MRP (bigger ones are usually
// bundle or unrelated prices).
export function extractGenericMrp(html, price) {
  if (price == null) return null;
  const cands = [];
  const push = (frag) => {
    const text = frag.replace(/<[^>]+>/g, ' ');
    const m = /([\d][\d,.]{1,14})/.exec(text);
    if (m) {
      const v = parsePrice(m[1]);
      if (v != null) cands.push(v);
    }
  };
  const strikeRe = /<(?:del|s|strike)\b[^>]*>([\s\S]{0,140}?)<\/(?:del|s|strike)>/gi;
  let m;
  let n = 0;
  while ((m = strikeRe.exec(html)) && ++n < 40) push(m[1]);
  const clsRe =
    /class=["'][^"']*(?:compare-at|list-price|old-price|was-price|regular-price|price--old|text-price|mrp)[^"']*["'][^>]*>([\s\S]{0,140}?)<\//gi;
  n = 0;
  while ((m = clsRe.exec(html)) && ++n < 40) push(m[1]);
  const valid = cands.filter((v) => v > price + 0.009 && v < price * 20);
  return valid.length ? Math.min(...valid) : null;
}

/* ---------- Shopify ---------- */

// Shopify exposes /products/<handle>.js — clean JSON, prices in minor units,
// compare_at_price is the strike-through MRP.
async function tryShopify(url) {
  const u = new URL(url);
  const match = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!match) return null;
  try {
    const { status, text } = await fetchPage(`${u.origin}/products/${match[1]}.js`, { accept: 'application/json' });
    if (status !== 200) return null;
    const data = JSON.parse(text);
    const price = parsePrice(data.price != null ? data.price / 100 : null);
    if (price == null) return null;
    const mrp = parsePrice(data.compare_at_price != null ? data.compare_at_price / 100 : null);
    const image = typeof data.featured_image === 'string' ? data.featured_image.replace(/^\/\//, 'https://') : null;
    return { ok: true, price, mrp, currency: null, title: data.title ?? null, image, method: 'shopify' };
  } catch {
    return null;
  }
}

/* ---------- Amazon ---------- */

function extractAmazon(html) {
  if (/validateCaptcha|Robot Check|api-services-support@amazon/i.test(html)) {
    return { ok: false, blocked: true, error: 'Amazon served a bot check. The extension click still records prices.' };
  }
  const title = decodeEntities(/<span[^>]*id=["']productTitle["'][^>]*>\s*([^<]+)/i.exec(html)?.[1]) ?? null;

  let price = null;
  const core =
    /id=["']corePriceDisplay_desktop_feature_div["']([\s\S]{0,6000})/i.exec(html)?.[1] ??
    /id=["']corePrice_feature_div["']([\s\S]{0,6000})/i.exec(html)?.[1];
  if (core) price = parsePrice(/class=["']a-offscreen["'][^>]*>([^<]+)/i.exec(core)?.[1]);
  if (price == null) price = parsePrice(/"priceAmount"\s*:\s*([\d.]+)/.exec(html)?.[1]);
  if (price == null) {
    const off = /class=["']a-offscreen["'][^>]*>(?:₹|&#8377;|Rs\.?\s?|\$|£|€)([\d,.]+)/i.exec(html);
    if (off) price = parsePrice(off[1]);
  }
  if (price == null) return null;

  const image =
    /"hiRes"\s*:\s*"(https:[^"]+)"/.exec(html)?.[1] ??
    /id=["']landingImage["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ??
    null;
  return { ok: true, price, currency: null, title, image, method: 'amazon' };
}

export function amazonExtras(html, price) {
  const core =
    /id=["']corePriceDisplay_desktop_feature_div["']([\s\S]{0,12000})/i.exec(html)?.[1] ??
    /id=["']corePrice_feature_div["']([\s\S]{0,12000})/i.exec(html)?.[1] ??
    '';
  // The true M.R.P. lives in the buy box's "basisPrice" row. A deal page adds
  // a second strike ("Was: ₹1,999" — the recent price, not the MRP) that also
  // carries a-text-price, so labeled candidates win and the generic strike
  // fallback takes the LARGEST strike in the buy box, never the first/smallest.
  let mrp =
    parsePrice(/basisPrice[\s\S]{0,300}?class=["']a-offscreen["'][^>]*>([^<]+)/i.exec(core)?.[1]) ??
    parsePrice(/M\.R\.P\.?[\s\S]{0,160}?(?:₹|&#8377;|Rs\.?\s?|\$|£|€)\s?([\d][\d,.]*)/i.exec(html)?.[1]) ??
    parsePrice(/"basisPrice"[\s\S]{0,160}?"priceAmount"\s*:\s*([\d.]+)/.exec(html)?.[1]);
  if (mrp == null && price != null) {
    const strikes = [];
    const strikeRe = /a-text-price[^>]*>[\s\S]{0,120}?class=["']a-offscreen["'][^>]*>([^<]+)/gi;
    let s;
    let n = 0;
    while ((s = strikeRe.exec(core)) && ++n < 10) {
      const v = parsePrice(s[1]);
      if (v != null && v > price && v < price * 20) strikes.push(v);
    }
    if (strikes.length) mrp = Math.max(...strikes);
  }

  // Rating / count scoped to the product's own review block first — the whole
  // page also contains "x out of 5" snippets for carousel/related products.
  const revBlock = /id=["']averageCustomerReviews["']([\s\S]{0,1500})/i.exec(html)?.[1] ?? '';
  const rating =
    parseRating(/([\d.]+)\s+out of\s+5/i.exec(revBlock)?.[1]) ??
    parseRating(/([\d.]+)\s+out of 5(?:\s+stars)?/i.exec(html)?.[1]);
  const reviewCount =
    parseCount(/([\d,]+)\s*(?:global\s+)?ratings/i.exec(revBlock)?.[1]) ??
    parseCount(/([\d,]+)\s+(?:global\s+)?ratings/i.exec(html)?.[1]);
  const model = cleanModel(
    /Item model number[\s\S]{0,240}?<(?:td|span)[^>]*>\s*(?:<[^>]+>\s*)*([^<]{2,80})</i.exec(html)?.[1] ?? null
  );
  return { mrp: validMrp(mrp, price), rating, reviewCount, model };
}

/* ---------- Flipkart ---------- */

function extractFlipkart(html) {
  if (/Are you a human|unusual traffic/i.test(html)) {
    return { ok: false, blocked: true, error: 'Flipkart served a bot check. The extension click still records prices.' };
  }
  const fromLd = extractJsonLd(html);
  if (fromLd) return { ...fromLd, currency: fromLd.currency ?? 'INR', method: 'flipkart-jsonld' };

  const price =
    parsePrice(/"finalPrice"\s*:\s*{\s*"decimalValue"\s*:\s*"?([\d.]+)/.exec(html)?.[1]) ??
    parsePrice(/"price"\s*:\s*([\d.]+)\s*,\s*"currency"\s*:\s*"INR"/.exec(html)?.[1]);
  if (price == null) return null;
  const title = decodeEntities(/<title>([^<|]+)/i.exec(html)?.[1]) ?? null;
  return { ok: true, price, currency: 'INR', title, image: null, method: 'flipkart' };
}

function flipkartExtras(html, price) {
  const mrp =
    parsePrice(/"mrp"\s*:\s*\{[\s\S]{0,120}?"value"\s*:\s*([\d.]+)/.exec(html)?.[1]) ??
    parsePrice(/"mrp"\s*:\s*([\d.]+)/.exec(html)?.[1]);
  const ld = extractLdExtras(html);
  const model =
    ld.model ?? cleanModel(/Model Number[\s\S]{0,200}?<li[^>]*>\s*([^<]{2,80})</i.exec(html)?.[1] ?? null);
  return { mrp: validMrp(mrp, price), rating: ld.rating, reviewCount: ld.reviewCount, model };
}

/* ---------- dispatch ---------- */

export async function extract(url, { currency } = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  // Geo-priced stores (kentfaith.com and other OpenCart-style shops) pick the
  // display currency from the visitor's IP — a Worker fetch egresses far from
  // the user and gets the wrong one. Their currency switcher persists as a
  // plain `currency=XXX` cookie, so sending it pins the page to the currency
  // the product is already tracked in. Stores that don't use it ignore it.
  const cookie =
    typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency.trim())
      ? `currency=${currency.trim().toUpperCase()}`
      : undefined;

  try {
    const shopify = await tryShopify(url);
    if (shopify) return finalize(shopify, null, host);

    const { status, text } = await fetchPage(url, { cookie });
    // 403/429/503 are explicit refusals; 52x are Cloudflare edge errors that in
    // practice mean the store's bot protection dropped the connection (Myntra).
    if (status === 403 || status === 429 || status === 503 || (status >= 520 && status <= 530)) {
      return { ok: false, blocked: true, error: `Store refused the request (HTTP ${status}).` };
    }
    if (status >= 400) return { ok: false, error: `HTTP ${status}` };

    let result = null;
    if (/(^|\.)amazon\./i.test(host)) result = extractAmazon(text);
    else if (/flipkart\.com$/i.test(host)) result = extractFlipkart(text);
    if (result) return result.ok ? finalize(result, text, host) : result;

    result = extractJsonLd(text) ?? extractMeta(text);
    if (result) return finalize(result, text, host);

    return { ok: false, error: 'No price found on page (unsupported layout). Try adding via the extension.' };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Timed out after 15s' : err?.message || String(err);
    return { ok: false, error: msg };
  }
}

function extrasFor(html, host, price) {
  if (/(^|\.)amazon\./i.test(host)) return amazonExtras(html, price);
  if (/flipkart\.com$/i.test(host)) return flipkartExtras(html, price);
  return { ...extractLdExtras(html), mrp: null };
}

// Fill currency/title/image gaps from generic page metadata, then layer on
// MRP / rating / review count / model from site-specific + generic scans.
function finalize(result, html, host) {
  const out = { mrp: null, rating: null, reviewCount: null, model: null, ...result };
  if (html) {
    out.title = out.title ?? pageTitle(html);
    out.image = out.image ?? pageImage(html);
    out.currency = out.currency ?? guessCurrency(html, host);
    if (out.price != null) {
      const ex = extrasFor(html, host, out.price);
      out.rating = out.rating ?? ex.rating;
      out.reviewCount = out.reviewCount ?? ex.reviewCount;
      out.model = out.model ?? ex.model;
      out.mrp = validMrp(out.mrp ?? ex.mrp ?? extractGenericMrp(html, out.price), out.price);
    }
  } else {
    if (!out.currency) out.currency = /\.in$/i.test(host) ? 'INR' : 'USD';
    out.mrp = validMrp(out.mrp, out.price);
  }
  return out;
}
