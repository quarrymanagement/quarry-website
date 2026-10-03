// ============================================================================
// quarryfest-vendor-register.js
//
// Creates a Square hosted Checkout link for Quarry Fest ($25 flat vendor
// fee, Sat Nov 7 2026, 12-4pm). Not linked from anywhere on the public
// site -- staff email quarry-fest-vendors.html's URL directly to whoever
// emails asking about a vendor spot, per the owner's request that this stay
// off the public-facing site (unlike the Quarry Fest event listing itself,
// which IS public -- this page is vendor registration/payment only).
//
// Writes a "pending_payment" record to quarryfest-vendors/2026-11-07
// immediately on registration (before Square redirect), the same
// pending->booked pattern as food-truck-invite.js/square-webhook.js, so
// staff can see who started registering even if they never finish paying.
// square-webhook.js flips it to "booked" on a completed payment.
//
// Required env vars: SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
//
// Request body: { businessName, contactName, email, phone, notes }
// Response: { url: "https://checkout.square.site/..." }
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

const PRICE_CENTS = 2500; // $25 flat
const TAX_PERCENT = process.env.SQUARE_TAX_PERCENT || '7.45';
const EVENT_DATE = '2026-11-07';
const BOOKINGS_PATH = 'quarryfest-vendors/' + EVENT_DATE;

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
    const businessName = String(body.businessName || '').trim();
    const contactName = String(body.contactName || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const notes = String(body.notes || '').trim();

    if (!businessName || !contactName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Business name and contact name are required.' }) };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email address is required.' }) };

    const existing = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
    const vendors = existing.vendors || [];

    // Soft duplicate guard -- if this email already has a paid spot, don't
    // let them pay twice by accident.
    const already = vendors.find((v) => v.email.toLowerCase() === email.toLowerCase() && v.status === 'booked');
    if (already) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: "You're already registered and paid for Quarry Fest! If you think this is a mistake, email management@thequarrystl.com." }) };
    }

    const vendorId = crypto.randomUUID();
    vendors.push({
      vendorId, businessName, contactName, email, phone, notes,
      status: 'pending_payment',
      registeredAt: new Date().toISOString(),
    });
    await writeBlob(BOOKINGS_PATH, { vendors });

    const origin = event.headers.origin || 'https://thequarrystl.com';

    const safeMeta = {
      bookingType: 'quarryfest_vendor',
      vendorId,
      businessName: businessName.slice(0, 255),
      contactName: contactName.slice(0, 255),
      customerEmail: email.slice(0, 255),
      customerPhone: phone.slice(0, 255),
    };
    Object.keys(safeMeta).forEach((k) => { if (!safeMeta[k]) delete safeMeta[k]; });

    const prePop = {};
    if (email) prePop.buyer_email = email;
    const e164Phone = toE164(phone);
    if (e164Phone) prePop.buyer_phone_number = e164Phone;

    const taxUid = 'mo-sales-tax';
    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: 'quarryfest-' + vendorId.slice(0, 8),
        line_items: [{
          uid: 'quarryfest-vendor-line',
          name: ('Quarry Fest Vendor Fee - ' + businessName).slice(0, 255),
          note: businessName + ' - Sat Nov 7, 2026, 12-4pm',
          quantity: '1',
          base_price_money: { amount: PRICE_CENTS, currency: 'USD' },
          applied_taxes: [{ tax_uid: taxUid }],
        }],
        taxes: [{ uid: taxUid, name: 'MO Sales Tax', percentage: TAX_PERCENT, scope: 'LINE_ITEM', type: 'ADDITIVE' }],
        metadata: safeMeta,
      },
      checkout_options: {
        redirect_url: origin + '/quarry-fest-vendors.html?success=1',
        ask_for_shipping_address: false,
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: true, afterpay_clearpay: false },
        allow_tipping: false,
      },
      payment_note: 'Quarry Fest Vendor - ' + businessName,
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

    return { statusCode: 200, headers, body: JSON.stringify({ url: pl.url, paymentLinkId: pl.id, orderId: pl.order_id, vendorId }) };
  } catch (err) {
    console.error('quarryfest-vendor-register error:', err);
    const raw = String(err.message || err);
    let friendly = raw;
    if (err.status === 401 || /unauthorized/i.test(raw)) {
      friendly = 'Online registration is temporarily unavailable. Please email management@thequarrystl.com.';
    } else if (err.status === 400 || err.status === 422) {
      friendly = 'We could not start checkout. Please try again or email management@thequarrystl.com.';
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: friendly, _raw: raw }) };
  }
};
