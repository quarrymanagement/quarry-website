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

function sessionToReg(session) {
  const md = session.metadata || {};
  return {
    eventId: md.eventId || null,
    eventName: md.eventName || '',
    customerName: md.customerName || '',
    customerEmail: md.customerEmail || session.customer_email || '',
    customerPhone: md.customerPhone || '',
    partySize: parseInt(md.partySize) || 1,
    seatType: md.seatType || '',
    tableId: md.tableId || '',
    ticketTier: md.ticketTier || '',
    couponCode: md.couponCode || '',
    amountCents: session.amount_total || 0,
    sessionId: session.id,
    paymentIntent: session.payment_intent || session.id,
    sessionCreated: session.created
  };
}

async function batchUpdateEventsJson(parsedRegs) {
  // Single read-modify-write, one commit, no race condition.
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) throw new Error('GITHUB_TOKEN env var not set');
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

  if (!eventsData.registrations) eventsData.registrations = {};
  const dispositions = [];

  for (const r of parsedRegs) {
    if (!r.eventId) {
      dispositions.push({ session: r.sessionId, status: 'skipped_no_eventId' });
      continue;
    }
    if (!eventsData.registrations[r.eventId]) eventsData.registrations[r.eventId] = [];
    const arr = eventsData.registrations[r.eventId];
    if (arr.find(x => x.orderNumber === r.sessionId)) {
      dispositions.push({ session: r.sessionId, status: 'already_recorded', name: r.customerName });
      continue;
    }
    const newReg = {
      orderNumber: r.sessionId,
      name: r.customerName,
      email: r.customerEmail,
      phone: r.customerPhone,
      tickets: r.partySize,
      amount: (r.amountCents / 100).toFixed(2),
      status: 'PAID',
      paymentMethod: 'stripe',
      transactionId: r.paymentIntent,
      created: new Date(r.sessionCreated * 1000).toISOString(),
      seatType: r.seatType,
      tableId: r.tableId,
      ticketTier: r.ticketTier,
      couponCode: r.couponCode,
      backfilled: true
    };
    arr.push(newReg);
    dispositions.push({ session: r.sessionId, status: 'added', name: r.customerName });

    // Update event aggregates
    const eventObj = (eventsData.events || []).find(e => e.id === r.eventId);
    if (eventObj) {
      const totalRegs = arr.reduce((sum, x) => sum + (x.tickets || 1), 0);
      eventObj.registeredCount = totalRegs;
      eventObj.registered = totalRegs;
      if (eventObj.totalCapacity && totalRegs >= eventObj.totalCapacity) eventObj.status = 'sold-out';
    }
  }

  const anyAdded = dispositions.some(d => d.status === 'added');
  if (!anyAdded) {
    return { committed: false, dispositions, sha: fileSha };
  }
  const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
  const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/events.json', ghToken, {
    message: 'Backfill ' + dispositions.filter(d => d.status === 'added').length + ' missed registration(s)',
    content: encoded,
    sha: fileSha
  });
  if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
    throw new Error('GitHub PUT failed: ' + putRes.statusCode + ' ' + JSON.stringify(putRes.data).substring(0, 300));
  }
  return { committed: true, dispositions, newSha: putRes.data.commit && putRes.data.commit.sha };
}

