// ============================================================================
// pavilion-checkout.js
//
// Creates a Square hosted Checkout link for pavilion rentals. Not linked
// from anywhere on the site -- staff send quarry-pavilions.html directly to
// anyone who asks about renting one, per the owner's request that this stay
// off the public-facing site so people can't just discover and book a
// pavilion on their own.
//
// Flat $100 for a 4-hour block, includes a server. Open Wednesday-Sunday
// only (matches the venue's own open days), and refuses any date with a
// wedding already booked (checked here again, not just client-side, so a
// direct API call can't book around the UI's own check) --
// pavilion-availability.js is the shared source of truth for both.
//
// Required env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
//
// Request body: { pavilion: "1".."6", date: "YYYY-MM-DD", time: "11:00 AM",
//                  customerName, customerEmail, customerPhone }
// Response: { url: "https://checkout.square.site/..." }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { isDateBookable, isSlotTaken } = require('./_pavilion-shared');

const PRICE_CENTS = 10000; // $100 flat
const TAX_PERCENT = process.env.SQUARE_TAX_PERCENT || '7.45';

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

function toE164(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
  return null;
}

exports.handler = async function (event) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const m = body.metadata || {};
    const pavilion = String(m.pavilion || '').trim();
    const date = String(m.date || '').trim();
    const time = String(m.time || '').trim();

    if (!pavilion || !/^[1-6]$/.test(pavilion)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'pavilion must be 1-6' }) };
    if (!date || !time) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date and time required' }) };

    const bookable = await isDateBookable(date);
    if (!bookable.ok) return { statusCode: 409, headers, body: JSON.stringify({ error: bookable.reason }) };

    const taken = await isSlotTaken(date, pavilion, time);
    if (taken) return { statusCode: 409, headers, body: JSON.stringify({ error: 'That pavilion is already booked for that time. Please pick another.' }) };

    const origin = event.headers.origin || 'https://thequarrystl.com';

    const safeMeta = {
      bookingType:   'pavilion',
      pavilion:      pavilion,
      eventDate:     date.slice(0, 255),
      eventTime:     time.slice(0, 255),
      customerName:  String(m.customerName || '').slice(0, 255),
      customerEmail: String(m.customerEmail || '').slice(0, 255),
      customerPhone: String(m.customerPhone || '').slice(0, 255),
    };
    Object.keys(safeMeta).forEach((k) => { if (!safeMeta[k]) delete safeMeta[k]; });

    const prePop = {};
    const email = String(m.customerEmail || '').trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) prePop.buyer_email = email;
    const e164Phone = toE164(m.customerPhone);
    if (e164Phone) prePop.buyer_phone_number = e164Phone;

    const taxUid = 'mo-sales-tax';
    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: 'pavilion-' + Date.now(),
        line_items: [{
          uid: 'pavilion-line',
          name: 'Pavilion ' + pavilion + ' Rental',
          note: date + ' at ' + time + ' | 4 hours | includes a server',
          quantity: '1',
          base_price_money: { amount: PRICE_CENTS, currency: 'USD' },
          applied_taxes: [{ tax_uid: taxUid }],
        }],
        taxes: [{ uid: taxUid, name: 'MO Sales Tax', percentage: TAX_PERCENT, scope: 'LINE_ITEM', type: 'ADDITIVE' }],
        metadata: safeMeta,
      },
      checkout_options: {
        redirect_url: origin + '/quarry-pavilions.html?success=1',
        ask_for_shipping_address: false,
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false },
        allow_tipping: false,
      },
      payment_note: 'Pavilion ' + pavilion + ' - ' + date + ' ' + time,
    };
    if (Object.keys(prePop).length) linkRequest.pre_populated_data = prePop;

    let result;
    try {
      result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
    } catch (firstErr) {
      const msg = String(firstErr.message || '');
      if (linkRequest.pre_populated_data && /INVALID_PHONE_NUMBER|INVALID_EMAIL_ADDRESS/.test(msg)) {
        delete linkRequest.pre_populated_data;
        linkRequest.idempotency_key = crypto.randomUUID();
        result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
      } else {
        throw firstErr;
      }
    }
    const pl = result.payment_link || {};
    if (!pl.url) throw new Error('Square did not return a checkout URL');

    return { statusCode: 200, headers, body: JSON.stringify({ url: pl.url, paymentLinkId: pl.id, orderId: pl.order_id }) };
  } catch (err) {
    console.error('pavilion-checkout error:', err);
    const raw = String(err.message || err);
    let friendly = raw;
    if (err.status === 401 || /unauthorized/i.test(raw)) {
      friendly = 'Online booking is temporarily unavailable. Please call (636) 224-8257 or email management@thequarrystl.com.';
    } else if (err.status === 400 || err.status === 422) {
      friendly = 'We could not start checkout. Please try again or call (636) 224-8257.';
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: friendly, _raw: raw }) };
  }
};
