// Price extraction for arbitrary product pages. Workers-runtime compatible
// (fetch + regex only, no DOM). Adapter chain, cheapest/cleanest first:
//   Shopify /products/<handle>.js  ->  JSON-LD  ->  meta tags  ->  site-specific
// extract(url) resolves to:
//   { ok: true,  price, currency, title, image, method }
//   { ok: false, error, blocked? }

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

async function fetchPage(url, { accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      headers: accept ? { ...HEADERS, Accept: accept } : HEADERS,
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
  if (typeof value === 'number') return value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
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

// ---------- URL normalization (shared with the API) ----------

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
  } else {
    for (const k of [...u.searchParams.keys()]) {
      if (JUNK_PARAM.test(k)) u.searchParams.delete(k);
    }
  }
  return u.toString();
}

// ---------- shared page metadata ----------

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

// ---------- generic: JSON-LD ----------

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
      method: 'jsonld',
    };
  }
  return null;
}

// ---------- generic: meta tags / microdata ----------

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

// ---------- Shopify ----------

// Shopify exposes /products/<handle>.js — clean JSON, price in minor units.
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
    const image = typeof data.featured_image === 'string' ? data.featured_image.replace(/^\/\//, 'https://') : null;
    return { ok: true, price, currency: null, title: data.title ?? null, image, method: 'shopify' };
  } catch {
    return null;
  }
}

// ---------- Amazon ----------

function extractAmazon(html) {
  if (/validateCaptcha|Robot Check|api-services-support@amazon/i.test(html)) {
    return { ok: false, blocked: true, error: 'Amazon served a bot check. The extension click still records prices.' };
  }
  const title = decodeEntities(/<span[^>]*id=["']productTitle["'][^>]*>\s*([^<]+)/i.exec(html)?.[1]) ?? null;

  let price = null;
  const core =
    /id=["']corePriceDisplay_desktop_feature_div["']([\s\S]{0,3000})/i.exec(html)?.[1] ??
    /id=["']corePrice_feature_div["']([\s\S]{0,3000})/i.exec(html)?.[1];
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

// ---------- Flipkart ----------

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

// ---------- dispatch ----------

export async function extract(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  try {
    const shopify = await tryShopify(url);
    if (shopify) return finalize(shopify, null, host);

    const { status, text } = await fetchPage(url);
    if (status === 403 || status === 429 || status === 503) {
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

// Fill currency/title/image gaps from generic page metadata.
function finalize(result, html, host) {
  const out = { ...result };
  if (html) {
    out.title = out.title ?? pageTitle(html);
    out.image = out.image ?? pageImage(html);
    out.currency = out.currency ?? guessCurrency(html, host);
  } else if (!out.currency) {
    out.currency = /\.in$/i.test(host) ? 'INR' : 'USD';
  }
  return out;
}
