// ============================================================================
// square-webhook.js
//
// Handles Square webhook events for The Quarry. Replaces stripe-webhook.js.
//
// Events handled:
//   payment.created / payment.updated   -> golf bay & event ticket confirmations
//   invoice.payment_made                -> admin-sent invoices (weddings, etc.)
//   subscription.created/updated/canceled -> wine club tracking
//   invoice.scheduled_charge_failed     -> notify management of failed renewal
//
// Required env vars:
//   SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_ENVIRONMENT
//   SENDGRID_API_KEY
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN
//   NETLIFY_AUTH_TOKEN
//
// Notification URL configured in Square Dashboard:
//   https://thequarrystl.com/.netlify/functions/square-webhook
// ============================================================================

const https = require('https');
const crypto = require('crypto');
const { google } = require('googleapis');

const WEBHOOK_URL = 'https://thequarrystl.com/.netlify/functions/square-webhook';

// ============================================================================
// Helpers - Square API
// ============================================================================
function squareApi(method, path) {
  const env = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase();
  const host = env === 'production' ? 'connect.squareup.com' : 'connect.squareupsandbox.com';
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: host,
      path: path,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
        'Square-Version': '2024-12-18',
        'Content-Type': 'application/json'
      }
    }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error('Square ' + res.statusCode + ': ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================
// Helpers - Email (SendGrid)
// ============================================================================
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName, category) {
  fromEmail = fromEmail || 'bookings@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(e) { return { email: e }; }) }],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: 'management@thequarrystl.com' },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: [category || 'quarry-square-webhook']
  });
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json'
      }
    }, function(res) {
      let body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body: body });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ============================================================================
// Helpers - Time / Calendar
// ============================================================================
function parseHourFromAmPm(t) {
  const m = (t || '').match(/(\d+):(\d+)\s*([AP]M)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return { hour: h, minute: min };
}
function buildIsoForCentral(dateStr, hour, minute) {
  const probe = new Date(dateStr + 'T12:00:00Z');
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
  const parts = fmt.formatToParts(probe);
  const tzAbbrev = (parts.find(function(p) { return p.type === 'timeZoneName'; }) || {}).value || 'CDT';
  const offset = tzAbbrev === 'CDT' ? '-05:00' : '-06:00';
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return dateStr + 'T' + hh + ':' + mm + ':00' + offset;
}
async function createCalendarEvent(summary, description, location, startIso, endIso, attendeeEmail) {
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN;
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !refreshToken) {
    console.warn('Google OAuth env vars not configured - skipping calendar event');
    return null;
  }
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const eventBody = {
      summary, description, location,
      start: { dateTime: startIso, timeZone: 'America/Chicago' },
      end: { dateTime: endIso, timeZone: 'America/Chicago' },
      reminders: { useDefault: false, overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 }
      ] }
    };
    if (attendeeEmail) eventBody.attendees = [{ email: attendeeEmail }];
    const res = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all',
      requestBody: eventBody
    });
    console.log('Calendar event created:', res.data.id);
    return res.data;
  } catch (err) {
    console.error('Calendar create failed:', err.message);
    return null;
  }
}

// ============================================================================
// Helpers - Blob storage
// ============================================================================
async function readBlob(path) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return null;
  const siteId = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
  try {
    const res = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + path, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function writeBlob(path, data) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) return;
  const siteId = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
  await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

