// ============================================================================
// backfill-rideforzesa-emails.js
// One-off: send back-dated customer confirmation + owner notification emails
// for the 3 Ride for Zesa Square payments that didn't trigger our webhook.
// Hit: /.netlify/functions/backfill-rideforzesa-emails?token=quarry2026
// ============================================================================
const https = require('https');

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
    categories: [category || 'quarry-event-ticket-backfill']
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
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function buildCustomerHtml(m, amount) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
    '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You are confirmed!</h2>' +
    '<p>Hi ' + (m.customerName || 'there') + ', your registration for <b>' + m.eventName + '</b> is confirmed.</p>' +
    '<p style="color:#666;font-size:13px;font-style:italic">(This is a back-dated confirmation. We had a webhook hiccup that delayed your receipt. Your payment was processed successfully on the date below.)</p>' +
    '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
    '<p style="margin:4px 0"><b>Event:</b> ' + m.eventName + '</p>' +
    '<p style="margin:4px 0"><b>Date:</b> Saturday, July 11, 2026</p>' +
    '<p style="margin:4px 0"><b>Check-in:</b> 10:00 AM at The Quarry (brunch)</p>' +
    '<p style="margin:4px 0"><b>Return:</b> 5:00 PM (check back in by 4:30 PM)</p>' +
    '<p style="margin:4px 0"><b>Party size:</b> ' + m.partySize + '</p>' +
    '<p style="margin:4px 0"><b>Tier:</b> ' + m.ticketTier + '</p>' +
    '<p style="margin:4px 0"><b>Payment date:</b> ' + m.paidDate + '</p>' +
    '<p style="margin:8px 0 4px;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
    '<p>The route: The Quarry &rarr; Liz\'s Bar &amp; Grill &rarr; Treloar Bar &amp; Grill &rarr; Cori\'s Twin Gables &rarr; back to The Quarry. Draw a card at each stop; best hand wins.</p>' +
    '<p>All proceeds go to Zesa Bollinger. Thank you for riding for her.</p>' +
    '<p>Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p></div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

function buildOwnerHtml(m, amount) {
  return '<h2 style="color:#B8933A">New Event Ticket Sale (backfilled)</h2>' +
    '<p style="color:#a00"><b>Note:</b> This payment came through Square but did not trigger the webhook. ' +
    'You are receiving this owner notification via a one-time backfill. ' +
    'Please verify the Square webhook subscription in Square Dashboard &rarr; Developer &rarr; Webhooks ' +
    'so future Ride for Zesa registrations notify automatically.</p>' +
    '<p><b>Event:</b> ' + m.eventName + '</p>' +
    '<p><b>Customer:</b> ' + m.customerName + ' (' + m.customerEmail + ')</p>' +
    '<p><b>Party size:</b> ' + m.partySize + '</p>' +
    '<p><b>Tier:</b> ' + m.ticketTier + '</p>' +
    '<p><b>Total Paid:</b> ' + amount + '</p>' +
    '<p><b>Paid on:</b> ' + m.paidDate + '</p>' +
    '<p><b>Square Payment ID:</b> <code>' + m.paymentId + '</code></p>';
}

const ORPHANS = [
  {
    paymentId: 'Jw0H2JETThprCOi4uzMS4W3PLb6YY',
    paidDate: 'May 22, 2026',
    customerName: 'Rob',
    customerEmail: 'robwarmann@hotmail.com',
    partySize: '2',
    ticketTier: '1x Driver + 1x Passenger',
    eventName: 'Ride for Zesa - Side by Side Poker Run',
    amount: '$35.00'
  },
  {
    paymentId: '5adlpdHTXFyLMNxRSvZtIHDwIOFZY',
    paidDate: 'May 26, 2026',
    customerName: 'Carla Brakensiek',
    customerEmail: 'carla@catalafacialretreat.com',
    partySize: '4',
    ticketTier: '1x Driver + 3x Passenger',
    eventName: 'Ride for Zesa - Side by Side Poker Run',
    amount: '$55.00'
  },
  {
    paymentId: 'nH6Eakh8oUlPBSG4Eg4TNI2JpgEZY',
    paidDate: 'May 26, 2026',
    customerName: 'Mike and Vicky Drummond',
    customerEmail: 'mikedrummond4@gmail.com',
    partySize: '2',
    ticketTier: '1x Driver + 1x Passenger',
    eventName: 'Ride for Zesa - Side by Side Poker Run',
    amount: '$35.00'
  }
];

exports.handler = async function(event) {
  const qs = event.queryStringParameters || {};
  if (qs.token !== 'quarry2026') {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }
  // Optional dry-run for safety
  const dryRun = qs.dry === '1';

  const results = [];
  for (const o of ORPHANS) {
    const r = { paymentId: o.paymentId, customer: o.customerName, customerEmailSent: false, ownerEmailSent: false, errors: [] };
    if (dryRun) {
      r.dryRun = true;
      results.push(r);
      continue;
    }
    try {
      await sendGridEmail(
        o.customerEmail,
        'Your Ride for Zesa Registration - ' + o.eventName,
        buildCustomerHtml(o, o.amount),
        'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-event-ticket-backfill'
      );
      r.customerEmailSent = true;
    } catch (e) { r.errors.push('customer: ' + e.message); }
    try {
      await sendGridEmail(
        'management@thequarrystl.com',
        'New Event Registration (backfill) - Ride for Zesa - ' + o.customerName,
        buildOwnerHtml(o, o.amount),
        'bookings@thequarrystl.com', 'The Quarry STL', 'quarry-event-ticket-backfill'
      );
      r.ownerEmailSent = true;
    } catch (e) { r.errors.push('owner: ' + e.message); }
    results.push(r);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun, count: ORPHANS.length, results }, null, 2)
  };
};
