// ============================================================================
// list-bookings-admin.js
//
// Admin-only: returns all golf bookings across a date range, with full
// customer info (email, name, phone, partySize, etc.). Different from
// get-bookings.js (customer-facing) which only returns {bay, time} for
// availability gating.
//
// GET /.netlify/functions/list-bookings-admin?adminPassword=...&days=60
// Returns: { bookings: [{ dateKey, bay, time, customerName, customerEmail,
//                          customerPhone, partySize, sessionId, ... }, ...] }
// ============================================================================
const crypto = require('crypto');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || '';
const SITE_ID = 'roaring-pegasus-444826';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function checkAdmin(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}

function ctYmd(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Allow GET (with adminPassword in query) OR POST (with body)
  let adminPassword, daysBack, daysForward, search;
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    adminPassword = q.adminPassword;
    daysBack = parseInt(q.daysBack || '7', 10);
    daysForward = parseInt(q.daysForward || '60', 10);
    search = (q.search || '').toLowerCase().trim();
  } else if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      adminPassword = body.adminPassword;
      daysBack = parseInt(body.daysBack || '7', 10);
      daysForward = parseInt(body.daysForward || '60', 10);
      search = (body.search || '').toLowerCase().trim();
    } catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  } else {
    return reply(405, { ok: false, error: 'Method not allowed' });
  }

  if (!checkAdmin(adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!NETLIFY_TOKEN) return reply(500, { ok: false, error: 'NETLIFY_AUTH_TOKEN not set' });

  // Build the list of date keys to check
  const today = new Date();
  const dates = [];
  for (let i = -daysBack; i <= daysForward; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    dates.push(ctYmd(d));
  }

  // The Stripe webhook stores bookings at flat key `golf-{dateKey}` where
  // dateKey is m.date with slashes replaced by dashes. The customer-facing
  // checkout sends m.date in whatever format the front-end form passed —
  // could be YYYY-MM-DD or M/D/YYYY etc. We try every likely variant.
  function variants(d) {
    // d is a Date object
    const yyyy = d.getFullYear();
    const m = d.getMonth() + 1;
    const dd = d.getDate();
    const mm = String(m).padStart(2, '0');
    const dd0 = String(dd).padStart(2, '0');
    return [
      // YYYY-MM-DD (zero-padded ISO)
      `${yyyy}-${mm}-${dd0}`,
      // M-D-YYYY (no leading zeros, US style after slash→dash)
      `${m}-${dd}-${yyyy}`,
      // MM-DD-YYYY (zero-padded US)
      `${mm}-${dd0}-${yyyy}`,
      // YYYY-M-D
      `${yyyy}-${m}-${dd}`,
    ];
  }

  function ymdToDate(s) {
    const [y, m, dd] = s.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, dd);
  }

  const all = [];
  const seen = new Set(); // dedupe by sessionId

  for (const isoDate of dates) {
    const d = ymdToDate(isoDate);
    const tried = new Set();
    for (const v of variants(d)) {
      if (tried.has(v)) continue;
      tried.add(v);
      // Try both flat-key (webhook's storage) and store-namespaced (legacy)
      const urls = [
        `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-${v}`,
        `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${v}`,
      ];
      for (const url of urls) {
        try {
          const res = await fetch(url, { headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN } });
          if (!res.ok) continue;
          let data;
          try { data = await res.json(); } catch (_) { continue; }
          const bookings = (data && data.bookings) || [];
          for (const b of bookings) {
            const key = (b.sessionId || '') + '|' + (b.bay || '') + '|' + (b.time || '');
            if (seen.has(key)) continue;
            seen.add(key);
            all.push({
              dateKey: isoDate,            // normalized ISO for UI
              storedDateKey: v,            // raw key in blob storage
              storedAt: url,
              bay: b.bay || '',
              time: b.time || '',
              customerName: b.customerName || b.name || '',
              customerEmail: b.customerEmail || b.email || '',
              customerPhone: b.customerPhone || b.phone || '',
              partySize: b.partySize || b.players || null,
              sessionId: b.sessionId || '',
              paymentIntent: b.paymentIntent || '',
              amount: b.amount || null,
              createdAt: b.createdAt || b.bookedAt || null,
              notes: b.notes || '',
            });
          }
        } catch (e) {
          // skip per-URL errors
        }
      }
    }
  }

  // Optional search filter
  let filtered = all;
  if (search) {
    filtered = all.filter((b) =>
      (b.customerName || '').toLowerCase().includes(search) ||
      (b.customerEmail || '').toLowerCase().includes(search) ||
      (b.customerPhone || '').toLowerCase().includes(search) ||
      (b.bay || '').toLowerCase().includes(search)
    );
  }

  // Sort by date asc, then time asc
  filtered.sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1;
    return (a.time || '').localeCompare(b.time || '');
  });

  return reply(200, {
    ok: true,
    count: filtered.length,
    totalScanned: all.length,
    datesScanned: dates.length,
    bookings: filtered,
  });
};
