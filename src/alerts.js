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
// With `html`, the message goes out as multipart/alternative so clients that
// refuse HTML still get the plain-text alert.
export function buildMime(to, subject, body, html) {
  const head = [`To: ${to}`, `Subject: ${encodeSubject(subject)}`, 'MIME-Version: 1.0'];
  if (!html) {
    return [
      ...head,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      body,
    ].join('\r\n');
  }
  // Fixed boundary: the parts are generated here, so it can never collide.
  const b = '__pricewatch_alt__';
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '',
    `--${b}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${b}--`,
    '',
  ].join('\r\n');
}

/* ---------- HTML alert email ---------- */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "'IBM Plex Sans', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const INK = '#ecedef';
const DIM = '#6e737b';
const ACCENT = '#5ce0a8';
const AMBER = '#efb65c';

const CHIP = {
  target: ['Target hit', AMBER, 'rgba(239,182,92,0.14)'],
  low: ['All-time low', ACCENT, 'rgba(92,224,168,0.14)'],
  drop: ['Price drop', ACCENT, 'rgba(92,224,168,0.14)'],
  restock: ['Back in stock', '#8aa8ff', 'rgba(138,168,255,0.14)'],
};

// Mail clients drop SVG and remote images, so the 90-day history renders as a
// column of table cells — plain <td> blocks with background colours, which is
// the one chart primitive every client honours.
function sparkTable(series, target) {
  if (!series || series.length < 2) return '';
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const bars = series
    .map((v) => {
      const h = 6 + Math.round(((v - lo) / span) * 54);
      const on = target != null && v <= target;
      // Both the attribute and the inline style: clients honour one or the other.
      return `<td valign="bottom" style="padding:0 1px;vertical-align:bottom"><div style="height:${h}px;background:${
        on ? ACCENT : 'rgba(255,255,255,0.16)'
      };border-radius:1px;font-size:0;line-height:0">&nbsp;</div></td>`;
    })
    .join('');
  return `<tr><td style="padding:0 24px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
           style="border:1px solid rgba(255,255,255,0.07);border-radius:10px;background:rgba(255,255,255,0.02)">
      <tr><td style="padding:14px 12px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>${bars}</tr></table>
      </td></tr>
    </table>
    <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.1em;color:#4a4e55;padding-top:8px">
      ${esc(String(series.length))}-POINT HISTORY${target != null ? ' · GREEN IS AT OR BELOW TARGET' : ''}
    </div>
  </td></tr>`;
}

function statCells(stats) {
  const cells = stats.filter(Boolean);
  if (!cells.length) return '';
  const w = Math.floor(100 / cells.length);
  return `<tr><td style="border-top:1px solid rgba(255,255,255,0.07);border-bottom:1px solid rgba(255,255,255,0.07)">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      ${cells
        .map(
          ([label, value, color], i) =>
            `<td width="${w}%" style="padding:14px 20px;${
              i ? 'border-left:1px solid rgba(255,255,255,0.07);' : ''
            }">
          <div style="font-family:${MONO};font-size:9.5px;letter-spacing:0.14em;color:${DIM};text-transform:uppercase">${esc(label)}</div>
          <div style="font-family:${MONO};font-size:16px;color:${color || INK};padding-top:5px">${esc(value)}</div>
        </td>`
        )
        .join('')}
    </tr></table>
  </td></tr>`;
}