// ============================================================================
// Signature verification
// ============================================================================
function verifySquareSignature(body, signatureHeader) {
  if (!signatureHeader || !process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(WEBHOOK_URL + body);
  const expected = hmac.digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (_) { return false; }
}

// ============================================================================
// Idempotency - record processed event IDs so a retry doesn't re-fire emails
// ============================================================================
async function alreadyProcessed(eventId) {
  if (!eventId) return false;
  const data = await readBlob('square-processed-events') || { ids: [] };
  return (data.ids || []).indexOf(eventId) !== -1;
}
async function markProcessed(eventId) {
  if (!eventId) return;
  const data = await readBlob('square-processed-events') || { ids: [] };
  let ids = data.ids || [];
  ids.push(eventId);
  if (ids.length > 1000) ids = ids.slice(-1000); // keep last 1000
  await writeBlob('square-processed-events', { ids: ids });
}

// ============================================================================
// Golf booking flow (mirrors old stripe-webhook handleGolfBooking)
// ============================================================================
async function handleGolfBooking(meta, amountStr, paymentId) {
  const m = meta || {};
  const extras = parseInt(m.extraBalls || '0', 10);
  const extrasPrice = parseInt(m.extraBallsPrice || '0', 10);
  m.extraBalls = extras;
  m.extraBallsPrice = extrasPrice;
  // Map Square metadata key names back to what existing email templates expect
  m.date = m.date || m.eventDate || '';
  m.time = m.time || m.eventTime || '';

  // 1) Customer email
  if (m.customerEmail) {
    try {
      await sendGridEmail(
        m.customerEmail,
        'Your Golf Booking is Confirmed - The Quarry',
        buildGolfCustomerHtml(m, amountStr),
        'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-golf-booking'
      );
    } catch (e) { console.error('golf customer email:', e.message); }
  }

  // 2) Owner email (management only - per memory, Jacqueline is wedding-only)
  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'New Golf Booking - ' + (m.bay || 'Bay') + ' on ' + (m.date || '?') + ' at ' + (m.time || '?'),
      buildGolfOwnerHtml(m, amountStr, paymentId),
      'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-golf-booking'
    );
  } catch (e) { console.error('golf owner email:', e.message); }

  // 3) Calendar event
  try {
    const start = parseHourFromAmPm(m.time);
    if (start && m.date) {
      const startIso = buildIsoForCentral(m.date, start.hour, start.minute);
      let endHour = start.hour;
      let endMin = start.minute + 50;
      if (endMin >= 60) { endHour += 1; endMin -= 60; }
      const endIso = buildIsoForCentral(m.date, endHour, endMin);
      const summary = (m.bay || 'Golf Bay') + ' - ' + (m.customerName || 'Customer');
      const lines = [];
      lines.push('Customer: ' + (m.customerName || '-'));
      lines.push('Email: ' + (m.customerEmail || '-'));
      if (m.customerPhone) lines.push('Phone: ' + m.customerPhone);
      lines.push('Players: ' + (m.players || '-'));
      lines.push('Duration: ' + (m.duration || '50 Minutes'));
      lines.push('Bay: ' + (m.bay || '-'));
      if (extras > 0) lines.push('Extras: ' + extras + ' extra balls (+$' + extrasPrice + ')');
      lines.push('Total Paid: ' + amountStr);
      if (paymentId) lines.push('Square Payment: ' + paymentId);
      await createCalendarEvent(summary, lines.join('\n'), 'The Quarry, 3960 Highway Z, New Melle, MO 63385', startIso, endIso, m.customerEmail);
    }
  } catch (e) { console.error('golf calendar:', e.message); }

  // 4) Persist booking - same canonical path as get-bookings.js / update-booking.js
  try {
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const path = 'golf-bookings/' + dateKey;
    const existing = await readBlob(path) || { bookings: [] };
    let bookings = existing.bookings || [];
    // Idempotency: replace any existing record with the same payment id
    if (paymentId) bookings = bookings.filter(function(b) { return (b.paymentId || b.sessionId || '') !== paymentId; });
    bookings.push({
      paymentId: paymentId || '',
      bay: m.bay, time: m.time, date: m.date, dateKey: dateKey,
      duration: m.duration || '50 Minutes',
      players: m.players, partySize: m.players,
      customerName: m.customerName, customerEmail: m.customerEmail, customerPhone: m.customerPhone,
      extraBalls: extras, extraBallsPrice: extrasPrice,
      amountPaid: amountStr,
      bookedAt: new Date().toISOString(),
      source: 'square'
    });
    await writeBlob(path, { bookings: bookings });
    console.log('Booking stored at', path, ':', m.bay, m.time);
  } catch (e) { console.error('golf store booking:', e.message); }
}

