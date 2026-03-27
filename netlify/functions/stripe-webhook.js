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

  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi = stripeEvent.data.object;
    const m = pi.metadata || {};
    const amount = (pi.amount / 100).toFixed(2);
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';

    console.log('Payment succeeded:', pi.id, 'for', m.customerEmail);

    // Store booking
    try {
      const dateKey = (m.date||'unknown').replace(/[^0-9-]/g,'-');
      const storeKey = encodeURIComponent('golf-bookings-' + dateKey);
      const existing = await fetch(
        'https://api.netlify.com/api/v1/blobs/' + siteId + '/' + storeKey,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      let bookings = [];
      if (existing.ok) { try { bookings = (await existing.json()).bookings || []; } catch(e){} }
      bookings.push({ bay: m.bay, time: m.time, name: m.customerName, bookedAt: new Date().toISOString() });
      await fetch(
        'https://api.netlify.com/api/v1/blobs/' + siteId + '/' + storeKey,
        { method:'PUT', headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, body: JSON.stringify({ bookings }) }
      );
    } catch(e) { console.error('Blob error:', e.message); }

    // Email owner
    await sendEmail(token, siteId, {
      to: 'management@thequarrystl.com',
      subject: 'New Golf Booking — ' + (m.bay||'') + ' on ' + (m.date||'') + ' at ' + (m.time||''),
      html: '<h2 style="color:#B8933A">New Golf Bay Booking</h2>' +
        '<table style="border-collapse:collapse;width:100%">' +
        row('Name', m.customerName) + row('Email', m.customerEmail) +
        row('Bay', m.bay) + row('Date', m.date) + row('Time', m.time) +
        row('Duration', m.duration) + row('Players', m.players) +
        row('Total', '$' + amount) + '</table>' +
        '<p style="color:#888;font-size:0.8rem">Payment ID: ' + pi.id + '</p>'
    });

    // Email customer
    if (m.customerEmail) {
      await sendEmail(token, siteId, {
        to: m.customerEmail,
        subject: 'Your Golf Bay Booking is Confirmed — The Quarry',
        html: '<div style="font-family:Arial,sans-serif;max-width:600px">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;font-family:Georgia,serif;margin:0">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.2em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px"><h2 style="color:#2C1A0E">Booking Confirmed!</h2>' +
          '<p>Hi ' + (m.customerName||'') + ', your golf bay is booked.</p>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
          row2('Bay', m.bay) + row2('Date', m.date) + row2('Time', m.time) +
          row2('Duration', m.duration) + row2('Players', m.players) +
          '<p style="margin:4px 0;color:#B8933A"><b>Total: $' + amount + '</b></p></div>' +
          '<p>Arrive 10 minutes early. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or ' +
          '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
          '<div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>'
      });
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

function row(k,v) { return '<tr><td style="padding:6px 8px;font-weight:bold;border-bottom:1px solid #eee">'+k+'</td><td style="padding:6px 8px;border-bottom:1px solid #eee">'+(v||'')+'</td></tr>'; }
function row2(k,v) { return '<p style="margin:4px 0"><b>'+k+':</b> '+(v||'')+'</p>'; }

async function sendEmail(token, siteId, { to, subject, html }) {
  try {
    const r = await fetch('https://api.netlify.com/v1/sendEmail', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+token },
      body: JSON.stringify({ from:'bookings@thequarrystl.com', to, subject, html, siteId })
    });
    if (!r.ok) console.error('Email failed:', to, await r.text());
    else console.log('Email sent to:', to);
  } catch(e) { console.error('Email error:', e.message); }
}
