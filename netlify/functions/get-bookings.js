// ============================================================================
// get-bookings.js — customer-facing availability lookup
//
// Returns the list of {bay, time} pairs already booked on a given date so the
// /quarry-golf page can disable those slots in its picker.
//
// Reads from Netlify Blobs at: golf-bookings/{YYYY-MM-DD}
// (store="golf-bookings", key=ISO date)
//
// IMPORTANT site-ID note: Netlify's Blobs REST API requires the site UUID,
// NOT the slug. Use process.env.NETLIFY_SITE_ID (auto-injected by Netlify
// Functions). Hardcoded slug 'roaring-pegasus-444826' returns 400 invalid site.
// ============================================================================

const SITE_ID = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';

// Normalize whatever date format the client sent into ISO YYYY-MM-DD.
function toIso(d) {
  if (!d) return null;
  const s = String(d).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY-M-D (no padding)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // M/D/YYYY or MM/DD/YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  // YYYY/MM/DD
  m = s.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const raw = event.queryStringParameters && event.queryStringParameters.date;
    if (!raw) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };
    const dateKey = toIso(raw);
    if (!dateKey) return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid date format', date: raw }) };

    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) {
      console.warn('get-bookings: NETLIFY_AUTH_TOKEN not set');
      return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
    }

    const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${dateKey}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 404) {
      // No bookings for this date yet — perfectly normal.
      return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
    }
    if (!res.ok) {
      console.log('get-bookings unexpected status', res.status, 'for', dateKey);
      return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
    }
    const data = await res.json();
    const bookings = (data && data.bookings) || [];
    const booked = bookings.map((b) => ({ bay: b.bay, time: b.time }));
    console.log('get-bookings:', dateKey, 'found', booked.length, 'booking(s)');
    return { statusCode: 200, headers, body: JSON.stringify({ booked }) };
  } catch (err) {
    console.error('get-bookings error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
  }
};
