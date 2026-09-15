// ============================================================================
// food-truck-invite.js
//
// Staff-initiated: invites one specific food truck lead to one specific
// Friday/Saturday/Sunday date + time slot, at a price staff sets per invite
// (usually $100, but flexible). Creates a Square Checkout link and emails it
// directly to the lead -- there's no public self-serve booking page for food
// trucks, unlike pavilions; every invite is 1:1 and staff-driven.
//
// The booking sits as "pending_payment" until Square's webhook confirms
// payment (see square-webhook.js's handleFoodTruckBooking), at which point
// it flips to "booked" and both sides get a confirmation email -- the
// truck's confirmation asks them to reply with their logo for marketing.
//
// POST /.netlify/functions/food-truck-invite
// Auth: staff/owner session token (same scheme as every other admin action)
// Body: { token, leadId, leadName, leadEmail, date, time, priceCents, notes? }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { isFoodTruckDay, MAX_SLOTS_PER_DAY, countActiveSlots } = require('./_foodtruck-shared');
const { readBlob, writeBlob } = require('./_blobs');

const ADMIN_SECRET = process.env.ADMIN_SESSION_SECRET
  || ('qrr-session-' + (process.env.GITHUB_TOKEN || '').slice(-24));
const STAFF_SECRET = process.env.STAFF_SESSION_SECRET || '';
const SESSION_TTL_HOURS = 168;
const ALLOWED_ROLES = ['owner', 'events_staff'];

function hmac(s, secret) { return crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex'); }
// Verifies either an owner token ("<issued>.<sig>") or a staff token
// ("<issued>.<role>.<sig>") -- see verify-admin-password.js for the scheme.
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

function squareApi(method, path, body) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const payload = body ? JSON.stringify(body) : '';
  const opts = {
    hostname: host, path, method,
    headers: {
      'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Square-Version': '2024-12-18',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(Object.assign(new Error('Square ' + res.statusCode + ': ' + data), { status: res.statusCode, body: parsed }));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendGridEmail(to, subject, htmlBody) {
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map((e) => ({ email: e })) }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com' },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-food-truck-invite'],
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

function fmtMoney(cents) { return '$' + (cents / 100).toFixed(2); }

function inviteEmailHtml(leadName, date, time, priceCents, checkoutUrl) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px">' +
    '<h2 style="color:#2C1A0E">You\'re Invited: Food Truck at The Quarry!</h2>' +
    '<p>Hi ' + (leadName || 'there') + ',</p>' +
    '<p>We\'d love to have you set up as a food truck vendor at The Quarry. We have an opening for:</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Date:</b> ' + date + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + time + '</p>' +
    '<p style="margin:4px 0"><b>Spot fee:</b> ' + fmtMoney(priceCents) + '</p>' +
    '</div>' +
    '<p>To reserve this date, just complete payment here:</p>' +
    '<p style="text-align:center;margin:24px 0"><a href="' + checkoutUrl + '" style="background:#B8933A;color:#1A0E08;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Reserve &amp; Pay ' + fmtMoney(priceCents) + '</a></p>' +
    '<p>Once we receive payment you will be confirmed for this date. Questions? Just reply to this email.</p>' +
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

    const leadId = String(body.leadId || '').trim();
    const leadName = String(body.leadName || '').trim();
    const leadEmail = String(body.leadEmail || '').trim();
    const date = String(body.date || '').trim();
    const time = String(body.time || '').trim();
    const priceCents = parseInt(body.priceCents, 10);
    const notes = String(body.notes || '').trim();
    const isDessertOrJunkFood = !!body.isDessertOrJunkFood;

    if (!leadId || !leadName || !leadEmail) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'leadId, leadName, and leadEmail are required' }) };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'date must be YYYY-MM-DD' }) };
    if (!time) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'time is required' }) };
    if (!Number.isFinite(priceCents) || priceCents <= 0) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'priceCents must be a positive number' }) };
    if (!isFoodTruckDay(date)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Food trucks book Friday, Saturday, or Sunday only.' }) };

    const path = 'food-truck-bookings/' + date;
    const existing = (await readBlob(path)) || { bookings: [] };
    const bookings = existing.bookings || [];

    if (countActiveSlots(bookings) >= MAX_SLOTS_PER_DAY) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ ok: false, error: 'That date already has ' + MAX_SLOTS_PER_DAY + ' food truck slots filled.' }) };
    }
    if (bookings.some((b) => b.leadId === leadId && ['pending_payment', 'booked'].includes(b.status))) {
      return { statusCode: 409, headers: CORS, body: JSON.stringify({ ok: false, error: 'This lead is already invited or booked for this date.' }) };
    }

    const bookingId = crypto.randomUUID();
    const origin = event.headers.origin || 'https://thequarrystl.com';

    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: 'foodtruck-' + Date.now(),
        line_items: [{
          uid: 'foodtruck-line',
          name: 'Food Truck Spot - ' + leadName,
          note: date + ' at ' + time,
          quantity: '1',
          base_price_money: { amount: priceCents, currency: 'USD' },
        }],
        metadata: {
          bookingType: 'foodtruck',
          bookingId: bookingId,
          leadId: leadId,
          leadName: leadName.slice(0, 255),
          leadEmail: leadEmail.slice(0, 255),
          date: date,
          time: time.slice(0, 255),
        },
      },
      checkout_options: {
        redirect_url: origin + '/admin/?foodtruck=paid',
        ask_for_shipping_address: false,
        allow_tipping: false,
      },
      payment_note: 'Food Truck - ' + leadName + ' - ' + date + ' ' + time,
    };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) {
      linkRequest.pre_populated_data = { buyer_email: leadEmail };
    }

    let result;
    try {
      result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
    } catch (firstErr) {
      const msg = String(firstErr.message || '');
      if (linkRequest.pre_populated_data && /INVALID_EMAIL_ADDRESS/.test(msg)) {
        delete linkRequest.pre_populated_data;
        linkRequest.idempotency_key = crypto.randomUUID();
        result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
      } else {
        throw firstErr;
      }
    }
    const pl = result.payment_link || {};
    if (!pl.url) throw new Error('Square did not return a checkout URL');

    bookings.push({
      bookingId, leadId, leadName, leadEmail, date, time,
      priceCents, notes, isDessertOrJunkFood,
      status: 'pending_payment',
      invitedAt: new Date().toISOString(),
      checkoutUrl: pl.url,
      paymentLinkId: pl.id,
    });
    await writeBlob(path, { bookings });

    try {
      await sendGridEmail(
        leadEmail,
        "You're Invited: Food Truck at The Quarry - " + date,
        inviteEmailHtml(leadName, date, time, priceCents, pl.url),
      );
    } catch (emailErr) {
      console.error('food-truck invite email failed:', emailErr.message);
      // Booking + checkout link are already saved -- staff can share the link manually if the email bounced.
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, bookingId, checkoutUrl: pl.url }) };
  } catch (err) {
    console.error('food-truck-invite error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: String(err.message || err) }) };
  }
};
