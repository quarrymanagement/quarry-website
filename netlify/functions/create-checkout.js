const Stripe = require('stripe');
const https = require('https');

function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'management@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  var toArray = Array.isArray(to) ? to : [to];
  var payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(email) { return { email: email }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: body });
        } else {
          reject(new Error('SendGrid error ' + res.statusCode + ': ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const COUPONS = {
      'QUARRY10': { pct: 10 },
      'QUARRY20': { pct: 20 },
      'GOLF50':   { pct: 50 },
      'TESTCODE': { flat: 500 },
      'TEST1':    { flat: 5900 },
      'ADMIN100': { pct: 100 },
    };

    let amountCents = body.amount || 6000;

    // Apply coupon discount
    if (body.coupon) {
      const code = body.coupon.toUpperCase().trim();
      const c = COUPONS[code];
      if (!c) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Coupon not found: ' + code }) };
      amountCents = c.pct !== undefined
        ? Math.round(amountCents * (1 - c.pct / 100))
        : Math.max(0, amountCents - c.flat);
    }

    const m = body.metadata || {};
    const origin = event.headers.origin || 'https://roaring-pegasus-444826.netlify.app';

    // Free booking — skip Stripe entirely
    if (amountCents === 0) {
      // Store booking directly
      await storeBooking(m, '0.00');
      await sendOwnerEmail(m, '$0.00');
      if (m.customerEmail) await sendCustomerEmail(m, '$0.00');
      return { statusCode: 200, headers, body: JSON.stringify({ free: true }) };
    }

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
    allow_promotion_codes: true,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Surfside Hole-In-One Golf — ' + (m.bay || 'Bay'),
            description: (m.date || '') + ' at ' + (m.time || '') + ' | ' + (m.duration || '50 min') + ' | ' + (m.players || '2') + ' players',
          },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: m.customerEmail || undefined,
      metadata: {
        customerName:  m.customerName  || '',
        customerEmail: m.customerEmail || '',
        bay:      m.bay      || '',
        date:     m.date     || '',
        time:     m.time     || '',
        duration: m.duration || '',
        players:  m.players  || '',
        coupon:   body.coupon || '',
      },
      success_url: origin + '/quarry-golf?success=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  origin + '/quarry-golf?canceled=1',
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };

  } catch (err) {
    console.error('create-checkout error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
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
    await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookings })
    });
    console.log('Booking stored:', m.bay, m.date, m.time);
  } catch(e) { console.error('storeBooking error:', e.message); }
}

async function sendOwnerEmail(m, amount) {
  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'New Golf Booking — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
      '<h2 style="color:#B8933A">New Golf Bay Booking</h2>' +
      '<p><b>Name:</b> ' + m.customerName + '</p><p><b>Email:</b> ' + m.customerEmail + '</p>' +
      '<p><b>Bay:</b> ' + m.bay + '</p><p><b>Date:</b> ' + m.date + '</p>' +
      '<p><b>Time:</b> ' + m.time + '</p><p><b>Duration:</b> ' + m.duration + '</p>' +
      '<p><b>Players:</b> ' + m.players + '</p><p><b>Total:</b> ' + amount + '</p>',
      'bookings@thequarrystl.com',
      'The Quarry STL'
    );
    console.log('Owner email sent via SendGrid');
  } catch(e) { console.error('sendOwnerEmail error:', e.message); }
}

async function sendCustomerEmail(m, amount) {
  try {
    await sendGridEmail(
      m.customerEmail,
      'Your Golf Booking is Confirmed — The Quarry',
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
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
      '<p>Arrive 10 minutes early. Questions? <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or ' +
      '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
      '<div style="background:#1A0E08;padding:16px;text-align:center">' +
      '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
      'bookings@thequarrystl.com',
      'The Quarry STL'
    );
    console.log('Customer email sent via SendGrid');
  } catch(e) { console.error('sendCustomerEmail error:', e.message); }
}
