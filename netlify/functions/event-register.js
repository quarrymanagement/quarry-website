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

// How many UNITS of this seating option have already been sold (a unit = one
// table, or one bar seat), counted from the registration log.
//
// A registration stores the total seats it bought (`qty`) and which option it
// bought (`seatingOptionId`), so units = qty / seats. That means someone who
// takes three 4-tops in one transaction correctly consumes three of them,
// without the webhook needing to record a separate unit count.
//
// Falls back gracefully for legacy registrations that predate seatingOptionId.
function countSeatingOptionUsed(evData, option) {
  const regs = Array.isArray(evData.registrations) ? evData.registrations : [];
  const id = String(option.id || option.name || '').trim().toLowerCase();
  const seats = parseInt(option.seats, 10) || 1;
  return regs.reduce(function(n, r) {
    const rid = String((r && (r.seatingOptionId || r.seatType)) || '').trim().toLowerCase();
    if (rid !== id) return n;
    const boughtSeats = parseInt(r.qty, 10) || seats;
    return n + Math.max(1, Math.round(boughtSeats / seats));
  }, 0);
}

// ---------------------------------------------------------------------------
// Arrival-time ("wave") helpers
// ---------------------------------------------------------------------------
// An event may stagger arrivals so the buffet and bar are not swamped:
//     "arrivalSlots": [
//       { "id": "w0830", "label": "8:30 AM", "capacity": 11,
//         "appliesTo": ["4-top-table"] }, ...
//     ]
// capacity is counted in UNITS (a unit = one table, or one bar seat), exactly
// like seatingOptions.available. appliesTo restricts which seatingOptions may
// choose that wave; omitted or empty means every option may.
// Events with no arrivalSlots are completely unaffected.

function getArrivalSlots(evData) {
  return Array.isArray(evData && evData.arrivalSlots) ? evData.arrivalSlots : [];
}

function findArrivalSlot(evData, slotId) {
  const want = String(slotId || '').trim().toLowerCase();
  if (!want) return null;
  return getArrivalSlots(evData).find(function(s) {
    return String(s.id || '').trim().toLowerCase() === want;
  }) || null;
}

// May this seating option book this wave? No appliesTo (or an empty one) means
// the wave is open to everybody.
function arrivalSlotAllowsOption(slot, option) {
  const applies = (Array.isArray(slot && slot.appliesTo) ? slot.appliesTo : [])
    .map(function(a) { return String(a || '').trim().toLowerCase(); })
    .filter(function(a) { return a !== ''; });
  if (!applies.length) return true;
  if (!option) return true;
  const id = String(option.id || '').trim().toLowerCase();
  const nm = String(option.name || '').trim().toLowerCase();
  return applies.indexOf(id) !== -1 || (nm !== '' && applies.indexOf(nm) !== -1);
}

// How many UNITS of a wave are already taken, derived from the registration
// log so it can never drift. Each registration consumes
// round(qty / seatsOfItsOwnSeatingOption) units, mirroring
// countSeatingOptionUsed. Registrations with no arrivalSlot (anything booked
// before waves existed) count toward nothing.
function countArrivalSlotUsed(evData, slot) {
  const regs = Array.isArray(evData.registrations) ? evData.registrations : [];
  const want = String((slot && slot.id) || '').trim().toLowerCase();
  if (!want) return 0;
  return regs.reduce(function(n, r) {
    const rid = String((r && r.arrivalSlot) || '').trim().toLowerCase();
    if (!rid || rid !== want) return n;
    const regOpt = findSeatingOption(evData, (r.seatingOptionId || r.seatType));
    const seats = parseInt(regOpt && regOpt.seats, 10) || 1;
    const boughtSeats = parseInt(r.qty, 10) || seats;
    return n + Math.max(1, Math.round(boughtSeats / seats));
  }, 0);
}

