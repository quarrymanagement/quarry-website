// ============================================================================
// backfill-golf-bookings.js
//
// One-shot tool: looks at every PAID golf checkout.session in Stripe whose
// booking date is today or later, and for each one we have not yet processed:
//   - Sends a customer confirmation email (SendGrid)
//   - Creates a Google Calendar event on the primary calendar
//
// Tracks "already done" via a Netlify Blob so re-running is safe (idempotent).
// Designed to be invoked once after the stripe-webhook fix is deployed so
// nobody's previous booking gets dropped.
//
// POST body:
//   { dryRun?: boolean, force?: boolean, sinceDays?: number }
// ============================================================================

const Stripe = require('stripe');
const https  = require('https');
const { google } = require('googleapis');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ----- Email -----
function sendGridEmail(to, subject, htmlBody) {
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map((email) => ({ email })) }],
    from: { email: 'bookings@thequarrystl.com', name: 'The Quarry STL' },
    reply_to: { email: 'management@thequarrystl.com' },
    subject, content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-golf-booking', 'backfill']
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com', path: '/v3/mail/send', method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' }
    }, (res) => { let body=''; res.on('data', c => body += c); res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(); else reject(new Error('SG ' + res.statusCode + ': ' + body));
    }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

// ----- Time helpers (mirror stripe-webhook.js) -----
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

// ----- Google Calendar -----
async function createCalendarEvent({ summary, description, location, startIso, endIso, attendeeEmail, sessionId }) {
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN;
  const usingNew = !!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !refreshToken) {
    return { ok: false, error: 'Google OAuth env vars missing' };
  }
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, 'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  // Tag in error path so we know which token was tried
  global.__calendarTokenSource = usingNew ? 'GOOGLE_CALENDAR_REFRESH_TOKEN' : 'GMAIL_REFRESH_TOKEN';
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const eventBody = {
    summary, description, location,
    start: { dateTime: startIso, timeZone: 'America/Chicago' },
    end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
    extendedProperties: { private: { quarryGolfSession: sessionId } },
    reminders: { useDefault: false, overrides: [
      { method: 'popup', minutes: 60 }, { method: 'email', minutes: 1440 }
    ] }
  };
  if (attendeeEmail) eventBody.attendees = [{ email: attendeeEmail }];
  const r = await calendar.events.insert({ calendarId: 'primary', sendUpdates: 'all', requestBody: eventBody });
  return { ok: true, id: r.data.id, link: r.data.htmlLink };
}

// ----- Idempotency tracking via Netlify Blobs -----
async function readProcessed() {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return new Set();
  const url = 'https://api.netlify.com/api/v1/blobs/roaring-pegasus-444826/' + encodeURIComponent('golf-backfill-processed');
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set(Array.isArray(d.processed) ? d.processed : []);
  } catch (_) { return new Set(); }
}
async function writeProcessed(set) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;
  const url = 'https://api.netlify.com/api/v1/blobs/roaring-pegasus-444826/' + encodeURIComponent('golf-backfill-processed');
  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed: Array.from(set), updatedAt: new Date().toISOString() })
  });
}

// Persist booking record to the canonical golf-bookings/{date} blob path so
// the customer-facing get-bookings.js (double-book guard) and the admin
// update-booking.js (reschedule) can both find it.
async function persistToBlob(b) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token || !b.date) return { ok: false, reason: 'missing token or date' };
  const siteId = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
  const url = 'https://api.netlify.com/api/v1/blobs/' + siteId + '/golf-bookings/' + b.date;
  let bookings = [];
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.ok) { const d = await r.json(); bookings = d.bookings || []; }
  } catch (_) {}
  // Replace any existing record with the same sessionId
  bookings = bookings.filter(x => (x.sessionId || '') !== b.sessionId);
  bookings.push({
    sessionId: b.sessionId,
    bay: b.bay,
    time: b.time,
    date: b.date,
    dateKey: b.date,
    duration: b.duration,
    players: b.players,
    partySize: b.players,
    customerName:  b.customerName,
    customerEmail: b.customerEmail,
    customerPhone: b.customerPhone,
    extraBalls: b.extraBalls,
    extraBallsPrice: b.extraBallsPrice,
    amountPaid: b.amountPaid,
    bookedAt: new Date().toISOString(),
    backfilled: true
  });
  const r2 = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookings })
  });
  return { ok: r2.ok, status: r2.status };
}

// ----- Customer email body -----
function buildCustomerHtml(b) {
  const extrasLine = b.extraBalls > 0
    ? '<p style="margin:4px 0"><b>Extras:</b> ' + b.extraBalls + ' extra balls (+$' + b.extraBallsPrice + ')</p>'
    : '';
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Your Booking is Confirmed</h2>' +
    '<p>Hi ' + (b.customerName || 'there') + ',</p>' +
    '<p>Apologies for the delayed confirmation - we recently fixed a glitch in our notification system. Your reservation is solid and ready for you. Here are the details:</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Bay:</b> ' + (b.bay || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> ' + (b.date || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (b.time || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Duration:</b> ' + (b.duration || '50 Minutes') + '</p>' +
    '<p style="margin:4px 0"><b>Players:</b> ' + (b.players || '-') + '</p>' +
    extrasLine +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total Paid: ' + b.amountPaid + '</b></p></div>' +
    '<p>You should also receive a Google Calendar invite. Please arrive 10 minutes early to check in.</p>' +
    '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a>.</p>' +
    '</div><div style="background:#1A0E08;padding:16px;text-align:center"><p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
  );
}

