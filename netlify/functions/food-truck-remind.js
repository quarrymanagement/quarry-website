// ============================================================================
// food-truck-remind.js
//
// Staff-initiated: sends a friendly payment reminder for one already-invited,
// still-pending_payment food truck booking. Reuses the exact checkoutUrl
// already saved on the booking (from food-truck-invite.js) rather than
// minting a new Square payment link, so this never creates a duplicate link
// for the same slot.
//
// Unlike food-truck-invite.js, a SendGrid failure here is NOT swallowed --
// this is a manual one-off action a staff member is watching in real time,
// so they need to know immediately if it didn't go out.
//
// POST /.netlify/functions/food-truck-remind
// Auth: staff/owner session token (same scheme as food-truck-invite.js)
// Body: { token, date, bookingId }
// ============================================================================

const crypto = require('crypto');
const { readBlob } = require('./_blobs');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
function verifyAnyToken(token) {
  if (!token) return { ok: false };
  const parts = String(token).split('.');
  if (parts.length === 2) {
    const [issued, sig] = parts;
    if (!ADMIN_SECRET || !issued || !sig || hmac(issued, ADMIN_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role: 'owner' };
  }
  if (parts.length === 3) {
    const [issued, role, sig] = parts;
    if (!STAFF_SECRET || !issued || !role || !sig || hmac(`${issued}.${role}`, STAFF_SECRET) !== sig) return { ok: false };
    if (!((Date.now() - parseInt(issued, 10)) / 3600000 < SESSION_TTL_HOURS)) return { ok: false };
    return { ok: true, role };
  }
  return { ok: false };
}

function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }

function sendGridEmail(to, subject, htmlBody) {
  const https = require('https');
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map((e) => ({ email: e })) }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com', name: 'The Quarry Management' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-food-truck-reminder'],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function reminderEmailHtml(leadName, date, time, priceCents, checkoutUrl) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px">' +
    '<h2 style="color:#2C1A0E">Reminder: Your Food Truck Spot is Still Open</h2>' +
    '<p>Hi ' + (leadName || 'there') + ',</p>' +
    '<p>Just following up on the invite we sent for the date below -- we haven\'t received payment yet, so wanted to check in and make sure everything came through okay on your end.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Date:</b> ' + date + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + time + '</p>' +
    '<p style="margin:4px 0"><b>Spot fee:</b> ' + fmtMoney(priceCents) + '</p>' +
    '</div>' +
    '<p>To reserve this date, just complete payment here:</p>' +
    '<p style="text-align:center;margin:24px 0"><a href="' + checkoutUrl + '" style="background:#B8933A;color:#1A0E08;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Reserve &amp; Pay ' + fmtMoney(priceCents) + '</a></p>' +
    '<p>If you have any questions at all, or ran into any trouble with the link, just reply to this email and our management team will get right back to you.</p>' +
    '<p>Looking forward to having you!</p>' +
    '</div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const auth = verifyAnyToken(body.token);
    if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }

    const date = String(body.date || '').trim();
    const bookingId = String(body.bookingId || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'date must be YYYY-MM-DD' }) };
    if (!bookingId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'bookingId is required' }) };

    const path = 'food-truck-bookings/' + date;
    const existing = (await readBlob(path)) || { bookings: [] };
    const booking = (existing.bookings || []).find((b) => b.bookingId === bookingId);
    if (!booking) return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'booking not found' }) };
    if (booking.status !== 'pending_payment') {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ ok: false, error: 'booking is not pending_payment (status: ' + booking.status + ')' }) };
    }
    if (!booking.checkoutUrl) return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: 'booking has no checkoutUrl on file' }) };

    await sendGridEmail(
      booking.leadEmail,
      'Reminder: Your Food Truck Spot at The Quarry - ' + date,
      reminderEmailHtml(booking.leadName, date, booking.time, booking.priceCents, booking.checkoutUrl),
    );

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sentTo: booking.leadEmail }) };
  } catch (err) {
    console.error('food-truck-remind error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
