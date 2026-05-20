// ============================================================================
// event-register.js
//
// Handles event ticket purchases. Now powered by Square Checkout.
// Response shape preserved for the front-end:  { checkoutUrl, sessionId }
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
// ============================================================================

const https = require('https');
const crypto = require('crypto');

// Coupon table (manual - Square doesn't have native promo codes for hosted checkout)
const EVENT_COUPONS = {
  'QUARRY10': { pct: 10 },
  'QUARRY20': { pct: 20 },
  'TESTCODE': { flat: 500 },
  'ADMIN100': { pct: 100 },
};

function squareApi(method, path, body) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  const payload = body ? JSON.stringify(body) : '';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
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

function fetchJSON(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const eventId = body.eventId;
    const name = body.name;
    const email = body.email;
    const phone = body.phone || '';
    const partySize = body.partySize || 1;
    const seatType = body.seatType;
    const tableId = body.tableId || '';
    const ticketTier = body.ticketTier || '';
    const couponCode = body.couponCode || '';
    const successUrl = body.successUrl;
    const cancelUrl = body.cancelUrl;

    if (!eventId || !name || !email || !seatType) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Fetch event data
    const siteUrl = process.env.URL || 'https://thequarrystl.com';
    const allData = await fetchJSON(siteUrl + '/events.json');
    const events = allData.events || [];
    const evData = events.find(function(e) { return e.id === eventId; });

    if (!evData) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found: ' + eventId }) };
    }

    // Capacity check
    if (evData.status === 'sold-out') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Event is sold out' }) };
    }
    const remaining = (evData.totalCapacity || 0) - (evData.registeredCount || 0);
    const qty = partySize || 1;
    if (evData.totalCapacity && remaining < qty) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Not enough seats. Only ' + remaining + ' remaining.' }) };
    }

    // Price lookup
    let unitPrice = evData.pricePerSeat || evData.price || 0;
    let tierName = evData.name;
    if (ticketTier && evData.tiers && evData.tiers.length > 0) {
      const matchedTier = evData.tiers.find(function(t) { return t.name === ticketTier; });
      if (matchedTier) {
        unitPrice = matchedTier.pricePerPerson || unitPrice;
        tierName = matchedTier.name;
      }
    }
    if (!unitPrice || unitPrice <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not determine ticket price' }) };
    }

    // Apply coupon (server-side, on per-seat price)
    let effectiveUnitPrice = unitPrice;
    if (couponCode) {
      const code = couponCode.toUpperCase().trim();
      const c = EVENT_COUPONS[code];
      if (c) {
        effectiveUnitPrice = c.pct !== undefined
          ? Math.round(unitPrice * (1 - c.pct / 100))
          : Math.max(0, unitPrice - c.flat);
      }
    }

    // Build Square Payment Link
    const safeMeta = {
      bookingType: 'event',
      eventId: String(eventId).slice(0, 255),
      eventName: String(evData.name || '').slice(0, 255),
      customerName: String(name).slice(0, 255),
      customerEmail: String(email).slice(0, 255),
      customerPhone: String(phone).slice(0, 255),
      partySize: String(qty),
      seatType: String(seatType).slice(0, 60),
      tableId: String(tableId).slice(0, 60),
      ticketTier: String(ticketTier).slice(0, 255),
      couponCode: String(couponCode).slice(0, 60)
    };

    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: 'event-' + eventId + '-' + Date.now(),
        line_items: [{
          name: tierName + ' - ' + (evData.name || ''),
          note: (evData.date || '') + ' at The Quarry',
          quantity: String(qty),
          base_price_money: { amount: effectiveUnitPrice, currency: 'USD' }
        }],
        metadata: safeMeta
      },
      checkout_options: {
        redirect_url: (successUrl || siteUrl + '/quarry-events.html') + '?registration=success&event=' + eventId,
        ask_for_shipping_address: false,
        accepted_payment_methods: {
          apple_pay: true, google_pay: true, cash_app_pay: true
        },
        allow_tipping: false
      },
      pre_populated_data: {
        buyer_email: email,
        buyer_phone_number: phone || undefined
      },
      payment_note: 'Event - ' + (evData.name || '') + ' x' + qty
    };

    const result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
    const pl = result.payment_link || {};
    if (!pl.url) throw new Error('Square did not return a checkout URL');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        checkoutUrl: pl.url,
        sessionId: pl.id,
        orderId: pl.order_id
      })
    };

  } catch (err) {
    console.error('event-register error:', err);
    const raw = String(err.message || err);
    let friendly = raw;
    if (err.status === 401 || /unauthorized/i.test(raw)) {
      friendly = 'Online registration is temporarily unavailable. Please call (636) 224-8257.';
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: friendly, _raw: raw }) };
  }
};