// ============================================================================
// Event-ticket flow (paid events)
// ============================================================================
async function handleEventTicket(meta, amountStr, paymentId) {
  const m = meta || {};
  if (m.customerEmail) {
    try {
      await sendGridEmail(
        m.customerEmail,
        'Your Tickets - ' + (m.eventName || 'The Quarry'),
        buildEventCustomerHtml(m, amountStr),
        'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-event-ticket'
      );
    } catch (e) { console.error('event customer email:', e.message); }
  }
  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'New Event Registration - ' + (m.eventName || 'event') + ' (' + (m.customerName || '?') + ')',
      buildEventOwnerHtml(m, amountStr, paymentId),
      'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-event-ticket'
    );
  } catch (e) { console.error('event owner email:', e.message); }

  // Increment registeredCount on events.json via data-store function (best effort)
  try {
    if (m.eventId && m.partySize) {
      const qty = parseInt(m.partySize, 10) || 1;
      await bumpEventRegistration(m.eventId, m.customerName, m.customerEmail, qty, paymentId);
    }
  } catch (e) { console.error('event registry bump:', e.message); }
}

async function bumpEventRegistration(eventId, name, email, qty, paymentId) {
  // Reads events.json via the static URL, updates the local in-memory copy,
  // then writes it back through data-store (which commits to GitHub).
  try {
    const events = await fetchJSON('https://thequarrystl.com/events.json');
    const list = events.events || [];
    const ev = list.find(function(e) { return e.id === eventId; });
    if (!ev) return;
    ev.registeredCount = (ev.registeredCount || 0) + qty;
    ev.registrations = ev.registrations || [];
    ev.registrations.push({
      name: name, email: email, qty: qty,
      paymentId: paymentId, registeredAt: new Date().toISOString()
    });
    if (ev.totalCapacity && ev.registeredCount >= ev.totalCapacity) ev.status = 'sold-out';

    // Write back via data-store (server-side persistence). data-store accepts an HTTP call.
    await fetch('https://thequarrystl.com/.netlify/functions/data-store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'events.json', data: events, key: process.env.DATA_STORE_KEY || '' })
    });
  } catch (e) { console.error('bumpEventRegistration:', e.message); }
}

function fetchJSON(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('parse fail ' + url)); }
      });
    }).on('error', reject);
  });
}

// ============================================================================
// Invoice flow (admin-sent invoices)
// ============================================================================
async function handleInvoicePaid(invoice) {
  try {
    const inv = invoice || {};
    const customerEmail = (inv.primary_recipient && inv.primary_recipient.email_address) || '';
    const customerName = (inv.primary_recipient && inv.primary_recipient.given_name)
      ? (inv.primary_recipient.given_name + ' ' + (inv.primary_recipient.family_name || '')).trim()
      : '';
    const amountStr = '$' + (((inv.payment_requests && inv.payment_requests[0] && inv.payment_requests[0].total_completed_amount_money && inv.payment_requests[0].total_completed_amount_money.amount) || 0) / 100).toFixed(2);
    await sendGridEmail(
      'management@thequarrystl.com',
      'Invoice paid - ' + (inv.title || inv.invoice_number || inv.id) + ' (' + amountStr + ')',
      '<h2 style="color:#B8933A">Invoice Paid</h2>' +
      '<p><b>Customer:</b> ' + (customerName || customerEmail || '-') + '</p>' +
      '<p><b>Invoice:</b> ' + (inv.title || inv.invoice_number || inv.id) + '</p>' +
      '<p><b>Amount:</b> ' + amountStr + '</p>' +
      '<p><b>Square ID:</b> ' + inv.id + '</p>',
      'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-invoice'
    );
  } catch (e) { console.error('handleInvoicePaid:', e.message); }
}

