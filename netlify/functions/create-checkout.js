const Stripe = require('stripe');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');

    // Just return the publishable key if requested
    if (body.getKeyOnly) {
      return { statusCode: 200, headers, body: JSON.stringify({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }) };
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    // Coupon map — code -> { pct: X } or { flat: X (cents) }
    const COUPONS = {
      'QUARRY10': { pct: 10 },
      'QUARRY20': { pct: 20 },
      'GOLF50':   { pct: 50 },
      'TESTCODE': { flat: 500 },
      'TEST1':    { flat: 5900 },
      'ADMIN100': { pct: 100 },
    };

    // Base amount: 6000 cents ($60) + any extras
    let amountCents = 6000;
    if (body.lineItems && body.lineItems.length > 0) {
      amountCents = 0;
      for (const item of body.lineItems) {
        const unit = item.price_data?.unit_amount || item.amount || 6000;
        amountCents += unit * (item.quantity || 1);
      }
    } else if (body.amount) {
      amountCents = body.amount;
    }

    // Apply coupon
    if (body.coupon) {
      const code = body.coupon.toUpperCase().trim();
      const coupon = COUPONS[code];
      if (!coupon) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Coupon not found: ' + code }) };
      }
      if (coupon.pct !== undefined) {
        amountCents = Math.round(amountCents * (1 - coupon.pct / 100));
      } else {
        amountCents = Math.max(0, amountCents - coupon.flat);
      }
    }

    // Free booking (100% off)
    if (amountCents === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({
        free: true,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        metadata: body.metadata || {}
      })};
    }

    // Minimum charge
    if (amountCents < 50) amountCents = 50;

    const m = body.metadata || {};
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      receipt_email: m.customerEmail || undefined,
      description: 'Surfside Golf — ' + (m.bay||'') + ' ' + (m.date||'') + ' ' + (m.time||''),
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
    });

    return { statusCode: 200, headers, body: JSON.stringify({
      clientSecret: pi.client_secret,
      amount: amountCents,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    })};

  } catch (err) {
    console.error('create-checkout error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
