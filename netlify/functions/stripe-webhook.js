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

    console.log('Checkout complete:', session.id, m.customerEmail, amount);

    // Store booking
    await storeBooking(m, amount);

    // Send emails
    await sendOwnerEmail(m, amount, session.id);
    if (m.customerEmail) await sendCustomerEmail(m, amount);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function storeBooking(m, amount) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const key = encodeURIComponent('golf-' + dateKey);
    const existing = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
      headers: { Authorization: 'Bearer ' + token }
    });
    let bookings = [];
    if (existing.ok) { try { bookings = (await existing.json()).bookings || []; } catch(e){} }
    bookings.push({ bay: m.bay, time: m.time, name: m.customerName, bookedAt: new Date().toISOString() });
    const putRes = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookings })
    });
    console.log('Booking stored, status:', putRes.status, 'key:', key);
  } catch(e) { console.error('storeBooking error:', e.message); }
}

async function sendOwnerEmail(m, amount, sessionId) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = 'roaring-pegasus-444826';
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        from: 'bookings@thequarrystl.com',
        to: 'management@thequarrystl.com',
        subject: 'New Golf Booking — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
        html: '<h2 style="color:#B8933A">New Golf Bay Booking</h2>' +
          '<p><b>Name:</b> ' + m.customerName + '</p><p><b>Email:</b> ' + m.customerEmail + '</p>' +
          '<p><b>Bay:</b> ' + m.bay + '</p><p><b>Date:</b> ' + m.date + '</p>' +
          '<p><b>Time:</b> ' + m.time + '</p><p><b>Duration:</b> ' + m.duration + '</p>' +
          '<p><b>Players:</b> ' + m.players + '</p><p><b>Total:</b> ' + amount + '</p>' +
          '<p style="color:#888;font-size:0.8rem">Session: ' + sessionId + '</p>',
        siteId
      })
    });
    console.log('Owner email status:', res.status, await res.text());
  } catch(e) { console.error('sendOwnerEmail error:', e.message); }
}

async function sendCustomerEmail(m, amount) {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = 'roaring-pegasus-444826';
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        from: 'bookings@thequarrystl.com',
        to: m.customerEmail,
        subject: 'Your Golf Booking is Confirmed — The Quarry',
        html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
          '<p>Hi ' + m.customerName + ', your bay is reserved.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Bay:</b> ' + m.bay + '</p>' +
          '<p style="margin:4px 0"><b>Date:</b> ' + m.date + '</p>' +
          '<p style="margin:4px 0"><b>Time:</b> ' + m.time + '</p>' +
          '<p style="margin:4px 0"><b>Duration:</b> ' + m.duration + '</p>' +
          '<p style="margin:4px 0;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
          '<p>Arrive 10 minutes early. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p></div>' +
          '<div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
        siteId
      })
    });
    console.log('Customer email status:', res.status);
  } catch(e) { console.error('sendCustomerEmail error:', e.message); }
}