// ============================================================================
// Subscription flow (wine club)
// ============================================================================
async function handleSubscriptionEvent(eventType, subscription) {
  try {
    const sub = subscription || {};
    const subj = eventType === 'subscription.created' ? 'New Wine Club Member'
               : eventType === 'subscription.updated' ? 'Wine Club Subscription Updated'
               : 'Wine Club Subscription Event';
    await sendGridEmail(
      'management@thequarrystl.com',
      subj + ' (' + (sub.status || '?') + ')',
      '<h2 style="color:#B8933A">Wine Club ' + eventType + '</h2>' +
      '<p><b>Subscription ID:</b> ' + (sub.id || '-') + '</p>' +
      '<p><b>Customer ID:</b> ' + (sub.customer_id || '-') + '</p>' +
      '<p><b>Status:</b> ' + (sub.status || '-') + '</p>' +
      '<p><b>Plan Variation:</b> ' + (sub.plan_variation_id || '-') + '</p>' +
      '<p><b>Start:</b> ' + (sub.start_date || '-') + '</p>',
      'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-wine-club'
    );

    // Persist a lightweight wine-club roster
    const roster = await readBlob('wine-club-members') || { members: [] };
    let members = roster.members || [];
    members = members.filter(function(m) { return m.subscriptionId !== sub.id; });
    members.push({
      subscriptionId: sub.id,
      customerId: sub.customer_id,
      status: sub.status,
      startDate: sub.start_date,
      planVariationId: sub.plan_variation_id,
      lastEventAt: new Date().toISOString(),
      lastEventType: eventType
    });
    await writeBlob('wine-club-members', { members: members });
  } catch (e) { console.error('handleSubscriptionEvent:', e.message); }
}

async function handleScheduledChargeFailed(invoice) {
  try {
    const inv = invoice || {};
    const customer = (inv.primary_recipient && inv.primary_recipient.email_address) || '-';
    await sendGridEmail(
      'management@thequarrystl.com',
      'ACTION NEEDED: Subscription payment failed - ' + customer,
      '<h2 style="color:#c00">Subscription Payment Failed</h2>' +
      '<p>A scheduled subscription charge failed in Square.</p>' +
      '<p><b>Customer:</b> ' + customer + '</p>' +
      '<p><b>Invoice:</b> ' + (inv.title || inv.invoice_number || inv.id) + '</p>' +
      '<p>Reach out to the customer to update their card on file.</p>',
      'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-wine-club'
    );
  } catch (e) { console.error('handleScheduledChargeFailed:', e.message); }
}

