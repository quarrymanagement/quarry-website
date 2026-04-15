const Stripe = require('stripe');
const AWS = require('aws-sdk');

// Initialize AWS SES for free booking emails
const ses = new AWS.SES({
  region: process.env.SES_REGION || 'us-east-1',
  accessKeyId: process.env.SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.SES_SECRET_ACCESS_KEY,
});

async function sendSesEmail(to, subject, htmlBody) {
  return ses.sendEmail({
    Source: 'The Quarry STL <management@thequarrystl.com>',
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  }).promise();
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

    // Free booking — skip Stripe, send emails directly via SES
    if (amountCents === 0) {
      await storeBooking(m, '0.00');

      // Owner email via SES
      try {
        await sendSesEmail('management@thequarrystl.com',
          'New Golf Booking (Free) — ' + m.bay + ' on ' + m.date + ' at ' + m.time,
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
          '<div style="background:#1A0E08;padding:24px;text-align:center">' +
          '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
          '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
          '<div style="padding:32px 24px;background:#FFFFFF">' +
          '<h2 style="color:#2C1A0E;margin-top:0">New Golf Bay Booking (Free)</h2>' +
          '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
          '<p style="margin:6px 0"><strong>Name:</strong> ' + (m.customerName || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Email:</strong> ' + (m.customerEmail || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Bay:</strong> ' + (m.bay || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Date:</strong> ' + (m.date || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Time:</strong> ' + (m.time || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Duration:</strong> ' + (m.duration || '') + '</p>' +
          '<p style="margin:6px 0"><strong>Players:</strong> ' + (m.players || '') + '</p>' +
          '<p style="margin:6px 0;color:#B8933A;font-size:1.1em"><strong>Total: $0.00 (Coupon Applied)</strong></p></div>' +
          '</div>' +
          '<div style="background:#1A0E08;padding:16px;text-align:center">' +
          '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>'
        );
        console.log('Owner free booking email sent');
      } catch (e) {
        console.error('Owner free booking email error:', e.message);
      }

      // Customer email via SES
      if (m.customerEmail) {
        try {
          await sendSesEmail(m.customerEmail,
            'Golf Booking Confirmed — The Quarry',
            '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">' +
            '<div style="background:#1A0E08;padding:24px;text-align:center">' +
            '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
            '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
            '<div style="padding:32px 24px;background:#FFFFFF">' +
            '<h2 style="color:#2C1A0E;margin-top:0">Booking Confirmed!</h2>' +
            '<p style="color:#444">Hi ' + (m.customerName || '') + ', your golf bay is reserved.</p>' +
            '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
            '<p style="margin:6px 0"><strong>Bay:</strong> ' + (m.bay || '') + '</p>' +
            '<p style="margin:6px 0"><strong>Date:</strong> ' + (m.date || '') + '</p>' +
            '<p style="margin:6px 0"><strong>Time:</strong> ' + (m.time || '') + '</p>' +
            '<p style="margin:6px 0"><strong>Duration:</strong> ' + (m.duration || '') + '</p>' +
            '<p style="margin:6px 0"><strong>Players:</strong> ' + (m.players || '') + '</p>' +
            '<p style="margin:6px 0;color:#B8933A;font-size:1.1em"><strong>Total: $0.00</strong></p></div>' +
            '<p style="color:#444">Please arrive 10 minutes early.</p>' +
            '<p style="color:#444">Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
            '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
            '<div style="background:#1A0E08;padding:16px;text-align:center">' +
            '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>'
          );
          console.log('Customer free booking email sent to', m.customerEmail);
        } catch (e) {
          console.error('Customer free booking email error:', e.message);
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ free: true }) };
    }

    // Create Stripe Checkout Session (paid bookings — webhook handles emails)
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
    const siteId = process.env.SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
    const dateKey = (m.date || 'unknown').replace(/\//g, '-');
    const key = encodeURIComponent('golf-' + dateKey);
    let bookings = [];
    try {
      const existing = await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (existing.ok) { bookings = (await existing.json()).bookings || []; }
    } catch (e) {}
    bookings.push({ bay: m.bay, time: m.time, name: m.customerName, email: m.customerEmail, bookedAt: new Date().toISOString() });
    await fetch('https://api.netlify.com/api/v1/blobs/' + siteId + '/' + key, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookings })
    });
    console.log('Booking stored:', m.bay, m.date, m.time);
  } catch (e) {
    console.error('storeBooking error:', e.message);
  }
}