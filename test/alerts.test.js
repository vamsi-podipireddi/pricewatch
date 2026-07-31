// Unit tests for the pure parts of the alert engine (the DB-touching flow is
// covered end-to-end in test/worker/api.spec.js).
// Run: npm test  (node --test)

import test from 'node:test';
import assert from 'node:assert/strict';
import { dropPct, buildMime, b64url, emailConfigured } from '../src/alerts.js';

test('dropPct reads ALERT_DROP_PCT with a sane default', () => {
  assert.equal(dropPct({}), 10);
  assert.equal(dropPct({ ALERT_DROP_PCT: '15' }), 15);
  assert.equal(dropPct({ ALERT_DROP_PCT: '7.5' }), 7.5);
  assert.equal(dropPct({ ALERT_DROP_PCT: 'nonsense' }), 10);
  assert.equal(dropPct({ ALERT_DROP_PCT: '-5' }), 10);
  assert.equal(dropPct({ ALERT_DROP_PCT: '0' }), 10);
});

test('emailConfigured requires all four Gmail secrets', () => {
  const full = {
    GMAIL_CLIENT_ID: 'id',
    GMAIL_CLIENT_SECRET: 'secret',
    GMAIL_REFRESH_TOKEN: 'refresh',
    ALERT_EMAIL_TO: 'me@gmail.com',
  };
  assert.equal(emailConfigured(full), true);
  for (const key of Object.keys(full)) {
    assert.equal(emailConfigured({ ...full, [key]: '' }), false, `missing ${key}`);
  }
});

test('buildMime encodes emoji subjects as RFC 2047 and preserves the body', () => {
  const mime = buildMime('me@example.com', '🎯 Target hit — Lens', 'Now ₹850 (target ₹900)\nhttps://x.example/p');
  assert.match(mime, /^To: me@example\.com\r\n/);
  const b64 = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\r\n/.exec(mime)?.[1];
  assert.ok(b64, 'subject must be an encoded-word');
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '🎯 Target hit — Lens');
  assert.ok(mime.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(mime.endsWith('\r\n\r\nNow ₹850 (target ₹900)\nhttps://x.example/p'));
});

test('b64url output is URL-safe, unpadded, and round-trips UTF-8', () => {
  const s = b64url('🎯 target — ₹850');
  assert.ok(!/[+/=]/.test(s));
  const decoded = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.equal(decoded, '🎯 target — ₹850');
});
