const Stripe = require('stripe');
const AWS = require('aws-sdk');
const https = require('https');

// Initialize AWS SES
const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

// GitHub API helper
function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Webhook',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Send email via AWS SES
async function sendEmail(to, subject, htmlBody) {
  const params = {
    Source: 'The Quarry STL <management@thequarrystl.com>',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  };
  return ses.sendEmail(params).promise();
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  if (evt.type === 'checkout.session.completed') {
    const session = evt.data.object;
    const {
      eventId,
      eventName,
      customerName,
      customerEmail,
      customerPhone,
      partySize,
      seatType,
      tableId,
      ticketTier,
      couponCode
    } = session.metadata || {};

    if (!eventId) return { statusCode: 200, body: 'No eventId — not an event registration' };

    const name = customerName || '';
    const email = customerEmail || session.customer_email || '';
    const phone = customerPhone || '';
    const qty = parseInt(partySize) || 1;
    const amountCents = session.amount_total || 0;
    const amountDollars = (amountCents / 100).toFixed(2);
    const amountDisplay = '$' + amountDollars;

    // Build registration record
    const newReg = {
      orderNumber: session.id,
      name,
      email,
      phone,
      tickets: qty,
      amount: amountDollars,
      status: 'PAID',
      paymentMethod: 'stripe',
      transactionId: session.payment_intent || session.id,
      created: new Date().toISOString(),
      seatType: seatType || '',
      tableId: tableId || '',
      ticketTier: ticketTier || '',
      couponCode: couponCode || ''
    };

    // --- 1. Update events.json in GitHub (registration record + seat count) ---
    try {
      const ghToken = process.env.GITHUB_TOKEN;
      if (ghToken) {
        const repo = 'quarrymanagement/quarry-website';
        const filePath = 'events.json';

        const shaRes = await githubRequest('GET', '/repos/' + repo + '/contents/' + filePath, ghToken);
        if (shaRes.statusCode === 200 && shaRes.data.content) {
          const currentContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
          const eventsData = JSON.parse(currentContent);

          // Add registration record
          if (!eventsData.registrations) eventsData.registrations = {};
          if (!eventsData.registrations[eventId]) eventsData.registrations[eventId] = [];
          eventsData.registrations[eventId].push(newReg);

          // Update registeredCount on the event
          const eventObj = (eventsData.events || []).find(function(e) { return e.id === eventId; });
          if (eventObj) {
            const totalRegs = eventsData.registrations[eventId].reduce(function(sum, r) {
              return sum + (r.tickets || 1);
            }, 0);
            eventObj.registeredCount = totalRegs;
            eventObj.registered = totalRegs;

            // Mark sold out if at capacity
            if (eventObj.totalCapacity && totalRegs >= eventObj.totalCapacity) {
              eventObj.status = 'sold-out';
            }
          }

          // Push updated file back to GitHub
          const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
          await githubRequest('PUT', '/repos/' + repo + '/contents/' + filePath, ghToken, {
            message: 'Registration: ' + name + ' for ' + (eventName || eventId) + ' (' + qty + ' ticket' + (qty > 1 ? 's' : '') + ')',
            content: encoded,
            sha: shaRes.data.sha
          });
          console.log('events.json updated — registeredCount incremented for', eventId);
        }
      } else {
        console.error('No GITHUB_TOKEN — cannot update events.json');
      }
    } catch (e) {
      console.error('GitHub events.json update error:', e.message);
    }

    // --- 2. Backup to Netlify Blobs ---
    try {
      const token = process.env.NETLIFY_AUTH_TOKEN;
      const siteId = process.env.SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
      if (token) {
        let blobRegistrations = [];
        try {
          const r = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/quarry-registrations/event-' + eventId, {
            headers: { Authorization: 'Bearer ' + token }
          });
          if (r.ok) {
            const d = await r.json();
            blobRegistrations = d.registrations || [];
          }
        } catch (e) {}

        blobRegistrations.push({
          name, email, phone,
          partySize: qty, seatType,
          tableId: tableId || null,
          ticketTier: ticketTier || null,
          stripeSessionId: session.id,
          amountPaid: amountCents,
          registeredAt: new Date().toISOString()
        });

        await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/quarry-registrations/event-' + eventId, {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ registrations: blobRegistrations })
        });
        console.log('Netlify Blobs backup saved for', eventId);
      }
    } catch (e) {
      console.error('Netlify Blobs error:', e.message);
    }

    // --- 3. Send confirmation email to the CUSTOMER via AWS SES ---
    if (email) {
      try {
        const customerHtml =
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px;background:#FFFFFF">' +
          '<h2 style="color:#2C1A0E;margin-top:0">You\'re Registered!</h2>' +
          '<p style="color:#444">Hi ' + name + ', your registration has been confirmed and your payment has been processed.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
          '<p style="margin:6px 0"><strong>Event:</strong> ' + (eventName || 'The Quarry Event') + '</p>' +
          (ticketTier ? '<p style="margin:6px 0"><strong>Ticket:</strong> ' + ticketTier + '</p>' : '') +
          '<p style="margin:6px 0"><strong>Quantity:</strong> ' + qty + '</p>' +
          '<p style="margin:6px 0"><strong>Seat Type:</strong> ' + (seatType || 'General') + '</p>' +
          '<p style="margin:6px 0;color:#B8933A;font-size:1.1em"><strong>Total Paid: ' + amountDisplay + '</strong></p></div>' +
          '<p style="color:#444">We look forward to seeing you! If you have any questions, feel free to reach out.</p>' +
          '<p style="color:#444">Call us: <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a><br>' +
          'Email: <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
          '<div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>';

        await sendEmail(email, 'Registration Confirmed — ' + (eventName || 'The Quarry Event'), customerHtml);
        console.log('Customer confirmation email sent to', email);
      } catch (e) {
        console.error('Customer email error:', e.message);
      }
    }

    // --- 4. Send notification email to MANAGEMENT via AWS SES ---
    try {
      const ownerHtml =
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center">' +
        '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW EVENT REGISTRATION</p></div>' +
        '<div style="padding:32px 24px;background:#FFFFFF">' +
        '<h2 style="color:#2C1A0E;margin-top:0">New Registration Received</h2>' +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
        '<p style="margin:6px 0"><strong>Event:</strong> ' + (eventName || 'N/A') + '</p>' +
        '<p style="margin:6px 0"><strong>Name:</strong> ' + name + '</p>' +
        '<p style="margin:6px 0"><strong>Email:</strong> ' + email + '</p>' +
        '<p style="margin:6px 0"><strong>Phone:</strong> ' + (phone || 'N/A') + '</p>' +
        '<p style="margin:6px 0"><strong>Seat Type:</strong> ' + (seatType || 'N/A') + '</p>' +
        (ticketTier ? '<p style="margin:6px 0"><strong>Ticket Tier:</strong> ' + ticketTier + '</p>' : '') +
        '<p style="margin:6px 0"><strong>Quantity:</strong> ' + qty + '</p>' +
        (couponCode ? '<p style="margin:6px 0"><strong>Coupon Used:</strong> ' + couponCode + '</p>' : '') +
        '<p style="margin:6px 0;color:#B8933A;font-size:1.1em"><strong>Amount Paid: ' + amountDisplay + '</strong></p>' +
        '<p style="margin:6px 0;color:#888;font-size:0.85em">Transaction: ' + (session.payment_intent || session.id) + '</p></div>' +
        '</div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>';

      await sendEmail('management@thequarrystl.com', 'New Registration — ' + (eventName || 'Event') + ' — ' + name, ownerHtml);
      console.log('Owner notification email sent to management@thequarrystl.com');
    } catch (e) {
      console.error('Owner email error:', e.message);
    }

    // --- 5. Submit to Netlify Forms (backup) ---
    try {
      const siteId = process.env.SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
      await fetch('https://' + siteId + '.netlify.app/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          'form-name': 'event-registration',
          eventId,
          eventName: eventName || '',
          name,
          email,
          phone,
          partySize: String(qty),
          seatType: seatType || '',
          tableId: tableId || '',
          amountPaid: amountDollars
        }).toString()
      });
    } catch (e) {
      console.error('Netlify Forms submission error:', e.message);
    }

    console.log('Registration webhook complete for', name, '—', eventName);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};