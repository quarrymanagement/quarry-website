// ============================================================================
// admin-backfill-square-booking.js
//
// Admin-only: for when a Square payment genuinely succeeded (confirmed via
// list-square-payments-debug / food-truck-debug-payment) but square-webhook.js
// never fired or failed silently, so the booking record was left stuck at
// "pending_payment" and the real confirmation emails never went out. Applies
// the exact same write + email steps square-webhook.js's
// handleFoodTruckBooking() would have applied on a successful webhook --
// this is a backfill of that intended behavior, not a new/different email.
//
// POST /.netlify/functions/admin-backfill-square-booking
// Body: { token, kind: "foodtruck", bookingId, date, paymentId, amountPaid }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

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

function sendGridEmail(to, subject, htmlBody) {
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map((e) => ({ email: e })) }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com' },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-food-truck-booking'],
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

// Same copy as square-webhook.js's handleFoodTruckBooking builders.
function buildFoodTruckCustomerHtml(m, amount) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You\'re Booked!</h2>' +
    '<p>Hi ' + (m.leadName || 'there') + ', you\'re confirmed as a food truck vendor at The Quarry.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Date:</b> ' + (m.date || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (m.time || '-') + '</p>' +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total Paid: ' + amount + '</b></p></div>' +
    '<p>We\'d love to promote you ahead of time on our social media and website &mdash; ' +
    '<b>just reply to this email with your logo</b> (and any photos you\'d like us to use) and we\'ll get you featured.</p>' +
    '<p>Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}
function buildFoodTruckOwnerHtml(m, amount, paymentId) {
  return '<h2 style="color:#B8933A">Food Truck Booked</h2>' +
    '<p><b>Truck:</b> ' + (m.leadName || '-') + '</p>' +
    '<p><b>Email:</b> ' + (m.leadEmail || '-') + '</p>' +
    '<p><b>Date:</b> ' + (m.date || '-') + '</p>' +
    '<p><b>Time:</b> ' + (m.time || '-') + '</p>' +
    '<p><b>Total:</b> ' + amount + '</p>' +
    (paymentId ? '<p><b>Square Payment:</b> ' + paymentId + '</p>' : '') +
    '<p>Waiting on their logo/photos via reply-to-email for marketing. (Backfilled by staff -- Square payment succeeded but the webhook did not record it at the time.)</p>';
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'invalid JSON' }) }; }

  const auth = verifyAnyToken(body.token);
  if (!auth.ok || !ALLOWED_ROLES.includes(auth.role)) return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

  if (body.kind !== 'foodtruck') return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'only kind: "foodtruck" is supported' }) };

  const bookingId = String(body.bookingId || '').trim();
  const date = String(body.date || '').trim();
  if (!bookingId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'bookingId and date (YYYY-MM-DD) are required' }) };
  }

  try {
    const path = 'food-truck-bookings/' + date;
    const existing = (await readBlob(path)) || { bookings: [] };
    const bookings = existing.bookings || [];
    const idx = bookings.findIndex((b) => b.bookingId === bookingId);
    if (idx === -1) return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, error: 'booking not found for that date' }) };
    if (bookings[idx].status === 'booked') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, already: true }) };
    }

    const amountStr = body.amountPaid || (bookings[idx].priceCents ? '$' + (bookings[idx].priceCents / 100).toFixed(2) : 'N/A');
    bookings[idx].status = 'booked';
    bookings[idx].paidAt = new Date().toISOString();
    bookings[idx].paymentId = body.paymentId || '';
    bookings[idx].amountPaid = amountStr;
    await writeBlob(path, { bookings });

    const m = bookings[idx];
    let emailResults = {};
    if (m.leadEmail) {
      try {
        await sendGridEmail(m.leadEmail, "You're Booked! Food Truck at The Quarry - " + (m.date || ''), buildFoodTruckCustomerHtml(m, amountStr));
        emailResults.customer = 'sent';
      } catch (e) { emailResults.customer = 'failed: ' + e.message; }
    }
    try {
      await sendGridEmail('management@thequarrystl.com', 'Food Truck Booked - ' + (m.leadName || '?') + ' on ' + (m.date || '?') + ' at ' + (m.time || '?'), buildFoodTruckOwnerHtml(m, amountStr, body.paymentId));
      emailResults.owner = 'sent';
    } catch (e) { emailResults.owner = 'failed: ' + e.message; }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, booking: m, emailResults }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
