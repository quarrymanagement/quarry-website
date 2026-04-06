const Stripe = require('stripe');
const https = require('https');

// GitHub API helper (same approach as save-events.js)
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

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
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
      ticketTier
    } = session.metadata || {};

    if (!eventId) return { statusCode: 200, body: 'No eventId' };

    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const name = customerName || '';
    const email = customerEmail || session.customer_email || '';
    const phone = customerPhone || '';
    const amountDollars = session.amount_total ? (session.amount_total / 100).toFixed(2) : '0.00';
    const amountDisplay = '$' + amountDollars;
    const qty = parseInt(partySize) || 1;

    // Build registration record (matching the format used by existing Wix registrations)
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
      ticketTier: ticketTier || ''
    };

    // 1. Store in Netlify Blobs (backup)
    let blobRegistrations = [];
    try {
      const r = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`, {
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
      amountPaid: session.amount_total,
      registeredAt: new Date().toISOString()
    });

    await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrations: blobRegistrations })
    });

    // 2. Update events.json in GitHub so the admin panel sees the registration
    try {
      const ghToken = process.env.GITHUB_TOKEN;
      if (ghToken) {
        const repo = 'quarrymanagement/quarry-website';
        const filePath = 'events.json';

        // Get current events.json
        const shaRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`, ghToken);
        if (shaRes.statusCode === 200 && shaRes.data.content) {
          const currentContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
          const eventsData = JSON.parse(currentContent);

          // Add registration to the registrations object
          if (!eventsData.registrations) eventsData.registrations = {};
          if (!eventsData.registrations[eventId]) eventsData.registrations[eventId] = [];
          eventsData.registrations[eventId].push(newReg);

          // Also update the registeredCount on the event itself
          const eventObj = (eventsData.events || []).find(e => e.id === eventId);
          if (eventObj) {
            const totalRegs = eventsData.registrations[eventId].reduce((sum, r) => sum + (r.tickets || 1), 0);
            eventObj.registeredCount = totalRegs;
            eventObj.registered = totalRegs;

            // Mark sold out if at capacity
            if (eventObj.totalCapacity && totalRegs >= eventObj.totalCapacity) {
              eventObj.status = 'sold-out';
            }
          }

          // Push updated file back to GitHub
          const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
          await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, ghToken, {
            message: 'New registration: ' + name + ' for ' + (eventName || eventId),
            content: encoded,
            sha: shaRes.data.sha
          });
          console.log('events.json updated with new registration for', eventId);
        }
      } else {
        console.log('No GITHUB_TOKEN — skipping events.json update');
      }
    } catch (e) {
      console.error('GitHub events.json update error:', e.message);
    }

    // 3. Submit to Netlify Forms
    try {
      await fetch(`https://${siteId}.netlify.app/`, {
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
          seatType,
          tableId: tableId || '',
          amountPaid: amountDollars
        }).toString()
      });
    } catch (e) {}

    // 4. Send confirmation email to the customer
    if (email) {
      await sendCustomerEmail(token, siteId, {
        name, email, eventName, seatType, partySize: String(qty), amount: amountDisplay, ticketTier
      });
    }

    // 5. Send notification email to the owner
    await sendOwnerEmail(token, siteId, {
      name, email, phone, eventName, seatType, partySize: String(qty), amount: amountDisplay, ticketTier
    });
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function sendOwnerEmail(token, siteId, data) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        from: 'events@thequarrystl.com',
        to: 'management@thequarrystl.com',
        subject: 'New Event Registration — ' + (data.eventName || 'Event'),
        html:
          '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px">' +
          '<h2 style="color:#2C1A0E">New Event Registration</h2>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Event:</b> ' + (data.eventName || 'N/A') + '</p>' +
          '<p style="margin:4px 0"><b>Name:</b> ' + data.name + '</p>' +
          '<p style="margin:4px 0"><b>Email:</b> ' + data.email + '</p>' +
          '<p style="margin:4px 0"><b>Phone:</b> ' + (data.phone || 'N/A') + '</p>' +
          '<p style="margin:4px 0"><b>Seat Type:</b> ' + (data.seatType || 'N/A') + '</p>' +
          (data.ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + data.ticketTier + '</p>' : '') +
          '<p style="margin:4px 0"><b>Party Size:</b> ' + (data.partySize || '1') + '</p>' +
          '<p style="margin:4px 0;color:#B8933A"><b>Total: ' + data.amount + '</b></p></div>' +
          '</div></div>',
        siteId
      })
    });
    console.log('Owner event email status:', res.status);
  } catch (e) {
    console.error('sendOwnerEmail error:', e.message);
  }
}

async function sendCustomerEmail(token, siteId, data) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        from: 'events@thequarrystl.com',
        to: data.email,
        subject: 'Registration Confirmed — ' + (data.eventName || 'The Quarry Event'),
        html:
          '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px">' +
          '<h2 style="color:#2C1A0E">You\'re Registered!</h2>' +
          '<p>Hi ' + data.name + ', your registration is confirmed.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Event:</b> ' + (data.eventName || 'The Quarry Event') + '</p>' +
          '<p style="margin:4px 0"><b>Seat Type:</b> ' + (data.seatType || 'N/A') + '</p>' +
          (data.ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + data.ticketTier + '</p>' : '') +
          '<p style="margin:4px 0"><b>Party Size:</b> ' + (data.partySize || '1') + '</p>' +
          '<p style="margin:4px 0;color:#B8933A"><b>Total Paid: ' + data.amount + '</b></p></div>' +
          '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
          '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
          '<div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
        siteId
      })
    });
    console.log('Customer event email status:', res.status);
  } catch (e) {
    console.error('sendCustomerEmail error:', e.message);
  }
}
