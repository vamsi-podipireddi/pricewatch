// Unit tests for the pure parts of the extraction engine (no network).
// Run: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePrice,
  parseRating,
  parseCount,
  validMrp,
  normalizeUrl,
  canonicalKey,
  extractJsonLd,
  extractLdExtras,
  extractMeta,
  extractGenericMrp,
  amazonExtras,
} from '../src/extract.js';

/* ---------- parsers ---------- */

test('parsePrice handles currency strings and rejects junk', () => {
  assert.equal(parsePrice('₹28,850.00'), 28850);
  assert.equal(parsePrice('Rs. 1,611'), 1611); // "Rs." dot must not become a decimal point
  assert.equal(parsePrice('M.R.P.: ₹2,999'), 2999);
  assert.equal(parsePrice('9,99'), 9.99); // EU decimal comma
  assert.equal(parsePrice('1.611,00'), 1611); // EU thousands + decimal
  assert.equal(parsePrice(41990), 41990);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('free'), null);
  assert.equal(parsePrice(-5), null);
});

test('parseRating clamps to 0-5 with one decimal', () => {
  assert.equal(parseRating('4.3'), 4.3);
  assert.equal(parseRating('4.35'), 4.4);
  assert.equal(parseRating(5), 5);
  assert.equal(parseRating('7.2'), null);
  assert.equal(parseRating(null), null);
});

test('parseCount strips separators', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('209'), 209);
  assert.equal(parseCount(42), 42);
  assert.equal(parseCount('zero'), null);
});

test('validMrp only accepts MRP strictly above price and within sanity bounds', () => {
  assert.equal(validMrp(2999, 1711), 2999);
  assert.equal(validMrp(1711, 1711), null); // equal -> no discount info / likely misparse
  assert.equal(validMrp(1000, 1711), null); // below price -> misparse
  assert.equal(validMrp(999999, 10), null); // absurd multiple -> misparse
  assert.equal(validMrp(null, 1711), null);
});

/* ---------- URL normalization + canonical identity ---------- */

test('normalizeUrl collapses Amazon to /dp/ASIN', () => {
  assert.equal(
    normalizeUrl('https://www.amazon.in/Tamron-Di-III-Mirrorless-Cameras/dp/B08J7QMKKV/ref=sr_1_3?keywords=tamron&qid=1719&th=1'),
    'https://www.amazon.in/dp/B08J7QMKKV'
  );
  assert.equal(
    normalizeUrl('https://www.amazon.in/gp/product/b08j7qmkkv?psc=1'),
    'https://www.amazon.in/dp/B08J7QMKKV'
  );
});

test('normalizeUrl keeps only pid for Flipkart', () => {
  assert.equal(
    normalizeUrl('https://www.flipkart.com/adofys-tripod/p/itm123abc?pid=TRPGYZ3HYUVGSFQZ&lid=LSTTRP123&marketplace=FLIPKART&srno=s_1_1'),
    'https://www.flipkart.com/adofys-tripod/p/itm123abc?pid=TRPGYZ3HYUVGSFQZ'
  );
  assert.equal(
    normalizeUrl('https://www.flipkart.com/adofys-tripod/p/itm123abc'),
    'https://www.flipkart.com/adofys-tripod/p/itm123abc'
  );
});

test('normalizeUrl strips tracking params on generic stores', () => {
  assert.equal(
    normalizeUrl('https://store.example/p/lens?utm_source=x&fbclid=abc&color=black'),
    'https://store.example/p/lens?color=black'
  );
});

test('canonicalKey identifies the same listing across URL variants', () => {
  const a = canonicalKey('https://www.amazon.in/dp/B08J7QMKKV');
  const b = canonicalKey(normalizeUrl('https://amazon.in/Tamron/dp/b08j7qmkkv?ref=xyz'));
  assert.equal(a, 'amazon.in:B08J7QMKKV');
  assert.equal(a, b);

  const f1 = canonicalKey('https://www.flipkart.com/x/p/itm123abc?pid=TRPGYZ3HYUVGSFQZ');
  const f2 = canonicalKey('https://www.flipkart.com/other-slug/p/itmZZZ?pid=trpgyz3hyuvgsfqz');
  assert.equal(f1, 'flipkart.com:TRPGYZ3HYUVGSFQZ');
  assert.equal(f1, f2);

  assert.equal(canonicalKey('https://store.example/p/lens'), null);
});

/* ---------- JSON-LD ---------- */

