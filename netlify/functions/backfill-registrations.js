// One-time backfill: reprocesses missed Stripe checkout.session.completed events.
// Trigger: GET /.netlify/functions/backfill-registrations?key=<BACKFILL_KEY>&sessions=cs_live_a,cs_live_b
// (or POST { sessions: ["cs_live_a", "cs_live_b"] } with the same auth)
//
// For each session: writes to Netlify Blobs, appends to events.json on GitHub, sends
// confirmation emails to customer + owner. Mirrors the production webhook handler.

const Stripe = require('stripe');
const https = require('https');

function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'management@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  var toArray = Array.isArray(to) ? to : [to];
  var payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(email) { return { email: email }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: body });
        } else {
          reject(new Error('SendGrid error ' + res.statusCode + ': ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Backfill',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
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
    https.get(url, { headers: { 'User-Agent': 'Quarry-Backfill' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function processSession(session, results) {
  const md = session.metadata || {};
  const eventId = md.eventId;
  const eventName = md.eventName || '';
  const customerName = md.customerName || '';
  const customerEmail = md.customerEmail || session.customer_email || '';
  const customerPhone = md.customerPhone || '';
  const partySize = parseInt(md.partySize) || 1;
  const seatType = md.seatType || '';
  const tableId = md.tableId || '';
  const ticketTier = md.ticketTier || '';
  const couponCode = md.couponCode || '';

  if (!eventId) {
    results.push({ session: session.id, status: 'skipped', reason: 'no eventId' });
    return;
  }

  const amountDollars = session.amount_total ? (session.amount_total / 100).toFixed(2) : '0.00';
  const amountDisplay = '$' + amountDollars;

  const newReg = {
    orderNumber: session.id,
    name: customerName,
    email: customerEmail,
    phone: customerPhone,
    tickets: partySize,
    amount: amountDollars,
    status: 'PAID',
    paymentMethod: 'stripe',
    transactionId: session.payment_intent || session.id,
    created: new Date(session.created * 1000).toISOString(),
    seatType,
    tableId,
    ticketTier,
    couponCode,
    backfilled: true
  };

  // 1. GitHub events.json update (with raw URL fallback for large file)
  try {
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      const repo = 'quarrymanagement/quarry-website';
      const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/events.json', ghToken);
      if (metaRes.statusCode !== 200 || !metaRes.data.sha) {
        throw new Error('events.json metadata fetch failed: ' + metaRes.statusCode);
      }
      const fileSha = metaRes.data.sha;
      let eventsData;
      if (metaRes.data.content && metaRes.data.encoding === 'base64' && metaRes.data.content.length > 0) {
        eventsData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
      } else {
        const raw = await fetchRaw('https://raw.githubusercontent.com/' + repo + '/main/events.json');
        eventsData = JSON.parse(raw);
      }

      // De-dupe: skip if this orderNumber is already recorded
      if (!eventsData.registrations) eventsData.registrations = {};
      if (!eventsData.registrations[eventId]) eventsData.registrations[eventId] = [];
      const existing = eventsData.registrations[eventId].find(r => r.orderNumber === session.id);
      if (existing) {
        results.push({ session: session.id, status: 'already_recorded', email: customerEmail });
        return;
      }

      eventsData.registrations[eventId].push(newReg);
      const eventObj = (eventsData.events || []).find(e => e.id === eventId);
      if (eventObj) {
        const totalRegs = eventsData.registrations[eventId].reduce((sum, r) => sum + (r.tickets || 1), 0);
        eventObj.registeredCount = totalRegs;
        eventObj.registered = totalRegs;
        if (eventObj.totalCapacity && totalRegs >= eventObj.totalCapacity) {
          eventObj.status = 'sold-out';
        }
      }
      const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
      const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/events.json', ghToken, {
        message: 'Backfill registration: ' + customerName + ' for ' + (eventName || eventId),
        content: encoded,
        sha: fileSha
      });
      if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
        throw new Error('GitHub PUT failed: ' + putRes.statusCode + ' ' + JSON.stringify(putRes.data).substring(0, 200));
      }
    }
  } catch (e) {
    results.push({ session: session.id, status: 'github_error', error: e.message });
    return;
  }

  // 2. Send emails
  const emailResults = { customer: 'pending', owner: 'pending' };

  if (customerEmail) {
    try {
      await sendGridEmail(
        customerEmail,
        'Registration Confirmed — ' + (eventName || 'The Quarry Event'),
        '<div style="font-family:Arial,sans-serif;max-width:600px">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center">' +
        '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You\'re Registered!</h2>' +
        '<p>Hi ' + customerName + ', your registration is confirmed.</p>' +
        '<p style="color:#666;font-size:.85em;font-style:italic">Note: this confirmation is being re-sent — your payment processed successfully on ' + new Date(session.created * 1000).toLocaleDateString() + '. Thanks for your patience.</p>' +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
        '<p style="margin:4px 0"><b>Event:</b> ' + (eventName || 'The Quarry Event') + '</p>' +
        '<p style="margin:4px 0"><b>Seat Type:</b> ' + (seatType || 'N/A') + '</p>' +
        (ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + ticketTier + '</p>' : '') +
        '<p style="margin:4px 0"><b>Party Size:</b> ' + partySize + '</p>' +
        '<p style="margin:4px 0;color:#B8933A"><b>Total Paid: ' + amountDisplay + '</b></p></div>' +
        '<p>Questions? Call <a href="tel:6362480426" style="color:#B8933A">(636) 248-0426</a> or email ' +
        '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
        'events@thequarrystl.com',
        'The Quarry STL'
      );
      emailResults.customer = 'sent';
    } catch (e) {
      emailResults.customer = 'error: ' + e.message;
    }
  } else {
    emailResults.customer = 'no_email';
  }

  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'Backfilled Event Registration — ' + (eventName || 'Event'),
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center">' +
      '<h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
      '<div style="padding:32px 24px">' +
      '<h2 style="color:#2C1A0E">Backfilled Registration</h2>' +
      '<p style="color:#666;font-size:.9em">This is a reprocessed registration that was missed by the webhook between Apr 22 and May 2.</p>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
      '<p style="margin:4px 0"><b>Event:</b> ' + (eventName || 'N/A') + '</p>' +
      '<p style="margin:4px 0"><b>Name:</b> ' + customerName + '</p>' +
      '<p style="margin:4px 0"><b>Email:</b> ' + customerEmail + '</p>' +
      '<p style="margin:4px 0"><b>Phone:</b> ' + (customerPhone || 'N/A') + '</p>' +
      (ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + ticketTier + '</p>' : '') +
      '<p style="margin:4px 0"><b>Party Size:</b> ' + partySize + '</p>' +
      '<p style="margin:4px 0;color:#B8933A"><b>Total: ' + amountDisplay + '</b></p>' +
      '<p style="margin:4px 0;font-size:.8em;color:#666">Stripe session: ' + session.id + '</p></div>' +
      '</div></div>',
      'events@thequarrystl.com',
      'The Quarry STL'
    );
    emailResults.owner = 'sent';
  } catch (e) {
    emailResults.owner = 'error: ' + e.message;
  }

  results.push({
    session: session.id,
    status: 'backfilled',
    name: customerName,
    email: customerEmail,
    eventName,
    amount: amountDisplay,
    emails: emailResults
  });
}

