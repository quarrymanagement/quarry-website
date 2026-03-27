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

  console.log('Webhook received:', stripeEvent.type);

  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi = stripeEvent.data.object;
    const m = pi.metadata || {};
    const amount = '$' + (pi.amount / 100).toFixed(2);

    console.log('Payment succeeded:', pi.id, m.customerEmail, amount);

    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';

    // Store booking
    try {
      const dateKey = (m.date || 'unknown').replace(/\//g, '-');
      const key = encodeURIComponent('golf-' + dateKey + '-' + (m.bay||'').replace(/\s+/g,'-'));
      const existing = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
        headers: { Authorization: 'Bearer ' + token }
      });
      let bookings = [];
      if (existing.ok) { try { bookings = (await existing.json()).bookings || []; } catch(e){} }
      bookings.push({ bay: m.bay, time: m.time, name: m.customerName, bookedAt: new Date().toISOString() });
      await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookings })
      });
      console.log('Booking stored:', key);
    } catch(e) { console.error('Blob error:', e.message); }

    // Send owner email
    const ownerResult = await sendEmail(token, siteId, {
      to: 'management@thequarrystl.com',
      subject: 'New Golf Booking — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
      html: '<h2 style="color:#B8933A">New Golf Bay Booking</h2>' +
        '<p><b>Name:</b> ' + m.customerName + '</p>' +
        '<p><b>Email:</b> ' + m.customerEmail + '</p>' +
        '<p><b>Bay:</b> ' + m.bay + '</p>' +
        '<p><b>Date:</b> ' + m.date + '</p>' +
        '<p><b>Time:</b> ' + m.time + '</p>' +
        '<p><b>Duration:</b> ' + m.duration + '</p>' +
        '<p><b>Players:</b> ' + m.players + '</p>' +
        '<p><b>Total:</b> ' + amount + '</p>' +
        '<p style="color:#888;font-size:0.8rem">Payment: ' + pi.id + '</p>'
    });
    console.log('Owner email result:', ownerResult);

    // Send customer email
    if (m.customerEmail) {
      const custResult = await sendEmail(token, siteId, {
        to: m.customerEmail,
        subject: 'Your Golf Bay Booking is Confirmed — The Quarry',
        html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;font-family:Georgia,serif;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.2em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
          '<p>Hi ' + m.customerName + ', your golf bay is reserved.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Bay:</b> ' + m.bay + '</p>' +
          '<p style="margin:4px 0"><b>Date:</b> ' + m.date + '</p>' +
          '<p style="margin:4px 0"><b>Time:</b> ' + m.time + '</p>' +
          '<p style="margin:4px 0"><b>Duration:</b> ' + m.duration + '</p>' +
          '<p style="margin:4px 0;color:#B8933A"><b>Total: ' + amount + '</b></p></div>' +
          '<p>Arrive 10 minutes early. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p>' +
          '</div><div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
      });
      console.log('Customer email result:', custResult);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function sendEmail(token, siteId, { to, subject, html }) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ from: 'bookings@thequarrystl.com', to, subject, html, siteId })
    });
    const body = await res.text();
    console.log('sendEmail', to, 'status:', res.status, 'body:', body.substring(0, 200));
    return { status: res.status, body };
  } catch(e) {
    console.error('sendEmail error:', e.message);
    return { error: e.message };
  }
}
