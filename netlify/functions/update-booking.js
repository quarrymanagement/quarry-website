// ============================================================================
// update-booking.js — Admin reschedule for a golf bay booking
//
// POST { adminPassword,
//        sessionId,                    // unique key for the booking to edit
//        oldDateKey,                   // YYYY-MM-DD where booking lives now
//        newDate?, newTime?, newBay?,  // any combination
//        sendReconfirm?: true,         // default true — emails customer
//        notes?: '...'                 // appended to admin notes
//      }
//
// Effect:
//   1. Reads golf-bookings/{oldDateKey}, finds the booking by sessionId
//   2. If newDate ≠ oldDateKey: removes from old blob, appends to new blob
//      (which automatically frees the old slot for new reservations and
//      blocks the new slot in get-bookings.js).
//   3. If only time/bay changes: edits the entry in-place.
//   4. Optionally sends a reconfirmation email via SendGrid with the new
//      date/time/bay.
//
// Why this works for front-end availability:
//   The customer-facing /quarry-golf page calls get-bookings.js for whatever
//   date the user is checking. get-bookings reads golf-bookings/{date} and
//   blocks any (bay,time) pair listed. By moving the booking record between
//   blobs (or updating its time field), availability is automatically synced.
// ============================================================================
const crypto = require('crypto');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN || '';
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || '';
const SITE_ID = 'roaring-pegasus-444826';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

async function readBlob(dateKey) {
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${dateKey}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN } });
  if (!res.ok) return { bookings: [] };
  try { return await res.json(); } catch (_) { return { bookings: [] }; }
}

async function writeBlob(dateKey, data) {
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${dateKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Blob write ' + res.status + ': ' + t.slice(0, 200));
  }
}

async function deleteBlob(dateKey) {
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/golf-bookings/${dateKey}`;
  await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN },
  });
}

function fmtDateLong(dateKey) {
  // dateKey like "2026-05-15" → "Friday, May 15, 2026"
  try {
    const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10));
    const dt = new Date(y, m - 1, d, 12, 0, 0); // noon-anchored to avoid TZ drift
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    }).format(dt);
  } catch (_) { return dateKey; }
}

async function sendReconfirmEmail(booking) {
  if (!SENDGRID_KEY) return { sent: false, reason: 'no SENDGRID_API_KEY' };
  const to = booking.customerEmail;
  if (!to || !to.includes('@')) return { sent: false, reason: 'no customer email' };

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.78rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px;background:#FFFFFF">' +
    '<h2 style="color:#2C1A0E;margin-top:0">Your Golf Bay Booking — Updated</h2>' +
    '<p style="color:#444">Hi ' + (booking.customerName || 'there') + ', your golf bay booking has been rescheduled. Here are the new details:</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px;font-size:0.95rem">' +
    '<p style="margin:6px 0"><b>Date:</b> ' + fmtDateLong(booking.dateKey) + '</p>' +
    '<p style="margin:6px 0"><b>Time:</b> ' + (booking.time || '—') + '</p>' +
    '<p style="margin:6px 0"><b>Bay:</b> ' + (booking.bay || '—') + '</p>' +
    (booking.partySize ? '<p style="margin:6px 0"><b>Party size:</b> ' + booking.partySize + '</p>' : '') +
    '</div>' +
    '<p style="color:#444">If this isn\'t what you expected, reply to this email or call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> and we\'ll get it sorted.</p>' +
    '<p style="color:#444">Looking forward to seeing you at The Quarry!</p>' +
    '</div></div>';

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry' },
    subject: 'Your Golf Bay Booking has been Rescheduled — The Quarry',
    content: [{ type: 'text/html', value: html }],
    categories: ['quarry-golf-reschedule'],
  };
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.status >= 200 && r.status < 300) return { sent: true };
  const t = await r.text();
  return { sent: false, status: r.status, error: t.slice(0, 200) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!NETLIFY_TOKEN) return reply(500, { ok: false, error: 'NETLIFY_AUTH_TOKEN not set' });

  const oldDateKey = body.oldDateKey;
  const sessionId = body.sessionId;
  if (!oldDateKey || !sessionId) {
    return reply(400, { ok: false, error: 'oldDateKey + sessionId required' });
  }

  const newDate = body.newDate || oldDateKey;
  // Validate newDate shape if provided
  if (newDate && !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return reply(400, { ok: false, error: 'newDate must be YYYY-MM-DD' });
  }

  // 1) Read old blob, find booking
  const oldBlob = await readBlob(oldDateKey);
  const idx = (oldBlob.bookings || []).findIndex((b) => (b.sessionId || '') === sessionId);
  if (idx < 0) return reply(404, { ok: false, error: 'Booking not found in ' + oldDateKey });

  const original = oldBlob.bookings[idx];
  const updated = Object.assign({}, original, {
    bay: body.newBay || original.bay,
    time: body.newTime || original.time,
    notes: body.notes ? ((original.notes || '') + (original.notes ? ' | ' : '') + body.notes) : original.notes,
    rescheduledAt: new Date().toISOString(),
  });

  // Detect collision: is the new (bay,time) already taken on newDate (excluding this booking)?
  const targetBlob = (newDate === oldDateKey) ? oldBlob : await readBlob(newDate);
  const collision = (targetBlob.bookings || []).some((b) =>
    (b.sessionId || '') !== sessionId &&
    String(b.bay || '').toLowerCase() === String(updated.bay || '').toLowerCase() &&
    String(b.time || '').replace(/\s+/g, '') === String(updated.time || '').replace(/\s+/g, '')
  );
  if (collision) {
    return reply(409, { ok: false, error: 'That bay + time is already booked on ' + newDate });
  }

  // 2) Apply changes
  if (newDate === oldDateKey) {
    // Same-day in-place edit
    oldBlob.bookings[idx] = updated;
    await writeBlob(oldDateKey, oldBlob);
  } else {
    // Cross-day move: remove from old, append to new
    const oldRest = (oldBlob.bookings || []).filter((_, i) => i !== idx);
    if (oldRest.length === 0) {
      // Delete the old blob entirely (cleaner than leaving an empty record)
      try { await deleteBlob(oldDateKey); }
      catch (_) { await writeBlob(oldDateKey, { bookings: [] }); }
    } else {
      await writeBlob(oldDateKey, { bookings: oldRest });
    }
    const newBookings = (targetBlob.bookings || []).concat([Object.assign({}, updated, { dateKey: newDate })]);
    await writeBlob(newDate, { bookings: newBookings });
  }

  // 3) Send reconfirmation email (default true)
  let emailResult = { sent: false, reason: 'skipped' };
  if (body.sendReconfirm !== false) {
    try {
      emailResult = await sendReconfirmEmail(Object.assign({}, updated, { dateKey: newDate }));
    } catch (e) {
      emailResult = { sent: false, error: e.message };
    }
  }

  return reply(200, {
    ok: true,
    booking: Object.assign({}, updated, { dateKey: newDate }),
    moved: newDate !== oldDateKey,
    email: emailResult,
  });
};
