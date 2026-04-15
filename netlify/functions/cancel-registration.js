const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Admin',
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { eventId, orderNumber, action } = JSON.parse(event.body);
    // action: 'refund_and_cancel' | 'cancel_only'

    if (!eventId || !orderNumber) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing eventId or orderNumber' }) };
    }

    let refundResult = null;

    // Step 1: If refunding, process Stripe refund
    if (action === 'refund_and_cancel') {
      try {
        // The orderNumber is the Stripe checkout session ID
        const session = await stripe.checkout.sessions.retrieve(orderNumber);
        if (session && session.payment_intent) {
          const refund = await stripe.refunds.create({
            payment_intent: session.payment_intent,
          });
          refundResult = { id: refund.id, status: refund.status, amount: refund.amount };
          console.log('Stripe refund processed:', refund.id, refund.status);
        } else {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'No payment intent found for this session' }) };
        }
      } catch (stripeErr) {
        console.error('Stripe refund error:', stripeErr.message);
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Stripe refund failed: ' + stripeErr.message }) };
      }
    }

    // Step 2: Remove registration from events.json and update count
    const ghToken = process.env.GITHUB_TOKEN;
    if (!ghToken) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'No GITHUB_TOKEN configured' }) };
    }

    const repo = 'quarrymanagement/quarry-website';

    // Get file metadata (SHA) from Contents API
    const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/events.json', ghToken);
    if (metaRes.statusCode !== 200 || !metaRes.data.sha) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not read events.json metadata' }) };
    }
    const fileSha = metaRes.data.sha;

    // Fetch actual content via raw URL (file is too large for Contents API)
    const rawContent = await fetchRaw('https://raw.githubusercontent.com/' + repo + '/main/events.json');
    const eventsData = JSON.parse(rawContent);

    // Find and remove the registration
    const eventRegs = eventsData.registrations && eventsData.registrations[eventId] ? eventsData.registrations[eventId] : [];
    const regIndex = eventRegs.findIndex(function(r) { return r.orderNumber === orderNumber; });

    if (regIndex === -1) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Registration not found' }) };
    }

    const removedReg = eventRegs.splice(regIndex, 1)[0];
    eventsData.registrations[eventId] = eventRegs;

    // Recalculate registeredCount
    const eventObj = (eventsData.events || []).find(function(e) { return e.id === eventId; });
    if (eventObj) {
      const totalRegs = eventRegs.reduce(function(sum, r) { return sum + (r.tickets || 1); }, 0);
      eventObj.registeredCount = totalRegs;
      eventObj.registered = totalRegs;
      // If it was sold out and now has capacity, reopen
      if (eventObj.status === 'sold-out' && eventObj.totalCapacity && totalRegs < eventObj.totalCapacity) {
        eventObj.status = 'available';
      }
    }

    // Push updated events.json
    const encoded = Buffer.from(JSON.stringify(eventsData, null, 2), 'utf-8').toString('base64');
    const actionLabel = action === 'refund_and_cancel' ? 'Refund & cancel' : 'Cancel';
    const putRes = await githubRequest('PUT', '/repos/' + repo + '/contents/events.json', ghToken, {
      message: actionLabel + ': ' + (removedReg.name || 'Unknown') + ' from ' + (eventObj ? eventObj.name : eventId),
      content: encoded,
      sha: fileSha
    });

    if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update events.json' }) };
    }

    console.log('Registration cancelled:', removedReg.name, 'from', eventId);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        action: action,
        removedRegistration: removedReg,
        refund: refundResult,
        newRegisteredCount: eventObj ? eventObj.registeredCount : null
      })
    };

  } catch (err) {
    console.error('Cancel registration error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};