// Fetch events.json straight from the repo via the authenticated Contents API,
// so checkout always prices against the current data rather than whatever was
// baked into the last Netlify build. Falls back to the deployed copy on failure,
// because a stale price is still better than a dead checkout.
function fetchEventsData(siteUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return fetchJSON(siteUrl + '/events.json');
  return new Promise(function(resolve) {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/quarrymanagement/quarry-website/contents/events.json',
      method: 'GET',
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Event-Register',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          const meta = JSON.parse(data);
          if (meta && meta.content && meta.encoding === 'base64') {
            return resolve(JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')));
          }
        } catch (e) { /* fall through */ }
        // Contents API omits `content` for files over 1MB; fall back to the site copy.
        fetchJSON(siteUrl + '/events.json').then(resolve, function() { resolve({ events: [] }); });
      });
    });
    req.on('error', function() {
      fetchJSON(siteUrl + '/events.json').then(resolve, function() { resolve({ events: [] }); });
    });
    req.end();
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
    const additionalGuestName = body.additionalGuestName || '';
    const partySize = body.partySize || 1;
    const seatType = body.seatType;
    const tableId = body.tableId || '';
    const ticketTier = body.ticketTier || '';
    const couponCode = body.couponCode || '';
    const successUrl = body.successUrl;
    const cancelUrl = body.cancelUrl;
    const seatingOptionId = body.seatingOptionId || '';
    // Optional: staggered arrival wave, for events that define arrivalSlots.
    const arrivalSlotId = body.arrivalSlot || '';
    // Optional: multi-line cart for events that mix tiers in one checkout
    const lineItemsIn = Array.isArray(body.lineItems) ? body.lineItems : null;

    if (!eventId || !name || !email || !seatType) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Fetch event data
    const siteUrl = process.env.URL || 'https://thequarrystl.com';
    // Read events.json from GitHub, NOT from the deployed site.
    //
    // netlify.toml skips the build when only data JSON changes (build-ignore.sh),
    // so the copy Netlify serves at /events.json can be arbitrarily out of date.
    // That meant an admin edit — a price, a capacity, a table count, an arrival
    // wave — was invisible to checkout until some unrelated code change happened
    // to trigger a rebuild. Prices could be charged from a stale file.
    //
    // The Contents API is authenticated, so this also keeps working if the repo
    // is ever made private. Falls back to the site copy if GitHub is unreachable.
    const allData = await fetchEventsData(siteUrl);
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
    let units = Math.max(1, parseInt(body.units, 10) || 1);
    if (Array.isArray(evData.seatingOptions) && evData.seatingOptions.length > 0) {
      if (!seatingOptionId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose a table size.' }) };
      }
      chosenOption = findSeatingOption(evData, seatingOptionId);
      if (!chosenOption) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown table option: ' + seatingOptionId }) };
      }

      const seats = parseInt(chosenOption.seats, 10) || 1;
      // A guest may take more than one of the same thing (e.g. three 4-tops).
      // maxUnits caps how many per transaction; absent means no extra cap.
      const maxUnits = parseInt(chosenOption.maxUnits, 10) || 0;
      if (maxUnits > 0 && units > maxUnits) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'You can book at most ' + maxUnits + ' of these at a time. Please call us for larger groups.' }) };
      }
      const requiredSeats = seats * units;

      // ---- Per-option pricing -------------------------------------------
      // When the option carries its own pricePerSeat, that price wins and the
      // tier split does not apply — used when the price depends on WHERE you
      // sit (a $30 bar seat vs a $25 seat at a table) rather than on what kind
      // of guest you are.
      if (chosenOption.pricePerSeat) {
        qty = requiredSeats;
      } else if (qty !== requiredSeats) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'Please assign all ' + requiredSeats + ' seat' + (requiredSeats === 1 ? '' : 's') + '. You have assigned ' + qty + '.' })
        };
      }

      // available === null/undefined means "unlimited"; 0 means none left.
      if (chosenOption.available !== undefined && chosenOption.available !== null && chosenOption.available !== '') {
        const cap = parseInt(chosenOption.available, 10) || 0;
        const used = countSeatingOptionUsed(evData, chosenOption);
        const left = cap - used;
        if (left <= 0) {
          return {
            statusCode: 409, headers,
            body: JSON.stringify({ error: 'Sorry — all ' + (chosenOption.name || 'tables of this size') + ' are taken. Please choose another option.' })
          };
        }
        if (units > left) {
          return {
            statusCode: 409, headers,
            body: JSON.stringify({ error: 'Only ' + left + ' x ' + (chosenOption.name || 'of these') + ' left — please reduce how many you are booking.' })
          };
        }
      }
    }

    // ---- ARRIVAL WAVE VALIDATION + PER-WAVE INVENTORY --------------------
    // Only enforced for events that actually define arrivalSlots, so every
    // existing event keeps working exactly as before.
    let chosenArrivalSlot = null;
    const arrivalSlots = getArrivalSlots(evData);
    if (arrivalSlots.length > 0) {
      if (!arrivalSlotId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose an arrival time.' }) };
      }
      chosenArrivalSlot = findArrivalSlot(evData, arrivalSlotId);
      if (!chosenArrivalSlot) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown arrival time: ' + arrivalSlotId }) };
      }
      if (!arrivalSlotAllowsOption(chosenArrivalSlot, chosenOption)) {
        const allowedLabels = arrivalSlots.filter(function(s) {
          return arrivalSlotAllowsOption(s, chosenOption);
        }).map(function(s) { return String(s.label || s.id || ''); });
        const what = (chosenOption && chosenOption.name) ? (chosenOption.name + 's') : 'That seating option';
        const msg = allowedLabels.length
          ? (what + ' are only available at the ' + allowedLabels.join(' or ') + ' arrival.')
          : (what + ' cannot be booked at any arrival time. Please call us on (636) 224-8257.');
        return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
      }
      // capacity null/undefined/'' means "unlimited"; 0 means none available.
      if (chosenArrivalSlot.capacity !== undefined && chosenArrivalSlot.capacity !== null && chosenArrivalSlot.capacity !== '') {
        const slotCap = parseInt(chosenArrivalSlot.capacity, 10) || 0;
        const slotUsed = countArrivalSlotUsed(evData, chosenArrivalSlot);
        const slotLeft = slotCap - slotUsed;
        // Booking three tables needs three free unit slots in the wave.
        if (slotLeft < units) {
          return {
            statusCode: 409, headers,
            body: JSON.stringify({ error: 'That arrival time is full \u2014 please pick another.' })
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

    if (chosenOption && chosenOption.pricePerSeat) {
      // Per-option pricing: one Square line per unit booked, priced at
      // seats x pricePerSeat. A guest taking three 4-tops at $25/seat sees
      // "3 x 4-Top Table" at $100 each.
      const seats = parseInt(chosenOption.seats, 10) || 1;
      const perUnit = (parseInt(chosenOption.pricePerSeat, 10) || 0) * seats;
      if (perUnit <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not determine ticket price' }) };
      }
      tierName = chosenOption.name || evData.name;
      squareLineItems.push({
        name: (chosenOption.name || 'Seat') + ' - ' + (evData.name || ''),
        note: (evData.date || '') + ' at The Quarry',
        quantity: String(units),
        base_price_money: { amount: perUnit, currency: 'USD' }
      });
    } else if (lineItemsIn && lineItemsIn.length) {
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
    const tierSummary = (chosenOption && chosenOption.pricePerSeat)
      ? (units + 'x ' + (chosenOption.name || ''))
      : (lineItemsIn && lineItemsIn.length)
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
      // Staggered arrival wave. The webhook must record arrivalSlot on the
      // registration, otherwise per-wave inventory cannot be counted back.
      arrivalSlot: String(chosenArrivalSlot ? (chosenArrivalSlot.id || '') : '').slice(0, 60),
      arrivalLabel: String(chosenArrivalSlot ? (chosenArrivalSlot.label || '') : '').slice(0, 60),
      ticketTier: String(tierSummary).slice(0, 255),
      couponCode: String(couponCode).slice(0, 60)
    };
    // Square rejects empty-string metadata values with MISSING_REQUIRED_PARAMETER,
    // AND caps an order at 10 metadata entries (ARRAY_LENGTH_TOO_LONG). Strip the
    // empties first, then, if we are still over the cap, drop the least important
    // keys until we fit. Order matters: everything the Square webhook needs to
    // record a registration must survive.
    const META_PRIORITY = [
      'bookingType',        // how the webhook classifies the payment
      'eventId',            // exact event match
      'customerName',
      'customerEmail',
      'seatingOptionId',    // per-size inventory depends on this
      'arrivalSlot',        // per-wave inventory depends on this
      'partySize',
      'seatType',
      'customerPhone',   // wanted for follow-up marketing - keep above ticketTier
      'ticketTier',
      'guestName',
      'couponCode',
      'tableId',
      'seatingOptionName',  // cosmetic - derivable from seatingOptionId
      'arrivalLabel',       // cosmetic - derivable from arrivalSlot
      'eventName'           // derivable from eventId
    ];
    const SQUARE_META_MAX = 10;

    const present = {};
    Object.keys(rawMeta).forEach(function(k) {
      const v = rawMeta[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        present[k] = String(v);
      }
    });

    const ordered = Object.keys(present).sort(function(a, b) {
      const ia = META_PRIORITY.indexOf(a); const ib = META_PRIORITY.indexOf(b);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });

    const safeMeta = {};
    ordered.slice(0, SQUARE_META_MAX).forEach(function(k) { safeMeta[k] = present[k]; });

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
      // The arrival label is inserted BEFORE the trailing " xN" so the
      // quantity stays at the very end of the string, where the regex expects.
      payment_note: 'Event - ' + (evData.name || '')
        + ((chosenArrivalSlot && chosenArrivalSlot.label) ? ' - ' + chosenArrivalSlot.label + ' arrival' : '')
        + ' x' + qty
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
