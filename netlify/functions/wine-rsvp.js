const Stripe = require('stripe');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  try {
    const { name, email, tasting, date, time } = JSON.parse(event.body || '{}');
    if (!name || !email || !tasting) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name, email, and tasting are required.' }) };
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    // Search for customers with this email
    const customers = await stripe.customers.list({ email: email.toLowerCase().trim(), limit: 5 });

    if (!customers.data.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: false, reason: 'no_account' }) };
    }

    // Check if any customer has an active Rock & Vine subscription
    let hasActive = false;
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 10
      });
      // Check if any active sub is for the Rock & Vine product
      for (const sub of subs.data) {
        for (const item of sub.items.data) {
          if (item.price.product === 'prod_UEVv768MwZGkyb') {
            hasActive = true; break;
          }
        }
        if (hasActive) break;
      }
      if (hasActive) break;
    }

    if (!hasActive) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: false, reason: 'no_subscription' }) };
    }

    // Member is verified — store RSVP and notify owner
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';

    // Store RSVP in Netlify Blobs
    const rsvpKey = 'wine-rsvp-' + (date || tasting).replace(/\//g, '-').replace(/\s/g, '-');
    const url = 'https://api.netlify.com/api/v1/blobs/' + siteId + '/wine-rsvps/' + rsvpKey;
    let rsvps = [];
    try {
      const existing = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (existing.ok) { const d = await existing.json(); rsvps = d.rsvps || []; }
    } catch(e) {}

    // Check if already RSVP'd
    if (rsvps.some(r => r.email.toLowerCase() === email.toLowerCase())) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: true, alreadyRsvp: true }) };
    }

    rsvps.push({ name, email, tasting, date, time, rsvpAt: new Date().toISOString() });
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rsvps })
    });

    // Notify owner via Netlify Forms
    const formBody = new URLSearchParams({
      'form-name': 'wine-rsvp-notification',
      'memberName': name,
      'memberEmail': email,
      'tasting': tasting,
      'date': date || '',
      'time': time || ''
    }).toString();

    await fetch('https://roaring-pegasus-444826.netlify.app/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody
    });

    console.log('RSVP confirmed:', name, email, tasting);
    return { statusCode: 200, headers, body: JSON.stringify({ authorized: true, confirmed: true }) };

  } catch (err) {
    console.error('RSVP error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error. Please try again.' }) };
  }
};