const JSONLD_PAGE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"Tamron 70-300mm F/4.5-6.3 Di III RXD",
 "image":["https://img.example/lens.jpg"],
 "mpn":"A047SF",
 "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.4","ratingCount":"312"},
 "offers":{"@type":"Offer","price":"28850","priceCurrency":"INR"}}
</script></head><body></body></html>`;

test('extractJsonLd returns price, rating, review count and model', () => {
  const r = extractJsonLd(JSONLD_PAGE);
  assert.equal(r.ok, true);
  assert.equal(r.price, 28850);
  assert.equal(r.currency, 'INR');
  assert.equal(r.title, 'Tamron 70-300mm F/4.5-6.3 Di III RXD');
  assert.equal(r.rating, 4.4);
  assert.equal(r.reviewCount, 312);
  assert.equal(r.model, 'A047SF');
});

test('extractLdExtras finds aggregateRating without offers, and via raw fragment', () => {
  const noOffers = `<script type="application/ld+json">
    {"@type":"Product","name":"X","aggregateRating":{"ratingValue":4.1,"reviewCount":98}}
  </script>`;
  assert.deepEqual(extractLdExtras(noOffers), { rating: 4.1, reviewCount: 98, model: null });

  const embedded = `<script>window.__STATE__={"aggregateRating":{"ratingValue":"4.2","ratingCount":"1,204"}}</script>`;
  const r = extractLdExtras(embedded);
  assert.equal(r.rating, 4.2);
  assert.equal(r.reviewCount, 1204);
});

test('extractMeta reads og:price:amount', () => {
  const html = `<meta property="og:price:amount" content="1899.00">`;
  assert.equal(extractMeta(html).price, 1899);
});

/* ---------- generic MRP ---------- */

test('extractGenericMrp picks the smallest strike-through above the price', () => {
  const html = `
    <span class="price">₹1,611</span>
    <del>₹2,999</del>
    <del>₹4,499 combo pack</del>
    <span class="old-price">₹3,299</span>`;
  assert.equal(extractGenericMrp(html, 1611), 2999);
});

test('extractGenericMrp rejects candidates at or below the price', () => {
  assert.equal(extractGenericMrp('<del>₹1,611</del>', 1611), null);
  assert.equal(extractGenericMrp('<del>₹900</del>', 1611), null);
  assert.equal(extractGenericMrp('<p>no strikes here</p>', 1611), null);
});

/* ---------- Amazon extras ---------- */

// Deal layout: the buy box carries BOTH a "Was: ₹1,999" strike (deal reference
// price, a-text-price) and the real "M.R.P.: ₹4,899" (basisPrice row). The
// basisPrice value must win — first-strike-match used to return 1,999.
const AMAZON_DEAL_PAGE = `
<div class="carousel">Related item 3.8 out of 5 stars · 12,345 ratings <span class="a-text-price"><span class="a-offscreen">₹999</span></span></div>
<div id="corePriceDisplay_desktop_feature_div">
  <span class="a-price priceToPay"><span class="a-offscreen">₹1,611</span></span>
  <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">₹1,999.00</span></span>
  <span class="a-size-small basisPrice">M.R.P.: <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">₹4,899.00</span></span></span>
</div>
<div id="averageCustomerReviews">
  <span id="acrPopover" title="4.1 out of 5 stars"></span>
  <span id="acrCustomerReviewText">528 ratings</span>
</div>`;

test('amazonExtras prefers the basisPrice M.R.P. over a deal "Was" strike', () => {
  const r = amazonExtras(AMAZON_DEAL_PAGE, 1611);
  assert.equal(r.mrp, 4899);
});

test('amazonExtras scopes rating/reviews to the product review block, not carousels', () => {
  const r = amazonExtras(AMAZON_DEAL_PAGE, 1611);
  assert.equal(r.rating, 4.1);
  assert.equal(r.reviewCount, 528);
});

test('amazonExtras falls back to the LARGEST buy-box strike when unlabeled', () => {
  const html = `
  <div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-offscreen">₹1,611</span></span>
    <span class="a-price a-text-price"><span class="a-offscreen">₹1,999</span></span>
    <span class="a-price a-text-price"><span class="a-offscreen">₹4,899</span></span>
  </div>`;
  assert.equal(amazonExtras(html, 1611).mrp, 4899);
});

test('amazonExtras returns null MRP when nothing valid is in the buy box', () => {
  const html = `<div id="corePriceDisplay_desktop_feature_div">
    <span class="a-price"><span class="a-offscreen">₹1,611</span></span></div>`;
  assert.equal(amazonExtras(html, 1611).mrp, null);
});
