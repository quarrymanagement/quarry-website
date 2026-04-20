const Stripe = require('stripe');
const AWS = require('aws-sdk');
const https = require('https');

// ─── AWS SES ───
const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

async function sendEmail(to, subject, htmlBody) {
  const params = {
    Source: 'The Quarry STL <management@thequarrystl.com>',
    Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  };
  return ses.sendEmail(params).promise();
}

// ─── GitHub API helper ───
function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path, method,
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

async function fetchBlobContent(repo, blobSha, token) {
  const res = await githubRequest('GET', '/repos/' + repo + '/git/blobs/' + blobSha, token);
  if (res.statusCode === 200 && res.data.content) {
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  }
  throw new Error('Could not fetch blob: ' + res.statusCode);
}

// ─── Shared email wrapper (header + footer) ───
function wrapEmail(bodyContent) {
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center">' +
    '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
    '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
    '<div style="padding:32px 24px;background:#FFFFFF">' + bodyContent + '</div>' +
    '<div style="background:#1A0E08;padding:16px;text-align:center">' +
    '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>';
}

function detailBlock(rows) {
  let html = '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">';
  rows.forEach(function(r) {
    if (r.highlight) {
      html += '<p style="margin:6px 0;color:#B8933A;font-size:1.1em"><strong>' + r.label + ': ' + r.value + '</strong></p>';
    } else if (r.small) {
      html += '<p style="margin:6px 0;color:#888;font-size:0.85em">' + r.label + ': ' + r.value + '</p>';
    } else {
      html += '<p style="margin:6px 0"><strong>' + r.label + ':</strong> ' + r.value + '</p>';
    }
  });
  html += '</div>';
  return html;
}

function contactLine() {
  return '<p style="color:#444">Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
    '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p>';
}


// ═══════════════════════════════════════════════════
// DETECT PURCHASE TYPE from Stripe metadata
// ═══════════════════════════════════════════════════
function detectPurchaseType(metadata) {
  if (metadata.type === 'vendor_approval') return 'vendor_approval';
  if (metadata.eventId) return 'event';
  if (metadata.bay) return 'golf';
  return 'generic';
}


