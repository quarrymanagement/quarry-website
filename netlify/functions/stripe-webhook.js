// ============================================================================
// stripe-webhook.js
//
// Handles Stripe webhook events for The Quarry. Most important branch is
// `checkout.session.completed` — fired the moment a customer finishes paying.
// For golf bay bookings (metadata.bookingType === 'golf') we:
//   1. Send a confirmation email to the customer
//   2. Send a notification email to management@thequarrystl.com
//   3. Create a Google Calendar event on the primary calendar so the team can
//      see the reservation alongside other Quarry events
//   4. Persist the booking to events.json's bookings table (best-effort)
//
// Required env vars:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET   (Stripe)
//   SENDGRID_API_KEY                            (transactional email)
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//                                               (same OAuth used by gcal-events.js)
// ============================================================================

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const { google } = require('googleapis');

// ----- Email helper (SendGrid via raw HTTPS so we don't need a new dep) -----
function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'bookings@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map((email) => ({ email })) }],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: 'management@thequarrystl.com' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-golf-booking']
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode, body });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ----- Time helpers -----
function parseHourFromAmPm(t) {
  // "5:00 PM" -> 17.  "11:00 AM" -> 11.
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
  // dateStr is "YYYY-MM-DD". We construct an ISO string with the right
  // -05:00 / -06:00 offset for America/Chicago on that date so Google
  // Calendar accepts it as the local time the customer sees.
  const probe = new Date(dateStr + 'T12:00:00Z');
  // Get the offset Chicago is from UTC on that date (handles DST)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'short',
  });
  const parts = fmt.formatToParts(probe);
  const tzAbbrev = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'CDT';
  const offset = tzAbbrev === 'CDT' ? '-05:00' : '-06:00';
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return dateStr + 'T' + hh + ':' + mm + ':00' + offset;
}

// ----- Google Calendar event creation -----
async function createGoogleCalendarEvent(summary, description, location, startIso, endIso, attendeeEmail) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    console.warn('Google OAuth env vars not configured — skipping calendar event');
    return null;
  }
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const eventBody = {
      summary,
      description,
      location,
      start: { dateTime: startIso, timeZone: 'America/Chicago' },
      end:   { dateTime: endIso,   timeZone: 'America/Chicago' },
      reminders: { useDefault: false, overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'email', minutes: 1440 }
      ] }
    };
    if (attendeeEmail) {
      eventBody.attendees = [{ email: attendeeEmail }];
    }

    const res = await calendar.events.insert({
      calendarId: 'primary',
      sendUpdates: 'all', // sends invite to attendees so they get a calendar invite too
      requestBody: eventBody,
    });
    console.log('Google Calendar event created:', res.data.id, res.data.htmlLink);
    return res.data;
  } catch (err) {
    console.error('Calendar event create failed:', err.message);
    return null;
  }
}

// ----- Booking storage (best effort, mirrors the helper from create-checkout) -----
async function storeBooking(m, amountStr) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    if (!token) { console.warn('NETLIFY_AUTH_TOKEN missing - skipping blob store'); return; }
    const siteId = 'roaring-pegasus-444826';
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const key = encodeURIComponent('golf-' + dateKey);
    const url = 'https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key;
    const existing = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    let bookings = [];
    if (existing.ok) { try { bookings = (await existing.json()).bookings || []; } catch (_) {} }
    bookings.push({
      bay: m.bay,
      time: m.time,
      date: m.date,
      duration: m.duration,
      players: m.players,
      name: m.customerName,
      email: m.customerEmail,
      phone: m.customerPhone,
      extraBalls: m.extraBalls,
      extraBallsPrice: m.extraBallsPrice,
      amountPaid: amountStr,
      bookedAt: new Date().toISOString()
    });
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookings })
    });
    console.log('Booking stored:', m.bay, m.date, m.time);
  } catch (e) {
    console.error('storeBooking error:', e.message);
  }
}