// ============================================================================
// Email templates
// ============================================================================
function buildGolfCustomerHtml(m, amount) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
    '<p>Hi ' + (m.customerName || 'there') + ', your bay is reserved.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Bay:</b> ' + (m.bay || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> ' + (m.date || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (m.time || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Duration:</b> ' + (m.duration || '50 Minutes') + '</p>' +
    '<p style="margin:4px 0"><b>Players:</b> ' + (m.players || '-') + '</p>' +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
    '<p>You should also receive a Google Calendar invite at <b>' + (m.customerEmail || 'your email') + '</b>. Arrive about 10 minutes early to check in.</p>' +
    '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
    '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a>.</p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}
function buildGolfOwnerHtml(m, amount, paymentId) {
  const extras = parseInt(m.extraBalls || '0', 10);
  return '<h2 style="color:#B8933A;font-family:Arial,sans-serif">New Golf Bay Booking</h2>' +
    '<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Name</b></td><td>' + (m.customerName || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Email</b></td><td>' + (m.customerEmail || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Phone</b></td><td>' + (m.customerPhone || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Bay</b></td><td>' + (m.bay || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Date</b></td><td>' + (m.date || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Time</b></td><td>' + (m.time || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Duration</b></td><td>' + (m.duration || '50 Minutes') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Players</b></td><td>' + (m.players || '-') + '</td></tr>' +
    (extras > 0 ? '<tr><td style="padding:4px 12px 4px 0"><b>Extras</b></td><td>' + extras + ' extra balls (+$' + (m.extraBallsPrice || 0) + ')</td></tr>' : '') +
    '<tr><td style="padding:4px 12px 4px 0"><b>Total Paid</b></td><td>' + amount + '</td></tr>' +
    (paymentId ? '<tr><td style="padding:4px 12px 4px 0"><b>Square Payment</b></td><td><code>' + paymentId + '</code></td></tr>' : '') +
    '</table>' +
    '<p style="font-family:Arial,sans-serif;font-size:13px;color:#666">A Google Calendar event has been added to the primary calendar with this reservation.</p>';
}
function buildEventCustomerHtml(m, amount) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You are confirmed!</h2>' +
    '<p>Hi ' + (m.customerName || 'there') + ', your tickets to <b>' + (m.eventName || 'our event') + '</b> are confirmed.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Event:</b> ' + (m.eventName || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Party size:</b> ' + (m.partySize || '1') + '</p>' +
    (m.ticketTier ? '<p style="margin:4px 0"><b>Tier:</b> ' + m.ticketTier + '</p>' : '') +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
    '<p>We will see you soon. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}
function buildEventOwnerHtml(m, amount, paymentId) {
  return '<h2 style="color:#B8933A">New Event Ticket Sale</h2>' +
    '<p><b>Event:</b> ' + (m.eventName || '-') + '</p>' +
    '<p><b>Customer:</b> ' + (m.customerName || '-') + ' (' + (m.customerEmail || '-') + ')</p>' +
    '<p><b>Phone:</b> ' + (m.customerPhone || '-') + '</p>' +
    '<p><b>Party size:</b> ' + (m.partySize || '1') + '</p>' +
    (m.ticketTier ? '<p><b>Tier:</b> ' + m.ticketTier + '</p>' : '') +
    '<p><b>Total Paid:</b> ' + amount + '</p>' +
    (paymentId ? '<p><b>Square Payment:</b> <code>' + paymentId + '</code></p>' : '');
}

// ============================================================================
// Main webhook entrypoint
// ============================================================================
exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const sig = event.headers['x-square-hmacsha256-signature']
           || event.headers['X-Square-Hmacsha256-Signature']
           || event.headers['x-square-signature'];
  const rawBody = event.body || '';

  if (!verifySquareSignature(rawBody, sig)) {
    console.error('Square webhook signature verification failed');
    return { statusCode: 403, body: JSON.stringify({ error: 'Signature verification failed' }) };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const type = payload.type || '';
  const data = (payload.data && payload.data.object) || {};
  const eventId = payload.event_id;

  console.log('Square webhook:', type, eventId);

  if (await alreadyProcessed(eventId)) {
    console.log('Already processed', eventId, '- skipping');
    return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
  }

  try {
    switch (type) {
      case 'payment.created':
      case 'payment.updated': {
        const payment = data.payment || {};
        // Only act on successful captures
        if (payment.status !== 'COMPLETED' && payment.status !== 'APPROVED') {
          console.log('Payment status not actionable:', payment.status);
          break;
        }
        if (!payment.order_id) {
          console.log('Payment has no order_id - skipping');
          break;
        }
        // Fetch the order to read metadata
        const orderRes = await squareApi('GET', '/v2/orders/' + payment.order_id);
        const order = orderRes.order || {};
        const meta = order.metadata || {};
        const amountCents = (payment.total_money && payment.total_money.amount) || (payment.amount_money && payment.amount_money.amount) || 0;
        const amountStr = '$' + (amountCents / 100).toFixed(2);

        if (meta.bookingType === 'golf') {
          await handleGolfBooking(meta, amountStr, payment.id);
        } else if (meta.bookingType === 'event' || meta.eventId) {
          await handleEventTicket(meta, amountStr, payment.id);
        } else {
          console.log('Payment with unknown bookingType - logged only:', meta);
        }
        break;
      }

      case 'invoice.payment_made':
      case 'invoice.paid': {
        await handleInvoicePaid(data.invoice);
        break;
      }

      case 'invoice.scheduled_charge_failed':
      case 'invoice.canceled':
      case 'invoice.refunded': {
        await handleScheduledChargeFailed(data.invoice);
        break;
      }

      case 'subscription.created':
      case 'subscription.updated':
      case 'subscription.canceled':
      case 'subscription.deactivated': {
        await handleSubscriptionEvent(type, data.subscription);
        break;
      }

      default:
        console.log('Unhandled Square event type:', type);
    }

    await markProcessed(eventId);
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('square-webhook error:', err);
    // Return 200 anyway so Square doesn't keep retrying a malformed event forever.
    return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
  }
};