// ═══════════════════════════════════════════════════
// EVENT REGISTRATION HANDLER
// ═══════════════════════════════════════════════════
async function handleEventRegistration(session, metadata) {
  const { eventId, eventName, customerName, customerEmail, customerPhone,
          partySize, seatType, tableId, ticketTier, couponCode,
          businessName, businessType } = metadata;

  const name   = customerName || '';
  const email  = customerEmail || session.customer_email || '';
  const phone  = customerPhone || '';
  const qty    = parseInt(partySize) || 1;
  const amountCents   = session.amount_total || 0;
  const amountDollars = (amountCents / 100).toFixed(2);
  const amountDisplay = '$' + amountDollars;

  const newReg = {
    orderNumber: session.id, name, email, phone,
    tickets: qty, amount: amountDollars, status: 'PAID',
    paymentMethod: 'stripe',
    transactionId: session.payment_intent || session.id,
    created: new Date().toISOString(),
    seatType: seatType || '', tableId: tableId || '',
    ticketTier: ticketTier || '', couponCode: couponCode || '',
    businessName: businessName || '', businessType: businessType || ''
  };

  // 1. Update events.json in GitHub
  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      const repo = 'quarrymanagement/quarry-website';
      const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/events.json', ghToken);

      if (metaRes.statusCode === 200 && metaRes.data.sha) {
        const fileSha = metaRes.data.sha;
        let eventsData;

        if (metaRes.data.content && metaRes.data.encoding === 'base64') {
          eventsData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
        } else {
          const blobUrl = 'https://raw.githubusercontent.com/' + repo + '/main/events.json';
          const rawContent = await new Promise(function(resolve, reject) {
            https.get(blobUrl, function(res) {
              let data = '';
              res.on('data', function(chunk) { data += chunk; });
              res.on('end', function() { resolve(data); });
            }).on('error', reject);
          });
          eventsData = JSON.parse(rawContent);
          console.log('Fetched events.json via raw URL (file too large for Contents API)');
        }

        if (!eventsData.registrations) eventsData.registrations = {};
        if (!eventsData.registrations[eventId]) eventsData.registrations[eventId] = [];
        eventsData.registrations[eventId].push(newReg);

        const eventObj = (eventsData.events || []).find(function(e) { return e.id === eventId; });
        if (eventObj) {
          const allRegs = eventsData.registrations[eventId];
          const totalRegs = allRegs.reduce(function(sum, r) { return sum + (r.tickets || 1); }, 0);
          eventObj.registeredCount = totalRegs;
          eventObj.registered = totalRegs;

          if (eventObj.tiers && eventObj.tiers.length > 0) {
            eventObj.tiers.forEach(function(tier) {
              var tierRegs = allRegs.filter(function(r) { return r.ticketTier === tier.name; });
              tier.registeredCount = tierRegs.reduce(function(sum, r) { return sum + (r.tickets || 1); }, 0);
            });
            var allTiersFull = eventObj.tiers.every(function(t) {
              return t.capacity && t.capacity > 0 && t.registeredCount >= t.capacity;
            });
            if (allTiersFull) eventObj.status = 'sold-out';
          } else if (eventObj.totalCapacity && totalRegs >= eventObj.totalCapacity) {
            eventObj.status = 'sold-out';
          }
        }

        const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
        const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/events.json', ghToken, {
          message: 'Registration: ' + name + ' for ' + (eventName || eventId) + ' (' + qty + ' ticket' + (qty > 1 ? 's' : '') + ')',
          content: encoded,
          sha: fileSha
        });

        if (putRes.statusCode === 200 || putRes.statusCode === 201) {
          console.log('events.json updated for', eventId);
        } else {
          console.error('GitHub PUT failed:', putRes.statusCode, JSON.stringify(putRes.data).substring(0, 200));
        }
      } else {
        console.error('Could not get events.json metadata:', metaRes.statusCode);
      }
    }
  } catch (e) {
    console.error('GitHub update error:', e.message);
  }

  // 2. Customer confirmation email
  if (email) {
    try {
      var rows = [{ label: 'Event', value: eventName || 'The Quarry Event' }];
      if (ticketTier) rows.push({ label: 'Ticket', value: ticketTier });
      rows.push({ label: 'Quantity', value: String(qty) });
      rows.push({ label: 'Seat Type', value: seatType || 'General' });
      if (businessName) rows.push({ label: 'Business', value: businessName });
      if (businessType) rows.push({ label: 'Services', value: businessType });
      rows.push({ label: 'Total Paid', value: amountDisplay, highlight: true });

      await sendEmail(email, 'Registration Confirmed — ' + (eventName || 'The Quarry Event'),
        wrapEmail(
          '<h2 style="color:#2C1A0E;margin-top:0">You\'re Registered!</h2>' +
          '<p style="color:#444">Hi ' + name + ', your registration has been confirmed and your payment has been processed.</p>' +
          detailBlock(rows) +
          '<p style="color:#444">We look forward to seeing you!</p>' +
          contactLine()
        )
      );
      console.log('Customer email sent to', email);
    } catch (e) {
      console.error('Customer email error:', e.message);
    }
  }

  // 3. Owner notification email
  try {
    var ownerRows = [
      { label: 'Event', value: eventName || 'N/A' },
      { label: 'Name', value: name },
      { label: 'Email', value: email },
      { label: 'Phone', value: phone || 'N/A' },
      { label: 'Seat Type', value: seatType || 'N/A' }
    ];
    if (ticketTier) ownerRows.push({ label: 'Ticket Tier', value: ticketTier });
    ownerRows.push({ label: 'Quantity', value: String(qty) });
    if (businessName) ownerRows.push({ label: 'Business Name', value: businessName });
    if (businessType) ownerRows.push({ label: 'Business Type', value: businessType });
    if (couponCode) ownerRows.push({ label: 'Coupon Used', value: couponCode });
    ownerRows.push({ label: 'Amount Paid', value: amountDisplay, highlight: true });
    ownerRows.push({ label: 'Transaction', value: session.payment_intent || session.id, small: true });

    await sendEmail('management@thequarrystl.com',
      'New Event Registration — ' + (eventName || 'Event') + ' — ' + name,
      wrapEmail(
        '<h2 style="color:#2C1A0E;margin-top:0">New Event Registration</h2>' +
        detailBlock(ownerRows)
      )
    );
    console.log('Owner email sent for event registration');
  } catch (e) {
    console.error('Owner email error:', e.message);
  }

  console.log('Event registration complete:', name, '—', eventName);
}