// ----- Email templates -----
function buildCustomerHtml(m, amountStr, extrasLine) {
  return (
    '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center">' +
    '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px">' +
    '<h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
    '<p>Hi ' + (m.customerName || 'there') + ', your bay is reserved.</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Bay:</b> ' + (m.bay || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> ' + (m.date || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Time:</b> ' + (m.time || '-') + '</p>' +
    '<p style="margin:4px 0"><b>Duration:</b> ' + (m.duration || '50 Minutes') + '</p>' +
    '<p style="margin:4px 0"><b>Players:</b> ' + (m.players || '-') + '</p>' +
    extrasLine +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amountStr + '</b></p></div>' +
    '<p>You should also receive a Google Calendar invite at <b>' + (m.customerEmail || 'your email') + '</b>. Arrive about 10 minutes early to check in.</p>' +
    '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
    '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a>.</p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
  );
}

function buildOwnerHtml(m, amountStr, extrasLine, sessionId) {
  return (
    '<h2 style="color:#B8933A;font-family:Arial,sans-serif">New Golf Bay Booking</h2>' +
    '<table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Name</b></td><td>' + (m.customerName || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Email</b></td><td>' + (m.customerEmail || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Phone</b></td><td>' + (m.customerPhone || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Bay</b></td><td>' + (m.bay || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Date</b></td><td>' + (m.date || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Time</b></td><td>' + (m.time || '-') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Duration</b></td><td>' + (m.duration || '50 Minutes') + '</td></tr>' +
    '<tr><td style="padding:4px 12px 4px 0"><b>Players</b></td><td>' + (m.players || '-') + '</td></tr>' +
    (extrasLine ? '<tr><td style="padding:4px 12px 4px 0"><b>Extras</b></td><td>' + (m.extraBalls > 0 ? m.extraBalls + ' extra balls (+$' + m.extraBallsPrice + ')' : 'None') + '</td></tr>' : '') +
    '<tr><td style="padding:4px 12px 4px 0"><b>Total Paid</b></td><td>' + amountStr + '</td></tr>' +
    (sessionId ? '<tr><td style="padding:4px 12px 4px 0"><b>Stripe Session</b></td><td><code>' + sessionId + '</code></td></tr>' : '') +
    '</table>' +
    '<p style="font-family:Arial,sans-serif;font-size:13px;color:#666">A Google Calendar event has been added to the primary calendar with this reservation.</p>'
  );
}

// ----- Main golf-booking handler -----
async function handleGolfBooking(session) {
  const m = session.metadata || {};
  const amountStr = '$' + ((session.amount_total || 0) / 100).toFixed(2);
  const extras = parseInt(m.extraBalls || '0', 10);
  const extrasPrice = parseInt(m.extraBallsPrice || '0', 10);
  const extrasLine = extras > 0
    ? '<p style="margin:4px 0"><b>Extras:</b> ' + extras + ' extra balls (+$' + extrasPrice + ')</p>'
    : '';
  // Make sure metadata exposes a number where we'll need one
  m.extraBalls = extras;
  m.extraBallsPrice = extrasPrice;

  // 1) Send customer email
  if (m.customerEmail) {
    try {
      await sendGridEmail(
        m.customerEmail,
        'Your Golf Booking is Confirmed - The Quarry',
        buildCustomerHtml(m, amountStr, extrasLine)
      );
      console.log('Customer email sent to', m.customerEmail);
    } catch (e) { console.error('customer email error:', e.message); }
  }

  // 2) Send owner email to management@thequarrystl.com
  try {
    await sendGridEmail(
      ['management@thequarrystl.com', 'jacqueline@thequarrystl.com'],
      'New Golf Booking - ' + (m.bay || 'Bay') + ' on ' + (m.date || '?') + ' at ' + (m.time || '?'),
      buildOwnerHtml(m, amountStr, extrasLine, session.id)
    );
    console.log('Owner email sent to management@thequarrystl.com');
  } catch (e) { console.error('owner email error:', e.message); }

  // 3) Add to Google Calendar
  try {
    const start = parseHourFromAmPm(m.time);
    if (start && m.date) {
      const startIso = buildIsoForCentral(m.date, start.hour, start.minute);
      // Sessions are 50 min — end = start + 50 min
      let endHour = start.hour;
      let endMin  = start.minute + 50;
      if (endMin >= 60) { endHour += 1; endMin -= 60; }
      const endIso   = buildIsoForCentral(m.date, endHour, endMin);
      const summary  = (m.bay || 'Golf Bay') + ' - ' + (m.customerName || 'Customer');
      const lines = [];
      lines.push('Customer: ' + (m.customerName || '-'));
      lines.push('Email: '    + (m.customerEmail || '-'));
      if (m.customerPhone) lines.push('Phone: ' + m.customerPhone);
      lines.push('Players: ' + (m.players || '-'));
      lines.push('Duration: ' + (m.duration || '50 Minutes'));
      lines.push('Bay: ' + (m.bay || '-'));
      if (extras > 0) lines.push('Extras: ' + extras + ' extra balls (+$' + extrasPrice + ')');
      lines.push('Total Paid: ' + amountStr);
      if (session.id) lines.push('Stripe Session: ' + session.id);
      const description = lines.join('\n');
      const location = 'The Quarry, 3960 Highway Z, New Melle, MO 63385';
      await createGoogleCalendarEvent(summary, description, location, startIso, endIso, m.customerEmail);
    } else {
      console.warn('Could not parse time/date for calendar event:', m.date, m.time);
    }
  } catch (e) { console.error('calendar event error:', e.message); }

  // 4) Persist booking
  try { await storeBooking(m, amountStr); } catch (e) { console.error('store booking error:', e.message); }
}

// ----- Webhook entry point -----
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if (!signature) {
      console.error('Missing Stripe signature header');
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing signature' }) };
    }

    let webhookEvent;
    try {
      webhookEvent = stripe.webhooks.constructEvent(
        event.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Stripe signature verification failed:', err.message);
      return { statusCode: 403, body: JSON.stringify({ error: 'Signature verification failed' }) };
    }

    console.log('Received webhook event:', webhookEvent.type, webhookEvent.id);

    switch (webhookEvent.type) {
      case 'checkout.session.completed': {
        const session = webhookEvent.data.object;
        const md = session.metadata || {};
        // Branch on bookingType so other future flows (events, weddings) can plug in
        if (md.bookingType === 'golf' || md.bay) {
          await handleGolfBooking(session);
        } else {
          console.log('checkout.session.completed for non-golf flow — no handler:', md);
        }
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'customer.subscription.created':
      case 'customer.subscription.deleted':
        console.log('Logged-only event:', webhookEvent.type);
        break;

      default:
        console.log('Unhandled webhook event type:', webhookEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error('Webhook error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
