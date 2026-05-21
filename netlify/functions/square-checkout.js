// ============================================================================
// square-checkout.js
//
// Creates a Square hosted Checkout link for golf bay reservations.
// Replaces the old Stripe create-checkout.js.
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT (production)
//
// Request body:
//   { amount: <cents>, coupon?: "CODE", metadata: { customerName, ... } }
//
// Response:
//   { url: "https://checkout.square.site/..." } - drop straight into window.location.href
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const _blobs = require('./_blobs');

// ---- Coupon table (preserved from Stripe version) -------------------------
const COUPONS = {
  'QUARRY10': { pct: 10 },
  'QUARRY20': { pct: 20 },
  'GOLF50':   { pct: 50 },
  'TESTCODE': { flat: 500 },
  'TEST1':    { flat: 5900 },
  'ADMIN100': { pct: 100 },
};

// Sales tax (Missouri / New Melle - configurable via env var)
const TAX_PERCENT = process.env.SQUARE_TAX_PERCENT || '7.45';

// ---- Square API helper ----------------------------------------------------
function squareApi(method, path, body) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const payload = body ? JSON.stringify(body) : '';
  const opts = {
    hostname: host,
    path: path,
    method: method,
    headers: {
      'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Square-Version': '2024-12-18',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  return new Promise(function(resolve, reject) {
    const req = https.request(opts, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
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

// ---- SendGrid email helper (for $0 / free comp flow) ----------------------
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'bookings@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(email) { return { email: email }; }) }],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: 'management@thequarrystl.com' },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-golf-booking']
  });
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function(res) {
      let body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: body });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---- Handler --------------------------------------------------------------
exports.handler = async function(event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    let amountCents = body.amount || 4000;

    // Apply coupon
    if (body.coupon) {
      const code = body.coupon.toUpperCase().trim();
      const c = COUPONS[code];
      if (!c) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Coupon not found: ' + code }) };
      amountCents = c.pct !== undefined
        ? Math.round(amountCents * (1 - c.pct / 100))
        : Math.max(0, amountCents - c.flat);
    }

    const m = body.metadata || {};
    const origin = event.headers.origin || 'https://thequarrystl.com';

    // $0 fully comped booking: skip Square entirely, store + email directly
    if (amountCents === 0) {
      await storeBookingDirect(m);
      try { await sendGridEmail('management@thequarrystl.com', 'New Comped Golf Booking - ' + (m.bay||'Bay'), buildOwnerHtml(m, '$0.00')); } catch(_) {}
      if (m.customerEmail) {
        try { await sendGridEmail(m.customerEmail, 'Your Golf Booking is Confirmed - The Quarry', buildCustomerHtml(m, '$0.00')); } catch(_) {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ free: true }) };
    }

    // ---- Build Square Payment Link request ------------------------------
    // We use the "order" mode so we can attach metadata that survives to the webhook.
    // Metadata keys must be alphanumeric + underscore, value is a string up to 255 chars.
    const safeMeta = {
      bookingType:     'golf',
      customerName:    String(m.customerName || '').slice(0, 255),
      customerEmail:   String(m.customerEmail || '').slice(0, 255),
      customerPhone:   String(m.customerPhone || '').slice(0, 255),
      bay:             String(m.bay || '').slice(0, 255),
      eventDate:       String(m.date || '').slice(0, 255),
      eventTime:       String(m.time || '').slice(0, 255),
      duration:        String(m.duration || '50 Minutes').slice(0, 255),
      players:         String(m.players || '').slice(0, 255),
      extraBalls:      String(m.extraBalls || 0),
      extraBallsPrice: String(m.extraBallsPrice || 0),
      coupon:          String(body.coupon || '').slice(0, 60),
    };

    const taxUid = 'mo-sales-tax';
    const lineItemUid = 'golf-bay-line';
    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: 'golf-' + Date.now(),
        line_items: [{
          uid: lineItemUid,
          name: 'Hole-In-One Golf - ' + (m.bay || 'Bay'),
          note: (m.date || '') + ' at ' + (m.time || '') + ' | ' + (m.duration || '50 min') + ' | ' + (m.players || '2') + ' players',
          quantity: '1',
          base_price_money: { amount: amountCents, currency: 'USD' },
          applied_taxes: [{ tax_uid: taxUid }]
        }],
        taxes: [{
          uid: taxUid,
          name: 'MO Sales Tax',
          percentage: TAX_PERCENT,
          scope: 'LINE_ITEM',
          type: 'ADDITIVE'
        }],
        metadata: safeMeta
      },
      checkout_options: {
        redirect_url: origin + '/quarry-golf.html?success=1',
        ask_for_shipping_address: false,
        accepted_payment_methods: {
          apple_pay: true,
          google_pay: true,
          cash_app_pay: true,
          afterpay_clearpay: false
        },
        allow_tipping: false
      },
      pre_populated_data: {
        buyer_email: m.customerEmail || undefined,
        buyer_phone_number: m.customerPhone || undefined
      },
      payment_note: 'Hole-In-One Golf - ' + (m.bay || 'Bay') + ' - ' + (m.date || '') + ' ' + (m.time || '')
    };

    const result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
    const pl = result.payment_link || {};
    if (!pl.url) throw new Error('Square did not return a checkout URL');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        url: pl.url,
        paymentLinkId: pl.id,
        orderId: pl.order_id
      })
    };

  } catch (err) {
    console.error('square-checkout error:', err);
    const raw = String(err.message || err);
    let friendly = raw;
    if (err.status === 401 || /unauthorized/i.test(raw)) {
      friendly = 'Online booking is temporarily unavailable. Please call (636) 224-8257 or email management@thequarrystl.com to reserve a bay - we will get you on the calendar right away.';
    } else if (err.status === 400 || err.status === 422) {
      friendly = 'We could not start checkout. Please try again or call (636) 224-8257.';
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: friendly, _raw: raw }) };
  }
};

