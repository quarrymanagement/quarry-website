// ============================================================================
// send-golf-reschedule.js — admin-triggered reschedule confirmation email
//
// POST { adminPassword, to, customerName, dateISO, oldTime, newTime, bay,
//        duration, players, notes? }
//
// Used as a manual-send when blob storage isn't authoritative yet (or for
// off-system bookings). Just sends a polished SendGrid email — does NOT
// modify any Netlify Blob.
// ============================================================================
const crypto = require('crypto');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function checkAdmin(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}

function fmtDateLong(iso) {
  try {
    const [y, m, d] = String(iso).split('-').map(n => parseInt(n, 10));
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(dt);
  } catch (_) { return iso; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!SENDGRID_KEY) return reply(500, { ok: false, error: 'SENDGRID_API_KEY not set' });

  const to = (body.to || '').trim();
  if (!to || !to.includes('@')) return reply(400, { ok: false, error: 'Provide valid "to" email' });

  const customerName = body.customerName || 'there';
  const dateISO = body.dateISO || '';
  const dateLong = fmtDateLong(dateISO);
  const oldTime = body.oldTime || '';
  const newTime = body.newTime || '';
  const bay = body.bay || '';
  const duration = body.duration || '';
  const players = body.players || '';
  const notes = body.notes || '';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.78rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px;background:#FFFFFF">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Your Golf Bay Booking — Updated</h2>' +
    '<p style="color:#444">Hi ' + customerName + ', your golf bay booking has been rescheduled. Here are the new details:</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px;font-size:0.95rem">' +
    (dateLong ? '<p style="margin:6px 0"><b>Date:</b> ' + dateLong + '</p>' : '') +
    (oldTime ? '<p style="margin:6px 0;color:#888"><b>Original time:</b> <span style="text-decoration:line-through">' + oldTime + '</span></p>' : '') +
    (newTime ? '<p style="margin:6px 0"><b>New time:</b> <span style="color:#2C5F2D;font-weight:600">' + newTime + '</span></p>' : '') +
    (bay ? '<p style="margin:6px 0"><b>Bay:</b> ' + bay + '</p>' : '') +
    (duration ? '<p style="margin:6px 0"><b>Duration:</b> ' + duration + '</p>' : '') +
    (players ? '<p style="margin:6px 0"><b>Players:</b> ' + players + '</p>' : '') +
    (notes ? '<p style="margin:14px 0 0;color:#444;font-style:italic">' + notes + '</p>' : '') +
    '</div>' +
    '<p style="color:#444">If this doesn\'t work for you, reply directly or call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> and we\'ll find another time.</p>' +
    '<p style="color:#444">Looking forward to seeing you at The Quarry!</p>' +
    '</div></div>';

  const payload = {
    personalizations: [{ to: [{ email: to, name: customerName }] }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry' },
    subject: 'Your Golf Bay Booking has been Rescheduled — The Quarry',
    content: [{ type: 'text/html', value: html }],
    categories: ['quarry-golf-reschedule'],
  };

  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.status >= 200 && r.status < 300) {
    return reply(200, { ok: true, message: 'Reschedule email sent to ' + to });
  }
  const t = await r.text();
  return reply(502, { ok: false, status: r.status, error: t.slice(0, 300) });
};
