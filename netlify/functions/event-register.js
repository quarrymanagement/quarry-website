const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

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
    const { eventId, name, email, phone, partySize, seatType, tableId, ticketTier, successUrl, cancelUrl } = JSON.parse(event.body);

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
    const remaining = (evData.totalCapacity || 0) - (evData.registeredCount || 0);
    const qty = partySize || 1;
    if (remaining < qty) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Not enough seats. Only ' + remaining + ' remaining.' }) };
    }

    // Determine price - check tiers first, fall back to pricePerSeat
    let unitPrice = evData.pricePerSeat || evData.price || 0;
    let tierName = evData.name;

    if (ticketTier && evData.tiers && evData.tiers.length > 0) {
      const matchedTier = evData.tiers.find(t => t.name === ticketTier);
      if (matchedTier) {
        unitPrice = matchedTier.pricePerPerson || unitPrice;
        tierName = matchedTier.name;
      }
    }

    if (!unitPrice || unitPrice <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not determine ticket price' }) };
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
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
        ticketTier: ticketTier || ''
      },
      success_url: (successUrl || siteUrl + '/quarry-events.html') + '?registration=success&event=' + eventId,
      cancel_url: (cancelUrl || siteUrl + '/quarry-events.html') + '?registration=cancelled'
    });

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
