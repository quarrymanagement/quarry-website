const Stripe = require('stripe');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const m = session.metadata || {};
    const amount = ((session.amount_total || 0) / 100).toFixed(2);
    const siteId = process.env.SITE_ID || 'roaring-pegasus-444826';
    const token = process.env.NETLIFY_AUTH_TOKEN;

    // Store booking via Netlify Blobs REST API
    try {
      const dateKey = (m.date || 'unknown').replace(/[^0-9-]/g, '-');
      const storeKey = encodeURIComponent('golf-bookings-' + dateKey);
      // Get existing bookings for this date
      const existing = await fetch(
        `https://api.netlify.com/api/v1/blobs/${siteId}/${storeKey}`,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      let bookings = [];
      if (existing.ok) {
        const data = await existing.json();
        bookings = data.bookings || [];
      }
      // Add new booking
      bookings.push({ bay: m.bay, time: m.time, name: m.customerName, bookedAt: new Date().toISOString() });
      await fetch(
        `https://api.netlify.com/api/v1/blobs/${siteId}/${storeKey}`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookings })
        }
      );
    } catch(e) { console.error('Blob store error:', e.message); }

    // Email The Quarry
    const ownerEmail = buildEmail({
      to: 'management@thequarrystl.com',
      subject: 'New Golf Booking — ' + (m.bay||'') + ' on ' + (m.date||'') + ' at ' + (m.time||''),
      body: '<h2 style="color:#B8933A">New Golf Bay Booking</h2>' +
        '<p><b>Name:</b> ' + (m.customerName||'') + '</p>' +
        '<p><b>Email:</b> ' + (m.customerEmail||'') + '</p>' +
        '<p><b>Bay:</b> ' + (m.bay||'') + '</p>' +
        '<p><b>Date:</b> ' + (m.date||'') + '</p>' +
        '<p><b>Time:</b> ' + (m.time||'') + '</p>' +
        '<p><b>Duration:</b> ' + (m.duration||'') + '</p>' +
        '<p><b>Players:</b> ' + (m.players||'') + '</p>' +
        '<p><b>Total:</b> $' + amount + '</p>' +
        '<p style="color:#888;font-size:0.8rem">Session: ' + session.id + '</p>'
    });
    await sendEmail(ownerEmail, token, siteId);

    // Email customer
    if (m.customerEmail) {
      const custEmail = buildEmail({
        to: m.customerEmail,
        subject: 'Your Golf Bay Booking is Confirmed — The Quarry',
        body: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;font-family:Georgia,serif;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.2em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Your Booking is Confirmed!</h2>' +
          '<p>Hi ' + (m.customerName||'') + ', your golf bay is booked at The Quarry.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          '<p style="margin:4px 0"><b>Bay:</b> ' + (m.bay||'') + '</p>' +
          '<p style="margin:4px 0"><b>Date:</b> ' + (m.date||'') + '</p>' +
          '<p style="margin:4px 0"><b>Time:</b> ' + (m.time||'') + '</p>' +
          '<p style="margin:4px 0"><b>Duration:</b> ' + (m.duration||'') + '</p>' +
          '<p style="margin:4px 0;color:#B8933A"><b>Total: $' + amount + '</b></p></div>' +
          '<p>Please arrive 10 minutes early. Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p>' +
          '</div><div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385 &bull; 636-224-8257</p></div></div>'
      });
      await sendEmail(custEmail, token, siteId);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

function buildEmail({ to, subject, body }) {
  return { to, subject, html: body };
}

async function sendEmail({ to, subject, html }, token, siteId) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ from: 'bookings@thequarrystl.com', to, subject, html, siteId })
    });
    if (!res.ok) console.error('Email failed:', await res.text());
  } catch(e) { console.error('Email error:', e.message); }
}
