// ============================================================================
// event-payments-reconcile.js  (scheduled nightly — see netlify.toml)
//
// Covers three kinds of Square payment: event tickets ("Event - ..."), food
// truck fees ("Food Truck - ...") and Quarry Fest vendor fees ("Quarry Fest
// Vendor - ..."). Each is matched back to its record and marked paid if the
// webhook missed it.
//
// Safety net for event ticket sales. The Supabase square-webhook records each
// paid ticket in events.json, but a few payments have slipped through (e.g.
// Day of the Dead 9/8 and the Oct 15 wine club 10/2 were paid in Square but
// never showed on the website). This job asks Square directly for every
// completed "Event - ..." payment in the last 21 days and adds any that are
// missing from events.json, so the counts on the site and in the admin always
// match what was actually paid.
//
//   - Skips fully refunded payments.
//   - Never touches a payment already in registrations, refundedRegistrations
//     or the legacy top-level registrations map.
//   - Matches the event by the eventId event-register.js stores on the Square
//     order; falls back to an exact event-name match from the payment note.
//   - Does NOT email guests. Emails management@ a list of anything it added
//     (and anything it couldn't match) so nothing is fixed silently.
// ============================================================================

const fetch = require('node-fetch');
const { readBlob, writeBlob } = require('./_blobs');

const SITE_URL = process.env.URL || 'https://thequarrystl.com';
const SG_KEY = process.env.SENDGRID_API_KEY;
const ALERT_TO = 'management@thequarrystl.com';
const LOOKBACK_DAYS = 21;

function squareHost() {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  return env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
}

async function square(path) {
  const r = await fetch(squareHost() + path, {
    headers: {
      Authorization: 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Square-Version': '2024-12-18',
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Square ' + path.split('?')[0] + ' ' + r.status);
  return body;
}

async function listEventPayments() {
  const begin = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString();
  const out = [];
  let cursor = '';
  for (let i = 0; i < 20; i++) {
    const q = '/v2/payments?sort_order=DESC&limit=100&begin_time=' + encodeURIComponent(begin) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const b = await square(q);
    for (const p of b.payments || []) {
      if (p.status !== 'COMPLETED') continue;
      if (!/^(Event - |Food Truck - |Quarry Fest Vendor - )/.test(String(p.note || ''))) continue;
      const amt = Number(p.amount_money && p.amount_money.amount) || 0;
      const refunded = Number(p.refunded_money && p.refunded_money.amount) || 0;
      if (refunded > 0 && refunded >= amt) continue; // fully refunded
      out.push(p);
    }
    cursor = b.cursor || '';
    if (!cursor) break;
  }
  return out;
}

async function loadEvents() {
  const r = await fetch(SITE_URL + '/.netlify/functions/data-store?file=events.json', { timeout: 10000 });
  if (!r.ok) throw new Error('load events.json ' + r.status);
  const d = await r.json();
  return { data: d.decoded, sha: d.sha };
}

async function saveEvents(data, sha, message) {
  const r = await fetch(SITE_URL + '/.netlify/functions/data-store?file=events.json', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-quarry-key': process.env.QUARRY_DATA_KEY || '' },
    body: JSON.stringify({ json: data, sha, message }),
    timeout: 15000
  });
  return r.status;
}

function knownPaymentIds(data) {
  const ids = new Set();
  for (const ev of data.events || []) {
    for (const r of ev.registrations || []) if (r && r.paymentId) ids.add(r.paymentId);
    for (const r of ev.refundedRegistrations || []) if (r && r.paymentId) ids.add(r.paymentId);
  }
  const legacy = data.registrations && typeof data.registrations === 'object' ? data.registrations : {};
  for (const k of Object.keys(legacy)) for (const r of legacy[k] || []) if (r && r.paymentId) ids.add(r.paymentId);
  return ids;
}

function parseNote(note) {
  const m = String(note || '').match(/x(\d+)\s*$/);
  const qty = m ? Math.max(1, parseInt(m[1], 10)) : 1;
  const name = String(note || '').replace(/^Event - /, '').replace(/\s*x\d+\s*$/, '').trim();
  return { qty, name };
}

// Same rules as the webhook: seating option recovered from the note, add-ons
// from the order's line items (matched by exact add-on name).
function matchSeating(note, options) {
  const n = String(note || '').toLowerCase();
  const cands = (Array.isArray(options) ? options : []).filter((o) => o && String(o.name || '').trim())
    .sort((a, b) => String(b.name).length - String(a.name).length);
  for (const o of cands) if (n.includes(String(o.name).trim().toLowerCase())) return o;
  return null;
}
function matchAddOns(lineItems, defs) {
  const map = new Map();
  for (const d of Array.isArray(defs) ? defs : []) if (d && d.name) map.set(String(d.name).trim().toLowerCase(), String(d.name).trim());
  const out = [];
  for (const li of lineItems || []) {
    const canon = map.get(String(li.name || '').trim().toLowerCase());
    if (!canon) continue;
    const sizes = /^Sizes:\s*(.+)$/i.exec(String(li.note || '').trim());
    out.push({ name: canon, qty: Math.max(1, parseInt(li.quantity, 10) || 1), sizes: sizes ? sizes[1].split(',').map((s) => s.trim()).filter(Boolean) : [] });
  }
  return out;
}

async function buildRegistration(p, events) {
  const { qty, name: noteName } = parseNote(p.note);
  let md = {}, lineItems = [];
  if (p.order_id) {
    try {
      const o = (await square('/v2/orders/' + p.order_id)).order || {};
      md = o.metadata || {};
      lineItems = o.line_items || [];
    } catch (_) { /* fall back to the note */ }
  }
  let ev = md.eventId ? events.find((e) => e.id === md.eventId) : null;
  if (!ev) {
    const exact = events.filter((e) => e.name && noteName.toLowerCase().endsWith(String(e.name).toLowerCase()));
    if (exact.length === 1) ev = exact[0];
  }
  if (!ev) return { unmatched: true, payment: p, noteName };
  const seat = matchSeating(p.note, ev.seatingOptions);
  const addOns = matchAddOns(lineItems, ev.addOns);
  const reg = {
    name: md.customerName || p.buyer_email_address || '',
    email: md.customerEmail || p.buyer_email_address || '',
    qty,
    ...(md.customerPhone ? { phone: md.customerPhone } : {}),
    paymentId: p.id,
    registeredAt: p.created_at,
    source: 'square',
    reconciled: true,
    ...(seat ? { seatingOptionId: String(seat.id || ''), seatingOptionName: String(seat.name) } : {}),
    ...(addOns.length ? { addOns } : {})
  };
  return { ev, reg, amount: (Number(p.amount_money && p.amount_money.amount) || 0) / 100 };
}

async function sendAlert(subject, text) {
  if (!SG_KEY) return;
  try {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + SG_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_TO }] }],
        from: { email: ALERT_TO, name: 'Quarry Website' },
        subject,
        content: [{ type: 'text/plain', value: text }]
      }),
      timeout: 8000
    });
  } catch (e) { console.error('alert email failed:', e.message); }
}

