// ============================================================================
// event-register.js
//
// Handles event ticket purchases. Powered by Square Checkout.
// Response shape preserved for the front-end:  { checkoutUrl, sessionId }
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
//
// Supports two checkout shapes:
//   (a) Single-tier:  body = { ticketTier, partySize, ... }
//   (b) Multi-tier:   body = { lineItems: [{ tierName, qty }, ...], ... }
//       Used when one transaction covers mixed tiers, e.g. the Poker Run
//       (1 driver + N passengers). Server validates each tierName against
//       events.json so the client cannot tamper with prices.
// ============================================================================

const https = require('https');
const crypto = require('crypto');

// Coupon table (manual - Square does not have native promo codes for hosted checkout)
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

// Normalize US phone numbers to E.164 (+1XXXXXXXXXX) for Square's strict validator.
// Returns undefined if the input can't be confidently normalized — better to drop
// the optional pre-populated phone than fail the whole checkout.
function normalizePhoneE164(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 11 && digits.length <= 15) return '+' + digits; // international fallback
  return undefined;
}

// Pass email to Square's pre-populated buyer email only if it passes a basic format check.
// Square's strict validator will 400 the whole request on a marginal email. Dropping it
// just means the customer types it again on the Square checkout page (still required).
function safeBuyerEmail(raw) {
  if (!raw) return undefined;
  const e = String(raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return undefined;
  return e;
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
    const additionalGuestName = body.additionalGuestName || '';
    const partySize = body.partySize || 1;
    const seatType = body.seatType;
    const tableId = body.tableId || '';
    const ticketTier = body.ticketTier || '';
    const couponCode = body.couponCode || '';
    const successUrl = body.successUrl;
    const cancelUrl = body.cancelUrl;
    // Optional: multi-line cart for events that mix tiers in one checkout
    // (e.g., Poker Run: 1 driver + N passengers). Each item: { tierName, qty }
    // When present, this bypasses the single-tier lookup below.
    const lineItemsIn = Array.isArray(body.lineItems) ? body.lineItems : null;

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
    // Total quantity = sum of line item qtys if provided, otherwise partySize
    let qty = partySize || 1;
    if (lineItemsIn && lineItemsIn.length) {
      qty = lineItemsIn.reduce(function(s, li) { return s + (parseInt(li.qty, 10) || 0); }, 0) || 1;
    }
    const remaining = (evData.totalCapacity || 0) - (evData.registeredCount || 0);
    if (evData.totalCapacity && remaining < qty) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Not enough seats. Only ' + remaining + ' remaining.' }) };
    }

    // Build the Square line_items array.
    // Two paths: (a) caller-supplied lineItems for mixed-tier carts, (b) single-tier fallback.
    let squareLineItems = [];
    let tierName = evData.name;
    let unitPrice = evData.pricePerSeat || evData.price || 0;
    let effectiveUnitPrice = unitPrice;

    if (lineItemsIn && lineItemsIn.length) {
      // Validate each line item against the event tier table to prevent client-side price tampering.
      const tierMap = {};
      (evData.tiers || []).forEach(function(t) { tierMap[String(t.name).toLowerCase()] = t; });
      for (let i = 0; i < lineItemsIn.length; i++) {
        const li = lineItemsIn[i];
        const liQty = parseInt(li.qty, 10) || 0;
        if (liQty <= 0) continue;
        const tName = String(li.tierName || '').trim();
        const matched = tierMap[tName.toLowerCase()];
        // Server-side price = the event tier price; ignore any amount the client sent.
        const liPrice = matched ? (matched.pricePerPerson || 0) : 0;
        if (!matched || liPrice <= 0) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown ticket tier: ' + tName }) };
        }
        squareLineItems.push({
          name: matched.name + ' - ' + (evData.name || ''),
          note: (evData.date || '') + ' at The Quarry',
          quantity: String(liQty),
          base_price_money: { amount: liPrice, currency: 'USD' }
        });
      }
      if (squareLineItems.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid line items provided' }) };
      }
      // For metadata/payment_note labeling
      tierName = squareLineItems.map(function(li){ return li.quantity + 'x ' + li.name.split(' - ')[0]; }).join(', ');
    } else {
      // Single-tier path (legacy behavior)
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
      effectiveUnitPrice = unitPrice;
      if (couponCode) {
        const code = couponCode.toUpperCase().trim();
        const c = EVENT_COUPONS[code];
        if (c) {
          effectiveUnitPrice = c.pct !== undefined
            ? Math.round(unitPrice * (1 - c.pct / 100))
            : Math.max(0, unitPrice - c.flat);
        }
      }
      squareLineItems.push({
        name: tierName + ' - ' + (evData.name || ''),
        note: (evData.date || '') + ' at The Quarry',
        quantity: String(qty),
        base_price_money: { amount: effectiveUnitPrice, currency: 'USD' }
      });
    }

    // Build Square Payment Link
    // For multi-tier carts, summarize the breakdown in ticketTier metadata
    const tierSummary = (lineItemsIn && lineItemsIn.length)
      ? squareLineItems.map(function(li){ return li.quantity + 'x ' + li.name.split(' - ')[0]; }).join(' + ')
      : ticketTier;

    const rawMeta = {
      bookingType: 'event',
      eventId: String(eventId).slice(0, 255),
      eventName: String(evData.name || '').slice(0, 255),
      customerName: String(name).slice(0, 255),
      customerEmail: String(email).slice(0, 255),
      customerPhone: String(phone).slice(0, 255),
      guestName: String(additionalGuestName).slice(0, 255),
      partySize: String(qty),
      seatType: String(seatType).slice(0, 60),
      tableId: String(tableId).slice(0, 60),
      ticketTier: String(tierSummary).slice(0, 255),
      couponCode: String(couponCode).slice(0, 60)
    };
    // Square rejects empty-string metadata values with MISSING_REQUIRED_PARAMETER.
    // Strip any key whose value is empty/whitespace before sending.
    const safeMeta = {};
    Object.keys(rawMeta).forEach(function(k) {
      const v = rawMeta[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        safeMeta[k] = String(v);
      }
    });

    const linkRequest = {
      idempotency_key: crypto.randomUUID(),
      order: {
        location_id: process.env.SQUARE_LOCATION_ID,
        reference_id: ('e-' + crypto.createHash('md5').update(String(eventId)).digest('hex').slice(0,8) + '-' + Date.now()).slice(0,40),
        line_items: squareLineItems,
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
        buyer_email: safeBuyerEmail(email) || undefined,
        buyer_phone_number: normalizePhoneE164(phone) || undefined
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