// ═══════════════════════════════════════════════════
// VENDOR APPROVAL PAYMENT HANDLER
// ═══════════════════════════════════════════════════
async function handleVendorApproval(session, metadata) {
  const { formId, submissionId, vendorName, vendorEmail, formName } = metadata;
  const email = vendorEmail || session.customer_email || '';
  const name = vendorName || '';
  const amountCents = session.amount_total || 0;
  const amountDollars = (amountCents / 100).toFixed(2);

  // 1. Update submission status to "paid" in forms.json
  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      const repo = 'quarrymanagement/quarry-website';
      const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/forms.json', ghToken);

      if (metaRes.statusCode === 200 && metaRes.data.sha) {
        let formsData;
        try {
          formsData = JSON.parse(await fetchBlobContent(repo, metaRes.data.sha, ghToken));
        } catch (e) {
          if (metaRes.data.content) {
            formsData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
          }
        }

        if (formsData && formsData.submissions && formsData.submissions[formId]) {
          var sub = formsData.submissions[formId].find(function(s) { return s.id === submissionId; });
          if (sub) {
            sub.status = 'paid';
            sub.paidAt = new Date().toISOString();
            sub.paymentAmount = amountDollars;
            sub.stripeSessionId = session.id;
            sub.transactionId = session.payment_intent || session.id;
          }

          const encoded = Buffer.from(JSON.stringify(formsData, null, 2), 'utf-8').toString('base64');
          await githubRequest('PUT', '/repos/' + repo + '/contents/forms.json', ghToken, {
            message: 'Vendor paid: ' + (name || submissionId) + ' — $' + amountDollars,
            content: encoded,
            sha: metaRes.data.sha
          });
          console.log('forms.json updated — vendor marked as paid');
        }
      }
    }
  } catch (e) {
    console.error('GitHub update error (vendor payment):', e.message);
  }

  // 2. Send payment confirmation to vendor
  if (email) {
    try {
      await sendEmail(email, 'Payment Confirmed — Your Vendor Spot is Reserved!',
        wrapEmail(
          '<h2 style="color:#2C1A0E;margin-top:0">You\'re All Set!</h2>' +
          '<p style="color:#444;line-height:1.7;">Hi ' + (name || 'there') + ',</p>' +
          '<p style="color:#444;line-height:1.7;">Your payment of <strong>$' + amountDollars + '</strong> has been received and your vendor spot for <strong>' + (formName || 'our upcoming event') + '</strong> is officially reserved!</p>' +
          detailBlock([
            { label: 'Event', value: formName || 'The Quarry Event' },
            { label: 'Vendor', value: name || 'N/A' },
            { label: 'Amount Paid', value: '$' + amountDollars, highlight: true },
            { label: 'Status', value: 'Confirmed & Paid' }
          ]) +
          '<p style="color:#444;line-height:1.7;"><strong>Jacqueline</strong>, our wedding director, will be reaching out to you with event details and logistics.</p>' +
          '<p style="color:#444;line-height:1.7;">We\'re looking forward to a fantastic event!</p>' +
          contactLine()
        )
      );
      console.log('Vendor payment confirmation sent to', email);
    } catch (e) {
      console.error('Vendor confirmation email error:', e.message);
    }
  }

  // 3. Notify management + Jacqueline that vendor has paid
  try {
    await sendEmail(
      ['management@thequarrystl.com', 'jacqueline@thequarrystl.com'],
      'Vendor Paid — ' + (name || 'Unknown') + ' — $' + amountDollars,
      wrapEmail(
        '<h2 style="color:#2C1A0E;margin-top:0">Vendor Payment Received</h2>' +
        '<p style="color:#444">A vendor has completed their payment and their spot is now confirmed.</p>' +
        detailBlock([
          { label: 'Vendor', value: name || 'N/A' },
          { label: 'Email', value: email },
          { label: 'Event/Form', value: formName || 'N/A' },
          { label: 'Amount Paid', value: '$' + amountDollars, highlight: true },
          { label: 'Status', value: 'Paid & Confirmed' },
          { label: 'Transaction', value: session.payment_intent || session.id, small: true }
        ])
      )
    );
    console.log('Owner notified of vendor payment');
  } catch (e) {
    console.error('Owner vendor payment email error:', e.message);
  }

  console.log('Vendor approval payment complete:', name, '— $' + amountDollars);
}


