const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');
const AWS = require('aws-sdk');

const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

function sendEmail(to, subject, htmlBody) {
  return ses.sendEmail({
    Source: 'The Quarry STL <management@thequarrystl.com>',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  }).promise();
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Failed to parse JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Register',
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

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { eventId, name, email, phone, partySize, seatType, tableId, ticketTier, couponCode, businessName, businessType, successUrl, cancelUrl } = JSON.parse(event.body);

    if (!eventId || !name || !email || !seatType) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Fetch events data from the static events.json file
    const siteUrl = process.env.URL || 'https://thequarrystl.com';
    const allData = await fetchJSON(siteUrl + '/events.json');
    const events = allData.events || [];
    const evData = events.find(e => e.id === eventId);

    if (!evData) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found: ' + eventId }) };
    }

    // Check capacity
    if (evData.status === 'sold-out') {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Event is sold out' }) };
    }
    const qty = partySize || 1;

    // Determine price and capacity - check tiers first, fall back to event-level
    let unitPrice = evData.pricePerSeat || evData.price || 0;
    let tierName = evData.name;
    let matchedTier = null;

    if (ticketTier && evData.tiers && evData.tiers.length > 0) {
      matchedTier = evData.tiers.find(t => t.name === ticketTier);
      if (matchedTier) {
        unitPrice = matchedTier.pricePerPerson !== undefined ? matchedTier.pricePerPerson : unitPrice;
        tierName = matchedTier.name;

        // Per-tier capacity check
        if (matchedTier.capacity && matchedTier.capacity > 0) {
          const tierRemaining = matchedTier.capacity - (matchedTier.registeredCount || 0);
          if (tierRemaining < qty) {
            return { statusCode: 409, headers, body: JSON.stringify({ error: tierName + ' is sold out. Only ' + tierRemaining + ' spots remaining.' }) };
          }
        }
      }
    }

    // Fall back to event-level capacity if no per-tier capacity
    if (!matchedTier || !matchedTier.capacity) {
      const remaining = (evData.totalCapacity || 0) - (evData.registeredCount || 0);
      if (evData.totalCapacity > 0 && remaining < qty) {
        return { statusCode: 409, headers, body: JSON.stringify({ error: 'Not enough seats. Only ' + remaining + ' remaining.' }) };
      }
    }

    // If price is 0 (free tier), handle registration directly — no Stripe needed
    if (unitPrice <= 0) {
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
              eventsData = JSON.parse(await fetchRaw('https://raw.githubusercontent.com/' + repo + '/main/events.json'));
            }

            const orderNumber = 'free_' + Date.now();
            const newReg = {
              orderNumber, name, email, phone: phone || '',
              tickets: qty, amount: '0.00', status: 'CONFIRMED',
              paymentMethod: 'free', transactionId: orderNumber,
              created: new Date().toISOString(),
              seatType: seatType || '', ticketTier: ticketTier || '',
              businessName: businessName || '', businessType: businessType || ''
            };

            if (!eventsData.registrations) eventsData.registrations = {};
            if (!eventsData.registrations[eventId]) eventsData.registrations[eventId] = [];
            eventsData.registrations[eventId].push(newReg);

            const eventObj = (eventsData.events || []).find(e => e.id === eventId);
            if (eventObj) {
              const allRegs = eventsData.registrations[eventId];
              eventObj.registeredCount = allRegs.reduce((s, r) => s + (r.tickets || 1), 0);
              eventObj.registered = eventObj.registeredCount;
              if (eventObj.tiers) {
                eventObj.tiers.forEach(t => {
                  t.registeredCount = allRegs.filter(r => r.ticketTier === t.name).reduce((s, r) => s + (r.tickets || 1), 0);
                });
              }
            }

            const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
            await githubRequest('PUT', '/repos/' + repo + '/contents/events.json', ghToken, {
              message: 'Free registration: ' + name + ' for ' + (evData.name || eventId),
              content: encoded, sha: fileSha
            });
          }
        }

        // Send confirmation emails
        if (email) {
          await sendEmail(email, 'Registration Confirmed — ' + (evData.name || 'The Quarry Event'),
            '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
            '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
            '<div style="padding:32px 24px"><h2 style="color:#2C1A0E;margin-top:0">You\'re Registered!</h2>' +
            '<p>Hi ' + name + ', you\'re confirmed for <strong>' + evData.name + '</strong>.</p>' +
            '<p><strong>Tier:</strong> ' + tierName + '<br><strong>Tickets:</strong> ' + qty + '<br><strong>Cost:</strong> Free</p>' +
            (businessName ? '<p><strong>Business:</strong> ' + businessName + '</p>' : '') +
            '<p>We look forward to seeing you!</p></div></div>'
          );
        }
        await sendEmail('management@thequarrystl.com', 'Free Registration — ' + evData.name + ' — ' + name,
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
          '<div style="padding:32px 24px"><h2 style="color:#2C1A0E;margin-top:0">New Free Registration</h2>' +
          '<p><strong>Event:</strong> ' + evData.name + '<br><strong>Tier:</strong> ' + tierName + '<br><strong>Name:</strong> ' + name + '<br><strong>Email:</strong> ' + email + '<br><strong>Phone:</strong> ' + (phone || 'N/A') + '<br><strong>Tickets:</strong> ' + qty + '</p>' +
          (businessName ? '<p><strong>Business:</strong> ' + businessName + '<br><strong>Services:</strong> ' + (businessType || 'N/A') + '</p>' : '') +
          '</div></div>'
        );
      } catch (freeErr) {
        console.error('Free registration error:', freeErr.message);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ free: true, message: 'Free registration confirmed!' }) };
    }

    // Look up promotion code if a coupon was applied on the form
    let discounts = undefined;
    let useAllowPromoCodes = true;

    if (couponCode) {
      try {
        const promoCodes = await stripe.promotionCodes.list({
          code: couponCode.toUpperCase().trim(),
          active: true,
          limit: 1
        });
        if (promoCodes.data.length > 0) {
          discounts = [{ promotion_code: promoCodes.data[0].id }];
          useAllowPromoCodes = false; // Can't use both discounts and allow_promotion_codes
        }
      } catch (e) {
        console.log('Coupon lookup failed, continuing without discount:', e.message);
      }
    }

    // Create Stripe Checkout Session
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: unitPrice,
          product_data: {
            name: tierName,
            description: evData.name + ' - ' + (evData.date || '') + ' at The Quarry'
          }
        },
        quantity: qty
      }],
      metadata: {
        eventId: eventId,
        eventName: evData.name,
        customerName: name,
        customerEmail: email,
        customerPhone: phone || '',
        partySize: String(qty),
        seatType: seatType,
        tableId: tableId || '',
        ticketTier: ticketTier || '',
        couponCode: couponCode || '',
        businessName: businessName || '',
        businessType: businessType || ''
      },
      success_url: (successUrl || siteUrl + '/quarry-events.html') + '?registration=success&event=' + eventId,
      cancel_url: (cancelUrl || siteUrl + '/quarry-events.html') + '?registration=cancelled'
    };

    // Apply either pre-selected discount or allow manual promo code entry
    if (discounts) {
      sessionParams.discounts = discounts;
    } else {
      sessionParams.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ checkoutUrl: session.url, sessionId: session.id })
    };

  } catch (err) {
    console.error('Event registration error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Registration failed: ' + err.message })
    };
  }
};