exports.handler = async () => {
  if (!process.env.SQUARE_ACCESS_TOKEN) return { statusCode: 500, body: 'SQUARE_ACCESS_TOKEN missing' };
  const added = [], unmatched = [];
  let payments = [];
  try {
    payments = await listEventPayments();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, sha } = await loadEvents();
      const events = data.events || [];
      const known = knownPaymentIds(data);
      const missing = payments.filter((p) => String(p.note).startsWith('Event - ') && !known.has(p.id));
      added.length = 0; unmatched.length = 0;
      if (!missing.length) break;
      const touched = new Set();
      for (const p of missing) {
        const r = await buildRegistration(p, events);
        if (r.unmatched) { unmatched.push(r); continue; }
        r.ev.registrations = r.ev.registrations || [];
        r.ev.registrations.push(r.reg);
        touched.add(r.ev);
        added.push(r);
      }
      if (!added.length) break;
      for (const ev of touched) {
        const total = ev.registrations.reduce((s, x) => s + (Number(x.qty) || Number(x.tickets) || 1), 0);
        ev.registered = total; ev.registeredCount = total;
        if (ev.totalCapacity && total >= Number(ev.totalCapacity)) ev.status = 'sold-out';
      }
      const st = await saveEvents(data, sha, 'Nightly Square reconcile: added ' + added.length + ' missed ticket payment(s)');
      if (st >= 200 && st < 300) break;
      if (st !== 409 || attempt === 3) throw new Error('save events.json ' + st);
      await new Promise((res) => setTimeout(res, 1000 + attempt * 1000));
    }
  } catch (e) {
    console.error('event-payments-reconcile:', e.message);
    await sendAlert('Action needed: nightly ticket check failed',
      'The nightly check that compares Square ticket payments with the website could not finish:\n\n' + e.message +
      '\n\nNothing was changed. It will try again tomorrow night.');
    return { statusCode: 500, body: e.message };
  }

  // ---- Food trucks + Quarry Fest vendors (Netlify Blobs) -----------------
  const booked = [];
  try {
    for (const p of payments) {
      const note = String(p.note);
      const isTruck = note.startsWith('Food Truck - ');
      const isVendor = note.startsWith('Quarry Fest Vendor - ');
      if (!isTruck && !isVendor) continue;
      let md = {};
      try { md = ((await square('/v2/orders/' + p.order_id)).order || {}).metadata || {}; } catch (_) {}
      const amountStr = '$' + ((Number(p.amount_money && p.amount_money.amount) || 0) / 100).toFixed(2);
      if (isTruck) {
        const m = note.match(/(\d{4}-\d{2}-\d{2})/);
        const dateKey = (md.date || (m && m[1]) || '').replace(/\//g, '-');
        if (!dateKey) { unmatched.push({ payment: p, noteName: note }); continue; }
        const path = 'food-truck-bookings/' + dateKey;
        const data = (await readBlob(path)) || { bookings: [] };
        const list = data.bookings || [];
        if (list.some((b) => b.paymentId === p.id)) continue;
        const truckName = note.replace(/^Food Truck - /, '').split(' - ')[0].trim().toLowerCase();
        const b = (md.bookingId && list.find((x) => x.bookingId === md.bookingId)) ||
                  list.find((x) => String(x.leadName || '').trim().toLowerCase() === truckName && x.status !== 'booked');
        if (!b) { unmatched.push({ payment: p, noteName: note }); continue; }
        if (b.status === 'booked') continue;
        b.status = 'booked'; b.paidAt = p.created_at; b.paymentId = p.id; b.amountPaid = amountStr; b.reconciled = true;
        await writeBlob(path, { ...data, bookings: list });
        booked.push('Food truck: ' + b.leadName + ' (' + dateKey + ', ' + (b.time || '') + '), ' + amountStr + ', paid ' + String(p.created_at).slice(0, 10));
      } else {
        const path = 'quarryfest-vendors/2026-11-07';
        const data = (await readBlob(path)) || { vendors: [] };
        const list = data.vendors || [];
        if (list.some((v) => v.paymentId === p.id)) continue;
        const bizName = note.replace(/^Quarry Fest Vendor - /, '').trim().toLowerCase();
        const v = (md.vendorId && list.find((x) => x.vendorId === md.vendorId)) ||
                  list.find((x) => String(x.businessName || '').trim().toLowerCase() === bizName && x.status === 'pending_payment');
        if (!v) { unmatched.push({ payment: p, noteName: note }); continue; }
        if (v.status === 'booked' || v.status === 'refunded') continue;
        v.status = 'booked'; v.paidAt = p.created_at; v.paymentId = p.id; v.amountPaid = amountStr; v.reconciled = true;
        await writeBlob(path, { ...data, vendors: list });
        booked.push('Quarry Fest vendor: ' + v.businessName + ', ' + amountStr + ', paid ' + String(p.created_at).slice(0, 10));
      }
    }
  } catch (e) {
    console.error('truck/vendor reconcile:', e.message);
    await sendAlert('Action needed: nightly payment check failed (food trucks / vendors)', 'Could not finish checking food truck and Quarry Fest vendor payments:\n\n' + e.message + '\n\nIt will try again tomorrow night.');
  }

  if (added.length || unmatched.length || booked.length) {
    const lines = [];
    if (added.length) {
      lines.push('Added to the website (paid in Square, but missing from the event):', '');
      for (const a of added) lines.push('- ' + a.ev.name + ' (' + a.ev.date + '): ' + (a.reg.name || a.reg.email) + ', ' + a.reg.qty + ' ticket(s), $' + a.amount.toFixed(2) + ', paid ' + String(a.reg.registeredAt).slice(0, 10) + ' -> now ' + a.ev.registeredCount + ' registered');
      lines.push('', 'These guests did not get an automatic confirmation email.');
    }
    if (booked.length) {
      lines.push('', 'Marked as paid (paid in Square, still showing pending on the website):', '');
      for (const b of booked) lines.push('- ' + b);
      lines.push('', 'They did not get an automatic confirmation email.');
    }
    if (unmatched.length) {
      lines.push('', 'Paid in Square but no matching event on the website (not added):', '');
      for (const u of unmatched) lines.push('- ' + u.noteName + ': $' + ((Number(u.payment.amount_money && u.payment.amount_money.amount) || 0) / 100).toFixed(2) + ', paid ' + String(u.payment.created_at).slice(0, 10) + ', ' + (u.payment.buyer_email_address || 'no email'));
    }
    await sendAlert('Payment check: ' + (added.length + booked.length) + ' missed payment(s) fixed' + (unmatched.length ? ', ' + unmatched.length + ' unmatched' : ''), lines.join('\n'));
  }
  console.log('event-payments-reconcile:', JSON.stringify({ added: added.length, booked: booked.length, unmatched: unmatched.length }));
  return { statusCode: 200, body: JSON.stringify({ added: added.length, booked: booked.length, unmatched: unmatched.length }) };
};
