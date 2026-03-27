const Stripe = require('stripe');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: 'Webhook signature failed' };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const m = session.metadata || {};
    const amount = (session.amount_total / 100).toFixed(2);

    // ── Store booking in Netlify Blobs so the golf page can grey out slots ──
    try {
      const { getStore } = require('@netlify/blobs');
      const store = getStore('golf-bookings');
      const bookingKey = (m.date + '_' + m.time + '_' + m.bay).replace(/[^a-zA-Z0-9_-]/g, '-');
      await store.set(bookingKey, JSON.stringify({
        name: m.customerName, email: m.customerEmail,
        bay: m.bay, date: m.date, time: m.time,
        duration: m.duration, players: m.players,
        amount, bookedAt: new Date().toISOString()
      }));
    } catch(blobErr) {
      console.error('Blob store error:', blobErr.message);
    }

    // ── Send notification email to The Quarry ──
    await sendEmail({
      to: 'management@thequarrystl.com',
      subject: 'New Golf Booking — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#B8933A;">New Golf Bay Booking</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Name</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.customerName}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Email</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.customerEmail}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Bay</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.bay}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Date</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.date}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Time</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.time}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Duration</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.duration}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">Players</td><td style="padding:8px;border-bottom:1px solid #eee;">${m.players}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Total Charged</td><td style="padding:8px;color:#B8933A;font-weight:bold;">$${amount}</td></tr>
        </table>
        <p style="color:#666;font-size:0.85rem;margin-top:20px;">Stripe session: ${session.id}</p>
      </div>`
    });

    // ── Send confirmation email to customer ──
    if (m.customerEmail) {
      await sendEmail({
        to: m.customerEmail,
        subject: 'Your Golf Bay Booking is Confirmed — The Quarry',
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#1A0E08;padding:24px;text-align:center;">
            <h1 style="color:#B8933A;font-family:Georgia,serif;margin:0;">The Quarry</h1>
            <p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.2em;margin:4px 0 0;">NEW MELLE, MISSOURI</p>
          </div>
          <div style="padding:32px 24px;background:#fff;">
            <h2 style="color:#2C1A0E;">Your Booking is Confirmed!</h2>
            <p style="color:#555;">Hi ${m.customerName}, your golf bay reservation at The Quarry's Surfside Hole-In-One Golf is confirmed.</p>
            <div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;">
              <p style="margin:4px 0;"><strong>Bay:</strong> ${m.bay}</p>
              <p style="margin:4px 0;"><strong>Date:</strong> ${m.date}</p>
              <p style="margin:4px 0;"><strong>Time:</strong> ${m.time}</p>
              <p style="margin:4px 0;"><strong>Duration:</strong> ${m.duration}</p>
              <p style="margin:4px 0;"><strong>Players:</strong> ${m.players}</p>
              <p style="margin:4px 0;color:#B8933A;font-weight:bold;"><strong>Total:</strong> $${amount}</p>
            </div>
            <p style="color:#555;font-size:0.9rem;">Please arrive 10 minutes early to check in. Late arrivals do not extend reservation time.</p>
            <p style="color:#555;font-size:0.9rem;">Questions? Call us at <a href="tel:6362248257" style="color:#B8933A;">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A;">management@thequarrystl.com</a></p>
          </div>
          <div style="background:#1A0E08;padding:16px;text-align:center;">
            <p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0;">3960 Highway Z, New Melle, MO 63385 &bull; 636-224-8257</p>
          </div>
        </div>`
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function sendEmail({ to, subject, html }) {
  try {
    const res = await fetch('https://api.netlify.com/v1/sendEmail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.NETLIFY_AUTH_TOKEN,
      },
      body: JSON.stringify({
        from: 'no-reply@thequarrystl.com',
        to,
        subject,
        html,
        siteId: process.env.SITE_ID,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Email send failed:', err);
    }
  } catch(e) {
    console.error('Email error:', e.message);
  }
}