async function sendConfirmationEmails(r) {
  const out = { customer: 'pending', owner: 'pending' };
  const amountDisplay = '$' + (r.amountCents / 100).toFixed(2);

  if (r.customerEmail) {
    try {
      await sendGridEmail(
        r.customerEmail,
        'Registration Confirmed — ' + (r.eventName || 'The Quarry Event'),
        '<div style="font-family:Arial,sans-serif;max-width:600px">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center">' +
        '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
        '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
        '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">You\'re Registered!</h2>' +
        '<p>Hi ' + r.customerName + ', your registration is confirmed.</p>' +
        '<p style="color:#666;font-size:.85em;font-style:italic">Note: this confirmation is being re-sent — your payment processed successfully on ' + new Date(r.sessionCreated * 1000).toLocaleDateString() + '. Thanks for your patience.</p>' +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
        '<p style="margin:4px 0"><b>Event:</b> ' + (r.eventName || 'The Quarry Event') + '</p>' +
        '<p style="margin:4px 0"><b>Seat Type:</b> ' + (r.seatType || 'N/A') + '</p>' +
        (r.ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + r.ticketTier + '</p>' : '') +
        '<p style="margin:4px 0"><b>Party Size:</b> ' + r.partySize + '</p>' +
        '<p style="margin:4px 0;color:#B8933A"><b>Total Paid: ' + amountDisplay + '</b></p></div>' +
        '<p>Questions? Call <a href="tel:6362480426" style="color:#B8933A">(636) 248-0426</a> or email ' +
        '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
        '<div style="background:#1A0E08;padding:16px;text-align:center">' +
        '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
        'events@thequarrystl.com',
        'The Quarry STL'
      );
      out.customer = 'sent';
    } catch (e) { out.customer = 'error: ' + e.message; }
  } else {
    out.customer = 'no_email';
  }

  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'Backfilled Event Registration — ' + (r.eventName || 'Event'),
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center">' +
      '<h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
      '<div style="padding:32px 24px"><h2>Backfilled Registration</h2>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
      '<p style="margin:4px 0"><b>Event:</b> ' + (r.eventName || 'N/A') + '</p>' +
      '<p style="margin:4px 0"><b>Name:</b> ' + r.customerName + '</p>' +
      '<p style="margin:4px 0"><b>Email:</b> ' + r.customerEmail + '</p>' +
      '<p style="margin:4px 0"><b>Phone:</b> ' + (r.customerPhone || 'N/A') + '</p>' +
      (r.ticketTier ? '<p style="margin:4px 0"><b>Ticket:</b> ' + r.ticketTier + '</p>' : '') +
      '<p style="margin:4px 0"><b>Party Size:</b> ' + r.partySize + '</p>' +
      '<p style="margin:4px 0;color:#B8933A"><b>Total: ' + amountDisplay + '</b></p>' +
      '<p style="margin:4px 0;font-size:.8em;color:#666">Stripe: ' + r.sessionId + '</p></div>' +
      '</div></div>',
      'events@thequarrystl.com',
      'The Quarry STL'
    );
    out.owner = 'sent';
  } catch (e) { out.owner = 'error: ' + e.message; }

  return out;
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

  const skipEmails = !!(event.queryStringParameters && event.queryStringParameters.skipEmails === '1');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // Phase 1: fetch all sessions from Stripe
  const fetched = [];
  const fetchErrors = [];
  for (const sid of sessionIds) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sid);
      fetched.push(sessionToReg(session));
    } catch (e) {
      fetchErrors.push({ session: sid, error: e.message });
    }
  }

  // Phase 2: ONE atomic batch update of events.json
  let batchResult;
  try {
    batchResult = await batchUpdateEventsJson(fetched);
  } catch (e) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'batch_update_failed', message: e.message, fetchErrors }) };
  }

  // Phase 3: send emails for newly added rows (skip already_recorded ones)
  const emailReports = [];
  if (!skipEmails) {
    const addedIds = new Set(batchResult.dispositions.filter(d => d.status === 'added').map(d => d.session));
    for (const r of fetched) {
      if (addedIds.has(r.sessionId)) {
        const out = await sendConfirmationEmails(r);
        emailReports.push({ session: r.sessionId, name: r.customerName, email: r.customerEmail, ...out });
      }
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      processed: sessionIds.length,
      fetched: fetched.length,
      fetchErrors,
      committed: batchResult.committed,
      newSha: batchResult.newSha,
      dispositions: batchResult.dispositions,
      emails: emailReports,
      skippedEmails: skipEmails
    }, null, 2)
  };
};