// ═══════════════════════════════════════════════════
// GOLF BOOKING HANDLER
// ═══════════════════════════════════════════════════
async function handleGolfBooking(session, metadata) {
  const name     = metadata.customerName || '';
  const email    = metadata.customerEmail || session.customer_email || '';
  const bay      = metadata.bay || '';
  const date     = metadata.date || '';
  const time     = metadata.time || '';
  const duration = metadata.duration || '';
  const players  = metadata.players || '';
  const coupon   = metadata.coupon || '';
  const amountCents  = session.amount_total || 0;
  const amountDisplay = '$' + (amountCents / 100).toFixed(2);

  // 1. Store booking in Netlify Blobs
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = process.env.SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
    if (token) {
      const dateKey = date.replace(/\//g, '-');
      const key = encodeURIComponent('golf-' + dateKey);
      let bookings = [];
      try {
        const existing = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
          headers: { Authorization: 'Bearer ' + token }
        });
        if (existing.ok) { bookings = (await existing.json()).bookings || []; }
      } catch (e) {}

      bookings.push({
        bay, time, name, email, players, duration,
        stripeSessionId: session.id,
        amountPaid: amountCents,
        bookedAt: new Date().toISOString()
      });

      await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookings })
      });
      console.log('Golf booking stored:', bay, date, time);
    }
  } catch (e) {
    console.error('Golf blob storage error:', e.message);
  }

  // 2. Customer confirmation email
  if (email) {
    try {
      await sendEmail(email, 'Golf Booking Confirmed — The Quarry',
        wrapEmail(
          '<h2 style="color:#2C1A0E;margin-top:0">Booking Confirmed!</h2>' +
          '<p style="color:#444">Hi ' + name + ', your golf bay is reserved.</p>' +
          detailBlock([
            { label: 'Bay', value: bay },
            { label: 'Date', value: date },
            { label: 'Time', value: time },
            { label: 'Duration', value: duration },
            { label: 'Players', value: players },
            { label: 'Total Paid', value: amountDisplay, highlight: true }
          ]) +
          '<p style="color:#444">Please arrive 10 minutes early.</p>' +
          contactLine()
        )
      );
      console.log('Customer golf email sent to', email);
    } catch (e) {
      console.error('Customer golf email error:', e.message);
    }
  }

  // 3. Owner notification email
  try {
    var ownerRows = [
      { label: 'Bay', value: bay },
      { label: 'Date', value: date },
      { label: 'Time', value: time },
      { label: 'Duration', value: duration },
      { label: 'Players', value: players },
      { label: 'Name', value: name },
      { label: 'Email', value: email }
    ];
    if (coupon) ownerRows.push({ label: 'Coupon', value: coupon });
    ownerRows.push({ label: 'Amount Paid', value: amountDisplay, highlight: true });
    ownerRows.push({ label: 'Transaction', value: session.payment_intent || session.id, small: true });

    await sendEmail('management@thequarrystl.com',
      'New Golf Booking — ' + bay + ' on ' + date + ' at ' + time,
      wrapEmail(
        '<h2 style="color:#2C1A0E;margin-top:0">New Golf Bay Booking</h2>' +
        detailBlock(ownerRows)
      )
    );
    console.log('Owner golf notification sent');
  } catch (e) {
    console.error('Owner golf email error:', e.message);
  }

  console.log('Golf booking complete:', name, bay, date, time);
}


