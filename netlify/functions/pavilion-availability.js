// ============================================================================
// pavilion-availability.js
//
// GET /.netlify/functions/pavilion-availability?date=YYYY-MM-DD
// Returns { ok, bookable, reason?, slots: [{ time, pavilions: { "1": true/false, ... } }] }
// true = available. Public (no auth) since staff hand this page's link
// directly to whoever's asking -- nothing here reveals more than "is this
// pavilion free at this time," no customer contact details.
//
// Two fixed slots per open day: 11 AM-4 PM (5 hours) and 5 PM until close.
// ============================================================================

const { readBlob } = require('./_blobs');
const { isDateBookable, slotsForDate, conflictsWithExisting } = require('./_pavilion-shared');

const PAVILIONS = ['1', '2', '3', '4', '5', '6'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) };

  const date = ((event.queryStringParameters || {}).date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'date must be YYYY-MM-DD' }) };

  const bookable = await isDateBookable(date);
  if (!bookable.ok) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, bookable: false, reason: bookable.reason, slots: [] }) };
  }

  let existing = [];
  try {
    const data = await readBlob('pavilion-bookings/' + date);
    existing = (data && data.bookings) || [];
  } catch (_) { /* no bookings yet for this date */ }

  const slots = slotsForDate(date).map((time) => {
    const pavilions = {};
    for (const p of PAVILIONS) {
      pavilions[p] = !conflictsWithExisting(existing, p, time);
    }
    return { time, pavilions };
  });

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, bookable: true, slots }) };
};