exports.handler = async (event) => {
  // Simple shared-secret auth so the function isn't world-callable
  const expected = process.env.BACKFILL_KEY || 'quarry-backfill-2026';
  const provided = (event.queryStringParameters && event.queryStringParameters.key)
    || (event.headers && event.headers['x-backfill-key']);
  if (provided !== expected) {
    return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  // Default list = the 5 known missed event sessions (Apr 22 – May 1)
  const DEFAULT_SESSIONS = [
    'cs_live_b1o7h5Rl2XS3qs1w64DMaT88VE12WutU0pphQxnliHnqep9PPY4KxYoAcQ', // Carla Brakensiek - Chataeu - Apr 22
    'cs_live_b1vlWoFRLLOE4aRNrfz0TBUF0nysTtz8ZLFFcw4tcG39Ay4urMbnIuchho', // Karen drone - BINGO - Apr 23
    'cs_live_b1LCjAGecSwCjeNeWsLYnLm19EV1Mp73OPCAsocrmTAgx0zJUr55eWP5BX', // Sherry Gibson - BINGO - Apr 23
    'cs_live_b1uvMbhCD9wBig9A90swOg2Mzpzk7snR5U8dcIOGgRUgaRjx6WwCTF8sQk', // Tracy Birkinbine - BINGO - Apr 30
    'cs_live_b15ZlxReMZyhqvgKhvC98mlYwJYtqWuTTweh3aGSHWtTRIlxCwPIdrlO8l', // Lainey Bochenek - BINGO - May 1
  ];

  let sessionIds;
  if (event.queryStringParameters && event.queryStringParameters.sessions) {
    sessionIds = event.queryStringParameters.sessions.split(',').map(s => s.trim()).filter(Boolean);
  } else if (event.body) {
    try {
      const body = JSON.parse(event.body);
      sessionIds = body.sessions || DEFAULT_SESSIONS;
    } catch { sessionIds = DEFAULT_SESSIONS; }
  } else {
    sessionIds = DEFAULT_SESSIONS;
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const results = [];

  for (const sid of sessionIds) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      await processSession(session, results);
    } catch (e) {
      results.push({ session: sid, status: 'fetch_error', error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed: sessionIds.length, results }, null, 2)
  };
};
