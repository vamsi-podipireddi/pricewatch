// Unit tests for the extension's DOM-free HTML parser (auto-sync path).
// Run: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { parseProductHtml } = createRequire(import.meta.url)('../extension/parse.js');

test('parseProductHtml reads JSON-LD price, currency and availability', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Product","name":"X","offers":{"@type":"Offer","price":"3767",
     "priceCurrency":"INR","availability":"https://schema.org/InStock"}}
  </script>`;
  const r = parseProductHtml(html);
  assert.equal(r.price, 3767);
  assert.equal(r.currency, 'INR');
  assert.equal(r.availability, 'InStock');
});

test('parseProductHtml maps SoldOut-style availability to OutOfStock', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Product","offers":{"price":"999","priceCurrency":"INR","availability":"http://schema.org/SoldOut"}}
  </script>`;
  assert.equal(parseProductHtml(html).availability, 'OutOfStock');
});

test('parseProductHtml reads Myntra-style embedded app state', () => {
  const html = `<script>window.__myx={"pdpData":{"name":"Shoe","price":{"mrp":7495,"discounted":7095}}}</script>`;
  const r = parseProductHtml(html);
  assert.equal(r.price, 7095);
  assert.equal(r.mrp, 7495);
  assert.equal(r.currency, 'INR');
});

test('parseProductHtml falls back to meta price + strike-through MRP', () => {
  const html = `<meta property="og:price:amount" content="1611"><del>₹2,999</del>`;
  const r = parseProductHtml(html);
  assert.equal(r.price, 1611);
  assert.equal(r.mrp, 2999);
});