// `a` is the decided alert; `ctx` carries whatever extra numbers the caller
// managed to look up — every one of them is optional.
export function alertHtml(a, ctx) {
  const [chipText, chipFg, chipBg] = CHIP[a.type] || ['Price alert', ACCENT, 'rgba(92,224,168,0.14)'];
  const moved = ctx.prevPrice != null && ctx.prevPrice > 0 ? (ctx.price - ctx.prevPrice) / ctx.prevPrice : null;
  const move = moved != null && moved < 0 ? `▼ ${Math.abs(moved * 100).toFixed(1)}%` : null;

  return `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#08090a">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
       style="max-width:600px;width:100%;background:#0c0e10;border:1px solid rgba(255,255,255,0.08);border-radius:14px;overflow:hidden">

  <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.07)">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="font-family:${MONO};font-size:11px;letter-spacing:0.2em;color:#c4c8ce">PRICEWATCH</td>
      <td align="right">
        <span style="font-family:${MONO};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;padding:3px 9px;border-radius:5px;background:${chipBg};color:${chipFg}">${esc(chipText)}</span>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:26px 24px 22px">
    <div style="font-family:${MONO};font-size:10.5px;letter-spacing:0.16em;color:${DIM};text-transform:uppercase">${esc(
      ctx.title
    )} · ${esc(ctx.domain || '')}</div>
    <div style="padding-top:12px">
      <span style="font-family:${MONO};font-size:38px;font-weight:500;letter-spacing:-0.03em;color:${INK}">${esc(
        ctx.priceText
      )}</span>
      ${move ? `<span style="font-family:${MONO};font-size:15px;color:${ACCENT};padding-left:12px">${move}</span>` : ''}
    </div>
    <div style="font-family:${SANS};font-size:14px;color:#a5aab2;line-height:1.55;padding-top:10px">${esc(ctx.lede)}</div>
  </td></tr>

  ${sparkTable(ctx.series, ctx.target)}
  ${statCells(ctx.stats)}

  <tr><td style="padding:20px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td width="50%" style="padding-right:5px">
        <a href="${esc(ctx.url)}" style="display:block;text-align:center;padding:12px 0;border-radius:10px;background:${ACCENT};color:#05140d;font-family:${SANS};font-size:13.5px;font-weight:600;text-decoration:none">Buy on ${esc(
          ctx.domain || 'the store'
        )}</a>
      </td>
      <td width="50%" style="padding-left:5px">
        <a href="${esc(ctx.siteUrl || ctx.url)}" style="display:block;text-align:center;padding:12px 0;border-radius:10px;border:1px solid rgba(255,255,255,0.12);color:#c4c8ce;font-family:${SANS};font-size:13.5px;text-decoration:none">Open PriceWatch</a>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:16px 24px 20px;border-top:1px solid rgba(255,255,255,0.07);font-family:${MONO};font-size:10px;line-height:1.7;letter-spacing:0.04em;color:#5a5f66">
    ${esc(ctx.why)}
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// Refresh-token -> access-token -> send. Two requests per alert; alerts are
// rare enough that caching the access token isn't worth the state.
export async function sendEmail(env, subject, body, html) {
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

    const raw = b64url(buildMime(env.ALERT_EMAIL_TO, subject, body, html));
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

// Gathers the numbers the HTML email shows and renders it. Best effort: the
// alert is already recorded by this point, so anything that fails here just
// means the message goes out as plain text only.
async function buildAlertEmail(env, product, alert, { price, cur, title, last }) {
  try {
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const hist = (
      await env.DB.prepare(
        'SELECT price, at FROM price_history WHERE product_id = ? AND at >= ? ORDER BY at ASC LIMIT 400'
      ).bind(product.id, since).all()
    ).results;
    const overall = await env.DB.prepare(
      'SELECT MIN(price) AS low FROM price_history WHERE product_id = ?'
    ).bind(product.id).first();

    // The observation that triggered this alert is not in history yet.
    const prices = [...hist.map((h) => h.price), price];
    const sorted = [...prices].sort((a, b) => a - b);
    const typical = sorted.length >= 7 ? sorted[Math.floor(sorted.length / 2)] : null;
    const allLow = Math.min(overall?.low ?? price, price);

    // Bars are cheap but not free — 40 is enough to show the shape.
    const step = Math.max(1, Math.ceil(prices.length / 40));
    const series = prices.filter((_, i) => i % step === 0 || i === prices.length - 1);

    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = hist.filter((h) => Date.parse(h.at) <= dayAgo).pop();

    const stats = [
      recent ? ['Yesterday', fmtMoney(recent.price, cur), '#8a9099'] : null,
      ['All-time low', fmtMoney(allLow, cur), ACCENT],
      typical != null ? ['Typical 90d', fmtMoney(typical, cur), INK] : null,
    ];

    return alertHtml(alert, {
      title,
      domain: product.domain,
      url: product.url,
      siteUrl: env.SITE_URL || product.url,
      price,
      priceText: fmtMoney(price, cur),
      prevPrice: alert.prev ?? last?.price ?? null,
      target: product.target_price ?? null,
      lede: alert.lede,
      why: alert.why,
      series,
      stats,
    });
  } catch {
    return null;
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
          lede: `It reached ${fmtMoney(price, cur)}, at or below the ${fmtMoney(target, cur)} target you set.`,
          why: `Sent because a ${fmtMoney(target, cur)} target is armed for this product. It re-arms if the price rises back above the target.`,
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
        lede: `It went from out of stock to available at ${fmtMoney(price, cur)}.`,
        why: 'Sent because this product came back in stock since the last check.',
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
            lede: `At ${fmtMoney(price, cur)} it is cheaper than at any point since tracking began — the previous low was ${fmtMoney(
              stats.low,
              cur
            )}.`,
            why: 'Sent because this is a new all-time low. Automatic alerts are limited to one per product every 20 hours.',
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
                lede: `It fell ${fmtMoney(base.price - price, cur)} in a day, from ${fmtMoney(base.price, cur)} to ${fmtMoney(
                  price,
                  cur
                )}.`,
                why: `Sent because the price fell at least ${dropPct(
                  env
                )}% in 24 hours. Automatic alerts are limited to one per product every 20 hours.`,
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

    const html = await buildAlertEmail(env, product, alert, { price, cur, title, last });
    if (await sendEmail(env, alert.text.split('\n')[0], alert.text, html)) {
      const aid = ins.meta?.last_row_id;
      if (aid) await env.DB.prepare('UPDATE alerts SET delivered = 1 WHERE id = ?').bind(aid).run();
    }
    return alert.type;
  } catch {
    // Alerting must never fail the observation that triggered it.
    return null;
  }
}
