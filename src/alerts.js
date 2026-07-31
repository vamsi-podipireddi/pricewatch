// Price alerts: decide, record, push. Called from observe() on every
// successful price observation, BEFORE the new history row is written — so
// the history queries here naturally see the pre-observation state.
//
// One alert max per observation, priority order:
//   target  — price at/below target_price. Hysteresis: fires once per
//             crossing (products.alerted_below_target), re-arms when the
//             price rises back above target.
//   restock — availability flips OutOfStock -> InStock.
//   low     — new all-time tracked low (needs >= 3 prior rows). Throttled.
//   drop    — >= ALERT_DROP_PCT (default 10) percent below ~24h ago. Throttled.
//
// Throttle: low/drop are suppressed while last_alert_at is younger than 20h,
// so a price staircasing down doesn't ping every 2-hour sweep.
// Every alert lands in the alerts table (UI feed) regardless of delivery;
// email push is best-effort on top — the Worker sends through the GMAIL API
// from the user's own account (GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET +
// GMAIL_REFRESH_TOKEN + ALERT_EMAIL_TO secrets; leave them unset and alerts
// still show in the site's feed).

const THROTTLE_MS = 20 * 3600 * 1000;

const fmtMoney = (n, cur) => {
  try {
    return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: cur || 'INR',
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${cur || ''} ${Math.round(n)}`.trim();
  }
};

export function dropPct(env) {
  const n = Number(env.ALERT_DROP_PCT);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/* ---------- email channel (Gmail API, no third-party mail service) ---------- */

export const emailConfigured = (env) =>
  Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.ALERT_EMAIL_TO);

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// RFC 2047 encoded-word so emoji survive the subject line.
const encodeSubject = (s) => `=?UTF-8?B?${bytesToB64(new TextEncoder().encode(s))}?=`;

// Gmail's messages.send wants the whole RFC 822 message base64url-encoded.
export const b64url = (s) =>
  bytesToB64(new TextEncoder().encode(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// From: is omitted on purpose — Gmail stamps the authenticated account.
export function buildMime(to, subject, body) {
  return [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
}

// Refresh-token -> access-token -> send. Two requests per alert; alerts are
// rare enough that caching the access token isn't worth the state.
export async function sendEmail(env, subject, body) {
  if (!emailConfigured(env)) return false;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GMAIL_CLIENT_ID,
        client_secret: env.GMAIL_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    if (!tokenRes.ok) return false;
    const { access_token: accessToken } = await tokenRes.json();
    if (!accessToken) return false;

    const raw = b64url(buildMime(env.ALERT_EMAIL_TO, subject, body));
    const send = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    return send.ok;
  } catch {
    return false;
  }
}

// product: the DB row as it was before this observation (old availability,
// alert flags, target). price: the new observed price. availability: cleaned
// new value or null. last: previous price_history row ({price, at}) or null.
export async function evaluateAlerts(env, product, { price, availability, last }) {
  try {
    const now = new Date().toISOString();
    const cur = product.currency || 'INR';
    const target = product.target_price;
    const title = product.title || product.url;

    let alert = null; // { type, prev, text }

    if (target != null && price <= target + 0.009) {
      if (!product.alerted_below_target) {
        alert = {
          type: 'target',
          prev: target,
          text: `🎯 Target hit — ${title}\nNow ${fmtMoney(price, cur)} (target ${fmtMoney(target, cur)})\n${product.url}`,
        };
      }
    } else if (target != null && product.alerted_below_target) {
      // Back above target: re-arm so the next crossing alerts again.
      await env.DB.prepare('UPDATE products SET alerted_below_target = 0 WHERE id = ?').bind(product.id).run();
    }

    if (!alert && availability === 'InStock' && product.availability === 'OutOfStock') {
      alert = {
        type: 'restock',
        prev: null,
        text: `📦 Back in stock — ${title}\nNow ${fmtMoney(price, cur)}\n${product.url}`,
      };
    }

    if (!alert && last) {
      const throttled = product.last_alert_at && Date.now() - Date.parse(product.last_alert_at) < THROTTLE_MS;
      if (!throttled) {
        const stats = await env.DB.prepare(
          'SELECT MIN(price) AS low, COUNT(*) AS n FROM price_history WHERE product_id = ?'
        ).bind(product.id).first();
        if (stats && stats.n >= 3 && price < stats.low - 0.009) {
          alert = {
            type: 'low',
            prev: stats.low,
            text: `📉 All-time low — ${title}\nNow ${fmtMoney(price, cur)} (previous low ${fmtMoney(stats.low, cur)})\n${product.url}`,
          };
        }
        if (!alert) {
          const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
          const base = await env.DB.prepare(
            'SELECT price FROM price_history WHERE product_id = ? AND at <= ? ORDER BY at DESC LIMIT 1'
          ).bind(product.id, dayAgo).first();
          if (base && base.price > 0) {
            const pct = ((base.price - price) / base.price) * 100;
            if (pct >= dropPct(env)) {
              alert = {
                type: 'drop',
                prev: base.price,
                text: `⬇️ Price drop ${Math.round(pct)}% — ${title}\nNow ${fmtMoney(price, cur)} (was ${fmtMoney(base.price, cur)} a day ago)\n${product.url}`,
              };
            }
          }
        }
      }
    }

    if (!alert) return null;

    const ins = await env.DB.prepare(
      'INSERT INTO alerts (product_id, type, price, prev_price, message, at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(product.id, alert.type, price, alert.prev, alert.text, now).run();
    await env.DB.prepare(
      `UPDATE products SET last_alert_at = ?${alert.type === 'target' ? ', alerted_below_target = 1' : ''} WHERE id = ?`
    ).bind(now, product.id).run();

    if (await sendEmail(env, alert.text.split('\n')[0], alert.text)) {
      const aid = ins.meta?.last_row_id;
      if (aid) await env.DB.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').bind(aid).run();
    }
    return alert.type;
  } catch {
    // Alerting must never fail the observation that triggered it.
    return null;
  }
}