// ═══════════════════════════════════════════════════
// GENERIC PAYMENT HANDLER
// ═══════════════════════════════════════════════════
async function handleGenericPayment(session, metadata) {
  const name   = metadata.customerName || metadata.name || '';
  const email  = metadata.customerEmail || metadata.email || session.customer_email || '';
  const amountCents  = session.amount_total || 0;
  const amountDisplay = '$' + (amountCents / 100).toFixed(2);
  const description = session.line_items_description || session.metadata.description || 'Purchase';

  // Customer confirmation
  if (email) {
    try {
      await sendEmail(email, 'Payment Confirmed — The Quarry',
        wrapEmail(
          '<h2 style="color:#2C1A0E;margin-top:0">Payment Confirmed!</h2>' +
          '<p style="color:#444">Hi' + (name ? ' ' + name : '') + ', your payment has been processed.</p>' +
          detailBlock([
            { label: 'Total Paid', value: amountDisplay, highlight: true },
            { label: 'Transaction', value: session.payment_intent || session.id, small: true }
          ]) +
          contactLine()
        )
      );
      console.log('Generic customer email sent to', email);
    } catch (e) {
      console.error('Generic customer email error:', e.message);
    }
  }

  // Owner notification
  try {
    var rows = [{ label: 'Amount', value: amountDisplay, highlight: true }];
    if (name) rows.unshift({ label: 'Name', value: name });
    if (email) rows.splice(1, 0, { label: 'Email', value: email });
    rows.push({ label: 'Transaction', value: session.payment_intent || session.id, small: true });

    Object.keys(metadata).forEach(function(key) {
      if (['customerName', 'customerEmail', 'name', 'email'].indexOf(key) === -1) {
        rows.splice(rows.length - 1, 0, { label: key, value: metadata[key] });
      }
    });

    await sendEmail('management@thequarrystl.com',
      'New Payment Received — ' + amountDisplay + (name ? ' — ' + name : ''),
      wrapEmail(
        '<h2 style="color:#2C1A0E;margin-top:0">New Payment Received</h2>' +
        detailBlock(rows)
      )
    );
    console.log('Generic owner email sent');
  } catch (e) {
    console.error('Generic owner email error:', e.message);
  }
}


// ═══════════════════════════════════════════════════
// MAIN WEBHOOK HANDLER
// ═══════════════════════════════════════════════════
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

  console.log('Stripe webhook received:', evt.type, evt.id);

  if (evt.type === 'checkout.session.completed') {
    const session = evt.data.object;
    const metadata = session.metadata || {};
    const purchaseType = detectPurchaseType(metadata);

    console.log('Purchase type detected:', purchaseType, '| Metadata keys:', Object.keys(metadata).join(', '));

    try {
      if (purchaseType === 'vendor_approval') {
        await handleVendorApproval(session, metadata);
      } else if (purchaseType === 'event') {
        await handleEventRegistration(session, metadata);
      } else if (purchaseType === 'golf') {
        await handleGolfBooking(session, metadata);
      } else {
        await handleGenericPayment(session, metadata);
      }
    } catch (e) {
      console.error('Handler error for', purchaseType, ':', e.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
