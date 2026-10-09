// ============================================================================
// _venue-sync-shared.js
//
// Mirrors golf-bay and pavilion bookings onto the venue calendar so staff see
// them next to weddings and events (import-only; the leading "_" keeps Netlify
// from deploying it as its own endpoint).
//
// Source of truth stays where it always was: Netlify Blobs
//   golf-bookings/{YYYY-MM-DD}      and      pavilion-bookings/{YYYY-MM-DD}
// This reads them and posts a batch to the Supabase edge function
// "venue-external-sync" (shared secret VENUE_AVAILABILITY_KEY, never sent to a
// browser). The database does an idempotent upsert, flags overlaps instead of
// rejecting paid bookings, and removes calendar rows whose source booking is
// gone. Pavilion rentals also flow on to the shared Google "The Quarry"
// calendar through the existing venue-calendar outbox; golf deliberately does not.
// ============================================================================
const { readBlob, listKeys } = require('./_blobs');

const EDGE_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-external-sync';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORES = { golf: 'golf-bookings', pavilion: 'pavilion-bookings' };

function todayCT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function toItem(kind, dateKey, b) {
  const unit = kind === 'golf' ? b.bay : b.pavilion;
  const time = b.time;
  // Stable per-booking reference: the payment id when there is one (Square /
  // legacy Stripe session), otherwise a deterministic slot key for admin blocks.
  const ref = b.paymentId || b.sessionId || [dateKey, String(unit), String(time)].join('|');
  return {
    ref: String(ref),
    unit: String(unit == null ? '' : unit),
    date: dateKey,
    time: String(time || ''),
    name: b.customerName || '',
    email: b.customerEmail || '',
    phone: b.customerPhone || '',
    guests: kind === 'golf' ? (b.players || b.partySize || '') : '',
    amount: b.amountPaid || '',
    source: b.source || '',
  };
}

async function callEdge(payload) {
  const key = process.env.VENUE_AVAILABILITY_KEY || '';
  if (!key) throw new Error('VENUE_AVAILABILITY_KEY not configured');
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-key': key },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new Error('venue-external-sync returned non-JSON (' + r.status + ')'); }
  if (!r.ok || !body.ok) throw new Error('venue-external-sync failed: ' + JSON.stringify(body).slice(0, 200));
  return body;
}

async function readDay(kind, dateKey) {
  const data = await readBlob(STORES[kind] + '/' + dateKey);
  return ((data && data.bookings) || []).map((b) => toItem(kind, dateKey, b));
}

// Full reconcile for the next ~5 months (plus yesterday). Used by the schedule.
async function syncKind(kind) {
  const from = addDays(todayCT(), -1);
  const to = addDays(todayCT(), 150);
  const keys = (await listKeys(STORES[kind])).filter((k) => DATE_RE.test(k) && k >= from && k <= to);
  const days = await Promise.all(keys.map((k) => readDay(kind, k)));
  const items = days.flat();
  const result = await callEdge({ kind, from, to, items });
  return { ...result, daysRead: keys.length, itemsSent: items.length };
}

// Single-date sync for immediate effect right after a booking is saved/removed.
async function syncDay(kind, dateKey) {
  if (!DATE_RE.test(String(dateKey || ''))) return { skipped: 'bad date' };
  const items = await readDay(kind, dateKey);
  return callEdge({ kind, from: dateKey, to: dateKey, items });
}

module.exports = { syncKind, syncDay };
