const Stripe = require('stripe');
const nodemailer = require('nodemailer');

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
    console.log('Booking complete:', m.bay, m.date, m.time, m.customerEmail, amount);
    await storeBooking(m);
    await sendEmails(m, amount, session.id);
  }
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function storeBooking(m) {
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/golf-bookings/${dateKey}`;
    let bookings = [];
    try {
      const existing = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (existing.ok) { const data = await existing.json(); bookings = data.bookings || []; }
    } catch(e) { console.log('No existing bookings for this date'); }
    bookings.push({ bay: m.bay, time: m.time, date: m.date, name: m.customerName, email: m.customerEmail, players: m.players, bookedAt: new Date().toISOString() });
    const res = await fetch(url, { method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookings }) });
    console.log('Booking stored status:', res.status, 'date:', dateKey, 'bay:', m.bay, 'time:', m.time);
  } catch(err) { console.error('storeBooking error:', err.message); }
}

async function sendEmails(m, amount, sessionId) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });
    // Owner email
    await transporter.sendMail({
      from: '"The Quarry Bookings" <' + process.env.GMAIL_USER + '>',
      to: 'management@thequarrystl.com',
      subject: 'New Golf Booking — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
      html: '<div style="font-family:Arial,sans-serif;max-width:600px"><div style="background:#2C1A0E;padding:20px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1><p style="color:rgba(255,255,255,0.5);font-size:0.7rem;margin:4px 0 0;letter-spacing:0.15em">NEW GOLF BOOKING</p></div><div style="padding:24px"><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">NAME</td><td style="font-weight:600">' + m.customerName + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">EMAIL</td><td>' + m.customerEmail + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">PHONE</td><td>' + (m.customerPhone||'N/A') + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">BAY</td><td style="font-weight:600">' + m.bay + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">DATE</td><td style="font-weight:600">' + m.date + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">TIME</td><td style="font-weight:600">' + m.time + '</td></tr><tr><td style="padding:8px 0;color:#888;font-size:0.8rem">PLAYERS</td><td>' + m.players + '</td></tr><tr style="border-top:2px solid #B8933A"><td style="padding:12px 0;color:#B8933A;font-weight:700">TOTAL</td><td style="color:#B8933A;font-weight:700;font-size:1.1rem">' + amount + '</td></tr></table><p style="color:#aaa;font-size:0.7rem">Stripe Session: ' + sessionId + '</p></div></div>'
    });
    console.log('Owner email sent');
    // Customer email
    if (m.customerEmail) {
      await transporter.sendMail({
        from: '"The Quarry" <' + process.env.GMAIL_USER + '>',
        to: m.customerEmail,
        subject: 'Your Golf Booking is Confirmed — The Quarry',
        html: '<div style="font-family:Arial,sans-serif;max-width:600px"><div style="background:#2C1A0E;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1><p style="color:rgba(255,255,255,0.5);font-size:0.7rem;margin:4px 0 0;letter-spacing:0.2em">NEW MELLE, MISSOURI</p></div><div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2><p style="color:#555">Hi ' + m.customerName + ', your bay is reserved. See you soon!</p><div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0"><p style="margin:4px 0"><strong>Bay:</strong> ' + m.bay + '</p><p style="margin:4px 0"><strong>Date:</strong> ' + m.date + '</p><p style="margin:4px 0"><strong>Time:</strong> ' + m.time + '</p><p style="margin:4px 0"><strong>Duration:</strong> ' + (m.duration||'50 Minutes') + '</p><p style="margin:4px 0"><strong>Players:</strong> ' + m.players + '</p><p style="margin:8px 0 0;color:#B8933A;font-weight:700;font-size:1rem">Total: ' + amount + '</p></div><p style="color:#555;line-height:1.7">Please arrive <strong>10 minutes early</strong> to check in.<br>Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div><div style="background:#2C1A0E;padding:16px;text-align:center"><p style="color:rgba(255,255,255,0.35);font-size:0.7rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
      });
      console.log('Customer email sent to', m.customerEmail);
    }
  } catch(err) { console.error('sendEmails error:', err.message); }
}