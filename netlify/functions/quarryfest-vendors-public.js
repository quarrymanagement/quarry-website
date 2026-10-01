// ============================================================================
// quarryfest-vendors-public.js
//
// Public: the "Vendors in Attendance" list on the QuarryFest event page.
// Returns PAID (status 'booked') vendors only, and only public-safe fields:
// business name and what they're offering. Never emails, phones or payments.
//
// GET /.netlify/functions/quarryfest-vendors-public
// Returns: { ok: true, count, vendors: [{ name, offering }] }
// ============================================================================

const { readBlob } = require('./_blobs');

const BOOKINGS_PATH = 'quarryfest-vendors/2026-11-07';
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=60, s-maxage=60',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'GET only' }) };
  try {
    const data = (await readBlob(BOOKINGS_PATH)) || { vendors: [] };
    const seen = {};
    const vendors = (data.vendors || [])
      .filter((v) => v && v.status === 'booked' && !v.hidePublic && String(v.businessName || '').trim())
      .map((v) => ({
        name: String(v.businessName).trim().slice(0, 120),
        offering: String(v.notes || '').trim().slice(0, 160),
      }))
      .filter((v) => { const k = v.name.toLowerCase(); if (seen[k]) return false; seen[k] = true; return true; })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, count: vendors.length, vendors }) };
  } catch (err) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ ok: false, error: 'Could not load vendors' }) };
  }
};
