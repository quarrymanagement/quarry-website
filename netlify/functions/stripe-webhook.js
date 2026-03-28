const Stripe = require('stripe');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook sig error:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  console.log('Webhook event:', stripeEvent.type);

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const m = session.metadata || {};
    const amount = '$' + ((session.amount_total || 0) / 100).toFixed(2);
    console.log('Booking paid:', m.bay, m.date, m.time, m.customerEmail, amount);

    // 1. Store booking so slot gets blocked
    await storeBooking(m);

    // 2. Notify via Netlify Forms — Netlify emails management@thequarrystl.com automatically
    await notifyViaNetlifyForm(m, amount);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function storeBooking(m) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const url = 'https://api.netlify.com/api/v1/blobs/' + siteId + '/golf-bookings/' + dateKey;
    let bookings = [];
    try {
      const existing = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (existing.ok) { const data = await existing.json(); bookings = data.bookings || []; }
    } catch(e) {}
    bookings.push({ bay: m.bay, time: m.time, date: m.date, name: m.customerName, email: m.customerEmail, players: m.players, bookedAt: new Date().toISOString() });
    const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookings }) });
    console.log('Booking stored:', res.status, m.bay, m.date, m.time);
  } catch(err) { console.error('storeBooking error:', err.message); }
}

async function notifyViaNetlifyForm(m, amount) {
  try {
    const body = new URLSearchParams({
      'form-name': 'golf-booking',
      'customerName': m.customerName || '',
      'customerEmail': m.customerEmail || '',
      'customerPhone': m.customerPhone || '',
      'bay': m.bay || '',
      'date': m.date || '',
      'time': m.time || '',
      'players': m.players || '',
      'amount': amount
    }).toString();

    const res = await fetch('https://roaring-pegasus-444826.netlify.app/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body
    });
    console.log('Netlify form notification status:', res.status);
  } catch(err) { console.error('notifyViaNetlifyForm error:', err.message); }
}