// ----- Main -----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) };

  try {
    let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    const dryRun    = !!body.dryRun;
    const force     = !!body.force;
    const skipEmail = !!body.skipEmail;
    const sinceDays = parseInt(body.sinceDays || '180', 10);

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const sinceTs = Math.floor((Date.now() - sinceDays * 24 * 3600 * 1000) / 1000);

    // Today (Central Time) so we only process future-dated bookings
    const ct = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const today = ct.getFullYear() + '-' + String(ct.getMonth()+1).padStart(2,'0') + '-' + String(ct.getDate()).padStart(2,'0');

    const processed = force ? new Set() : await readProcessed();

    // Pull all paid checkout sessions in the window
    const candidates = [];
    let starting_after; let pages = 0;
    while (pages < 10) {
      const list = await stripe.checkout.sessions.list({
        limit: 100, created: { gte: sinceTs },
        ...(starting_after ? { starting_after } : {})
      });
      for (const s of list.data) {
        if (s.payment_status !== 'paid') continue;
        const md = s.metadata || {};
        if (md.bookingType !== 'golf' && !md.bay) continue;
        const bookingDate = md.date || '';
        if (!bookingDate || bookingDate < today) continue;            // skip past
        if (processed.has(s.id)) continue;                            // already done
        candidates.push(s);
      }
      if (!list.has_more) break;
      starting_after = list.data[list.data.length - 1].id; pages++;
    }

    const results = [];
    for (const s of candidates) {
      const md = s.metadata || {};
      const b = {
        sessionId: s.id,
        customerName:    md.customerName || '',
        customerEmail:   md.customerEmail || s.customer_details?.email || '',
        customerPhone:   md.customerPhone || '',
        bay:             md.bay || '',
        date:            md.date || '',
        time:            md.time || '',
        duration:        md.duration || '50 Minutes',
        players:         md.players || '',
        extraBalls:      parseInt(md.extraBalls || '0', 10),
        extraBallsPrice: parseInt(md.extraBallsPrice || '0', 10),
        amountPaid:      '$' + ((s.amount_total || 0) / 100).toFixed(2)
      };

      if (dryRun) { results.push({ ...b, action: 'dryrun' }); continue; }

      // 1) Customer email (skip if no email on file or if caller asked to skip)
      let emailRes = 'skipped';
      if (skipEmail) {
        emailRes = 'skipped (skipEmail=true)';
      } else if (b.customerEmail) {
        try { await sendGridEmail(b.customerEmail, 'Your Golf Booking is Confirmed - The Quarry', buildCustomerHtml(b)); emailRes = 'sent'; }
        catch (e) { emailRes = 'fail: ' + e.message.substring(0, 100); }
      }

      // 2) Calendar event
      let calRes = 'skipped';
      const start = parseHourFromAmPm(b.time);
      if (start && b.date) {
        let endHour = start.hour, endMin = start.minute + 50;
        if (endMin >= 60) { endHour += 1; endMin -= 60; }
        const startIso = buildIsoForCentral(b.date, start.hour, start.minute);
        const endIso   = buildIsoForCentral(b.date, endHour, endMin);
        const summary  = (b.bay || 'Golf Bay') + ' - ' + (b.customerName || 'Customer');
        const lines = [];
        lines.push('Customer: ' + (b.customerName || '-'));
        lines.push('Email: '    + (b.customerEmail || '-'));
        if (b.customerPhone) lines.push('Phone: ' + b.customerPhone);
        lines.push('Players: '  + (b.players || '-'));
        lines.push('Duration: ' + (b.duration || '50 Minutes'));
        lines.push('Bay: '      + (b.bay || '-'));
        if (b.extraBalls > 0) lines.push('Extras: ' + b.extraBalls + ' extra balls (+$' + b.extraBallsPrice + ')');
        lines.push('Total Paid: ' + b.amountPaid);
        lines.push('Stripe Session: ' + b.sessionId);
        lines.push('(backfilled)');
        try {
          const r = await createCalendarEvent({
            summary,
            description: lines.join('\n'),
            location: 'The Quarry, 3960 Highway Z, New Melle, MO 63385',
            startIso, endIso,
            attendeeEmail: b.customerEmail,
            sessionId: b.sessionId
          });
          calRes = r.ok ? 'created (' + r.id + ')' : 'fail: ' + r.error;
        } catch (e) {
          // Extract Google API's full error for better debugging
          let detail = e.message || String(e);
          if (e.response && e.response.data) {
            try { detail += ' :: ' + JSON.stringify(e.response.data).substring(0, 300); } catch(_) {}
          } else if (e.errors) {
            try { detail += ' :: ' + JSON.stringify(e.errors).substring(0, 300); } catch(_) {}
          }
          if (global.__calendarTokenSource) detail += ' [token=' + global.__calendarTokenSource + ']';
          calRes = 'fail: ' + detail.substring(0, 400);
        }
      }

      // 3) Persist booking to canonical blob path so admin reschedule + double-book guard work
      let blobRes = 'skipped';
      try {
        const pr = await persistToBlob(b);
        blobRes = pr.ok ? 'stored' : ('fail ' + pr.status);
      } catch (e) { blobRes = 'fail: ' + e.message.substring(0, 100); }

      processed.add(s.id);
      results.push({ ...b, email: emailRes, calendar: calRes, blob: blobRes });
    }

    if (!dryRun && results.length) await writeProcessed(processed);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      ok: true, dryRun, candidatesFound: candidates.length, processedCount: results.length, results
    }) };
  } catch (err) {
    console.error('backfill-golf-bookings error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