// ---- Helpers for $0 comp flow (no Square checkout needed) -----------------
async function storeBookingDirect(m) {
  try {
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const path = 'golf-bookings/' + dateKey;
    const existing = await _blobs.readBlob(path);
    const bookings = (existing && existing.bookings) || [];
    bookings.push({
      bay: m.bay, time: m.time, date: m.date, dateKey,
      duration: m.duration || '50 Minutes', players: m.players, partySize: m.players,
      customerName: m.customerName, customerEmail: m.customerEmail, customerPhone: m.customerPhone,
      amountPaid: '$0.00', source: 'comp', bookedAt: new Date().toISOString()
    });
    await _blobs.writeBlob(path, { bookings });
  } catch(e) { console.error('storeBookingDirect:', e.message); }
}

function buildCustomerHtml(m, amount) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
    '<p>Hi ' + (m.customerName || 'there') + ', your bay is reserved.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Bay:</b> ' + (m.bay || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> ' + (m.date || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (m.time || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Duration:</b> ' + (m.duration || '50 Minutes') + '</p>' +
    '<p style="margin:4px 0"><b>Players:</b> ' + (m.players || '-') + '</p>' +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
    '<p>Arrive 10 minutes early. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

function buildOwnerHtml(m, amount) {
  return '<h2 style="color:#B8933A">New Comped Golf Booking</h2>' +
    '<p><b>Name:</b> ' + (m.customerName||'-') + '</p>' +
    '<p><b>Email:</b> ' + (m.customerEmail||'-') + '</p>' +
    '<p><b>Bay:</b> ' + (m.bay||'-') + '</p>' +
    '<p><b>Date:</b> ' + (m.date||'-') + '</p>' +
    '<p><b>Time:</b> ' + (m.time||'-') + '</p>' +
    '<p><b>Total:</b> ' + amount + '</p>';
}
