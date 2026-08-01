// ============================================================================
// event-register.js
//
// Handles event ticket purchases. Powered by Square Checkout.
// Response shape preserved for the front-end:  { checkoutUrl, sessionId }
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_LOCATION_ID, SQUARE_ENVIRONMENT
//
// Supports three checkout shapes:
//   (a) Single-tier:  body = { ticketTier, partySize, ... }
//   (b) Multi-tier:   body = { lineItems: [{ tierName, qty }, ...], ... }
//       Used when one transaction covers mixed tiers, e.g. the Poker Run
//       (1 driver + N passengers). Server validates each tierName against
//       events.json so the client cannot tamper with prices.
//   (c) Table booking (added 2026-07-31):
//       body = { seatingOptionId, lineItems: [{ tierName, qty }, ...], ... }
//       The guest picks a table size (2/4/6/8-top, bar seat, ...) and splits
//       those seats across price tiers — e.g. a 4-top with 2 x "Brunch +
//       Bottomless" and 2 x "Brunch Only". The server checks that:
//         - the seatingOptionId is a real option on the event
//         - the line item quantities sum to exactly that option's seat count
//         - that table size is not already sold out
//
// PER-SIZE INVENTORY
// Availability for a seating option is DERIVED from the event's registration
// log rather than stored as a counter, so it can never drift out of sync:
//     used  = number of paid registrations carrying that seatingOptionId
//     left  = option.available - used
// The Square webhook records seatingOptionId on each registration, taken from
// the order metadata this function sets below.
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
function normalizePhoneE164(raw) {
  if (!raw) return undefined;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length > 11 && digits.length <= 15) return '+' + digits; // international fallback
  return undefined;
}

// Pass email to Square's pre-populated buyer email only if it passes a basic format check.
function safeBuyerEmail(raw) {
  if (!raw) return undefined;
  const e = String(raw).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return undefined;
  return e;
}

// ---------------------------------------------------------------------------
// Seating option helpers
// ---------------------------------------------------------------------------

function findSeatingOption(evData, optionId) {
  const opts = Array.isArray(evData.seatingOptions) ? evData.seatingOptions : [];
  if (!opts.length) return null;
  const want = String(optionId || '').trim().toLowerCase();
  if (!want) return null;
  // Match on id first, then fall back to the display name, so a client that
  // sends either one still resolves to the right option.
  return opts.find(function(o) {
    return String(o.id || '').trim().toLowerCase() === want;
  }) || opts.find(function(o) {
    return String(o.name || '').trim().toLowerCase() === want;
  }) || null;
}

// How many of this seating option have already been sold, counted from the
// registration log. Falls back gracefully for legacy registrations that predate
// the seatingOptionId field.
function countSeatingOptionUsed(evData, option) {
  const regs = Array.isArray(evData.registrations) ? evData.registrations : [];
  const id = String(option.id || option.name || '').trim().toLowerCase();
  return regs.reduce(function(n, r) {
    const rid = String((r && (r.seatingOptionId || r.seatType)) || '').trim().toLowerCase();
    return rid === id ? n + 1 : n;
  }, 0);
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
    const seatingOptionId = body.seatingOptionId || '';
    // Optional: multi-line cart for events that mix tiers in one checkout
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

    // ---- SEATING OPTION VALIDATION + PER-SIZE INVENTORY ------------------
    // Only enforced for events that actually define seatingOptions, so every
    // existing event keeps working exactly as before.
    let chosenOption = null;
    if (Array.isArray(evData.seatingOptions) && evData.seatingOptions.length > 0) {
      if (!seatingOptionId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose a table size.' }) };
      }
      chosenOption = findSeatingOption(evData, seatingOptionId);
      if (!chosenOption) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown table option: ' + seatingOptionId }) };
      }

      const seats = parseInt(chosenOption.seats, 10) || 1;
      if (qty !== seats) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'Please assign all ' + seats + ' seat' + (seats === 1 ? '' : 's') + ' at this ' + (chosenOption.name || 'table') + '. You have assigned ' + qty + '.' })
        };
      }

      // available === null/undefined means "unlimited"; 0 means none left.
      if (chosenOption.available !== undefined && chosenOption.available !== null && chosenOption.available !== '') {
        const cap = parseInt(chosenOption.available, 10) || 0;
        const used = countSeatingOptionUsed(evData, chosenOption);
        if (used >= cap) {
          return {
            statusCode: 409, headers,
            body: JSON.stringify({ error: 'Sorry — all ' + (chosenOption.name || 'tables of this size') + ' are taken. Please choose another size.' })
          };
        }
      }
    }

    const remaining = (evData.totalCapacity || 0) - (evData.registeredCount || 0);
    if (evData.totalCapacity && remaining < qty) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Not enough seats. Only ' + remaining + ' remaining.' }) };
    }

    // Build the Square line_items array.
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
        if (!matched) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown ticket tier: ' + tName }) };
        }
        // A $0 tier is legitimate (e.g. a free kids' seat at a paid table), but
        // the whole order still has to come to something payable — checked below.
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
      const orderTotal = squareLineItems.reduce(function(s, li) {
        return s + (li.base_price_money.amount * parseInt(li.quantity, 10));
      }, 0);
      if (orderTotal <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not determine ticket price' }) };
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
      // New: which table size was bought. The Square webhook reads this back to
      // keep per-size inventory honest.
      seatingOptionId: String(chosenOption ? (chosenOption.id || chosenOption.name) : '').slice(0, 60),
      seatingOptionName: String(chosenOption ? (chosenOption.name || '') : '').slice(0, 120),
      ticketTier: String(tierSummary).slice(0, 255),
      couponCode: String(couponCode).slice(0, 60)
    };
    // Square rejects empty-string metadata values with MISSING_REQUIRED_PARAMETER.
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
      // NOTE: the Square webhook parses this string. It matches /x(\d+)\s*$/ to
      // read the quantity, so the "xN" MUST stay at the very end.
      payment_note: 'Event - ' + (evData.name || '') + ' x' + qty
    };

    let result;
    try {
      result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
    } catch (e1) {
      const m1 = String((e1 && (e1.body ? JSON.stringify(e1.body) : e1.message)) || e1);
      if (/INVALID_PHONE_NUMBER|INVALID_EMAIL_ADDRESS|INVALID_EMAIL|pre_populated/i.test(m1)) {
        delete linkRequest.pre_populated_data;
        result = await squareApi('POST', '/v2/online-checkout/payment-links', linkRequest);
      } else {
        throw e1;
      }
    }
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
