// ============================================================================
// admin-add-booking.js — Manually add a golf bay booking from the admin panel
//
// Use case: "Pay at the venue" bookings made over the phone or in person.
// Does NOT charge anything. Records the booking exactly like the
// stripe-webhook would, plus sends the customer confirmation email and
// creates the Google Calendar event.
//
// POST {
//   adminPassword,
//   customerName, customerEmail, customerPhone,
//   bay, date, time, duration, players,
//   extraBalls?, extraBallsPrice?,
//   notes?,                  // free-text note appended to record
//   sendConfirmEmail?: true  // default true
// }
// ============================================================================
const crypto = require('crypto');
const https = require('https');
const { google } = require('googleapis');

const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const NETLIFY_TOKEN  = process.env.NETLIFY_AUTH_TOKEN || '';
const SENDGRID_KEY   = process.env.SENDGRID_API_KEY || '';
const SITE_ID        = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function checkAdmin(p) {
  if (!p) return false;
  if (ADMIN_PASSWORD_HASH) return sha256(p) === ADMIN_PASSWORD_HASH;
  return p === 'quarry2026';
}

// -- Time / blob helpers (mirror stripe-webhook.js) --
function parseHourFromAmPm(t) {
  const m = (t || '').match(/(\d+):(\d+)\s*([AP]M)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return { hour: h, minute: min };
}
function buildIsoForCentral(dateStr, hour, minute) {
  const probe = new Date(dateStr + 'T12:00:00Z');
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
  const parts = fmt.formatToParts(probe);
  const tzAbbrev = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'CDT';
  const offset = tzAbbrev === 'CDT' ? '-05:00' : '-06:00';
  return dateStr + 'T' + String(hour).padStart(2,'0') + ':' + String(minute).padStart(2,'0') + ':00' + offset;
}
function fmtDateLong(dateKey) {
  try {
    const [y,m,d] = dateKey.split('-').map(n => parseInt(n,10));
    const dt = new Date(y, m-1, d, 12, 0, 0);
    return new Intl.DateTimeFormat('en-US', { timeZone:'America/Chicago', weekday:'long', month:'long', day:'numeric', year:'numeric' }).format(dt);
  } catch (_) { return dateKey; }
}

function sendGridEmail(to, subject, htmlBody) {
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map(email => ({ email })) }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com' },
    subject, content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-golf-booking', 'admin-add']
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: { Authorization: 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' }
    }, (res) => {
      let body=''; res.on('data', c => body+=c); res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error('SG ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
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
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Blob write ' + res.status);
}

async function createCalendarEvent(b) {
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN;
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !refreshToken) {
    return { ok: false, error: 'Google OAuth env vars missing' };
  }
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, 'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const start = parseHourFromAmPm(b.time);
  if (!start || !b.date) return { ok: false, error: 'bad date/time' };
  let endHour = start.hour, endMin = start.minute + 50;
  if (endMin >= 60) { endHour += 1; endMin -= 60; }
  const startIso = buildIsoForCentral(b.date, start.hour, start.minute);
  const endIso   = buildIsoForCentral(b.date, endHour, endMin);
  const lines = [];
  lines.push('Customer: ' + (b.customerName || '-'));
  lines.push('Email: '    + (b.customerEmail || '-'));
  if (b.customerPhone) lines.push('Phone: ' + b.customerPhone);
  lines.push('Players: '  + (b.players || '-'));
  lines.push('Duration: ' + (b.duration || '50 Minutes'));
  lines.push('Bay: '      + (b.bay || '-'));
  if (b.extraBalls && parseInt(b.extraBalls,10) > 0) lines.push('Extras: ' + b.extraBalls + ' extra balls (+$' + b.extraBallsPrice + ')');
  lines.push('Payment: PAY AT THE VENUE');
  if (b.notes) lines.push('Notes: ' + b.notes);
  lines.push('Added manually by admin');
  const r = await calendar.events.insert({
    calendarId: 'primary',
    sendUpdates: 'all',
    requestBody: {
      summary: (b.bay || 'Golf Bay') + ' - ' + (b.customerName || 'Customer') + ' (Pay at venue)',
      description: lines.join('\n'),
      location: 'The Quarry, 3960 Highway Z, New Melle, MO 63385',
      start: { dateTime: startIso, timeZone: 'America/Chicago' },
      end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
      attendees: b.customerEmail ? [{ email: b.customerEmail }] : undefined,
      reminders: { useDefault: false, overrides: [{ method:'popup', minutes:60 }, { method:'email', minutes:1440 }] }
    }
  });
  return { ok: true, id: r.data.id };
}

function buildCustomerHtml(b) {
  const extrasLine = (parseInt(b.extraBalls,10) || 0) > 0
    ? '<p style="margin:4px 0"><b>Extras:</b> ' + b.extraBalls + ' extra balls (+$' + (b.extraBallsPrice || 0) + ')</p>'
    : '';
  const baseDollars = 40 + (parseInt(b.extraBallsPrice,10) || 0);
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Your Golf Bay is Reserved</h2>' +
    '<p>Hi ' + (b.customerName || 'there') + ', your bay is booked. Here are the details:</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Bay:</b> ' + (b.bay || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> ' + fmtDateLong(b.date) + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (b.time || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Duration:</b> ' + (b.duration || '50 Minutes') + '</p>' +
    '<p style="margin:4px 0"><b>Players:</b> ' + (b.players || '-') + '</p>' +
    extrasLine +
    '<p style="margin:10px 0 4px;padding:8px 12px;background:#fff;border-radius:4px;color:#9a7b2a"><b>Payment:</b> Pay at the venue when you arrive ($' + baseDollars + ' total)</p>' +
    '</div>' +
    '<p>Please arrive about 10 minutes early to check in. We will collect payment then - cash or card both fine.</p>' +
    '<p>Questions or need to change your time? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a>.</p>' +
    '</div><div style="background:#1A0E08;padding:16px;text-align:center"><p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
  );
}

function buildOwnerHtml(b, sessionId) {
  return (
    '<h2 style="color:#B8933A;font-family:Arial,sans-serif">New Golf Bay Booking (Pay at Venue)</h2>' +
    '<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Name</b></td><td>' + (b.customerName || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Email</b></td><td>' + (b.customerEmail || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Phone</b></td><td>' + (b.customerPhone || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Bay</b></td><td>' + (b.bay || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Date</b></td><td>' + (b.date || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Time</b></td><td>' + (b.time || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Duration</b></td><td>' + (b.duration || '50 Minutes') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Players</b></td><td>' + (b.players || '-') + '</td></tr>' +
    ((parseInt(b.extraBalls,10) || 0) > 0 ? '<tr><td style="padding:4px 12px 4px 0"><b>Extras</b></td><td>' + b.extraBalls + ' extra balls (+$' + (b.extraBallsPrice || 0) + ')</td></tr>' : '') +
    '<tr><td style="padding:4px 12px 4px 0"><b>Payment</b></td><td><b style="color:#9a7b2a">Pay at venue</b></td></tr>' +
    (b.notes ? '<tr><td style="padding:4px 12px 4px 0;vertical-align:top"><b>Notes</b></td><td>' + b.notes + '</td></tr>' : '') +
    '<tr><td style="padding:4px 12px 4px 0"><b>Booking ID</b></td><td><code>' + sessionId + '</code></td></tr>' +
    '</table>' +
    '<p style="font-family:Arial,sans-serif;font-size:13px;color:#666">Added manually via admin panel. A Google Calendar event has been added to the primary calendar.</p>'
  );
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'POST only' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  if (!checkAdmin(body.adminPassword)) return reply(401, { ok: false, error: 'Invalid admin password' });
  if (!NETLIFY_TOKEN) return reply(500, { ok: false, error: 'NETLIFY_AUTH_TOKEN not set' });

  // Required fields
  const required = ['customerName', 'bay', 'date', 'time', 'players'];
  for (const k of required) if (!body[k]) return reply(400, { ok: false, error: 'Missing required field: ' + k });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return reply(400, { ok: false, error: 'date must be YYYY-MM-DD' });

  // Collision check
  const existing = await readBlob(body.date);
  const collision = (existing.bookings || []).some(b =>
    String(b.bay || '').toLowerCase() === String(body.bay || '').toLowerCase() &&
    String(b.time || '').replace(/\s+/g, '') === String(body.time || '').replace(/\s+/g, '')
  );
  if (collision) return reply(409, { ok: false, error: 'That bay + time is already booked on ' + body.date });

  // Build booking record (same shape as stripe-webhook)
  const sessionId = 'admin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const booking = {
    sessionId,
    bay: body.bay,
    time: body.time,
    date: body.date,
    dateKey: body.date,
    duration: body.duration || '50 Minutes',
    players: body.players,
    partySize: body.players,
    customerName:    body.customerName,
    customerEmail:   body.customerEmail || '',
    customerPhone:   body.customerPhone || '',
    extraBalls:      parseInt(body.extraBalls || '0', 10),
    extraBallsPrice: parseInt(body.extraBallsPrice || '0', 10),
    amountPaid:      'Pay at venue',
    paymentMethod:   'pay-at-venue',
    notes:           body.notes || '',
    bookedAt:        new Date().toISOString(),
    addedBy:         'admin'
  };

  // Save to blob
  const bookings = (existing.bookings || []).concat([booking]);
  await writeBlob(body.date, { bookings });

  // Customer email (if email provided + checkbox on)
  let emailRes = 'skipped';
  if (body.sendConfirmEmail !== false && booking.customerEmail) {
    try {
      await sendGridEmail(booking.customerEmail, 'Your Golf Bay is Reserved - The Quarry', buildCustomerHtml(booking));
      emailRes = 'sent';
    } catch (e) { emailRes = 'fail: ' + e.message.substring(0, 120); }
  } else if (!booking.customerEmail) { emailRes = 'skipped (no email)'; }

  // Management email
  let mgmtEmail = 'skipped';
  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'New Pay-at-Venue Booking - ' + booking.bay + ' on ' + booking.date + ' at ' + booking.time,
      buildOwnerHtml(booking, sessionId)
    );
    mgmtEmail = 'sent';
  } catch (e) { mgmtEmail = 'fail: ' + e.message.substring(0, 120); }

  // Calendar event
  let calRes = 'skipped';
  try {
    const c = await createCalendarEvent(booking);
    calRes = c.ok ? 'created (' + c.id + ')' : 'fail: ' + c.error;
  } catch (e) { calRes = 'fail: ' + e.message.substring(0, 120); }

  return reply(200, {
    ok: true,
    booking,
    email: emailRes,
    managementEmail: mgmtEmail,
    calendar: calRes
  });
};
