const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = JSON.parse(event.body);

    // Short-circuit: just return the publishable key for Stripe init
    if (body.getKeyOnly) {
      return { statusCode: 200, body: JSON.stringify({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }) };
    }

    const COUPON_MAP = {
      'QUARRY10': 10, 'QUARRY20': 20, 'GOLF50': 50,
      'TESTCODE': null, 'ADMIN100': 100,
    };
    const COUPON_FLAT = { 'TESTCODE': 500 }; // cents

    // Calculate amount from line items
    let amountCents = 0;
    if (body.lineItems && body.lineItems.length > 0) {
      const li = body.lineItems[0];
      const unitAmount = li.price_data?.unit_amount || li.amount || 6000;
      const qty = li.quantity || 1;
      amountCents = unitAmount * qty;
      // Add extra balls if any
      if (body.lineItems[1]) {
        const extra = body.lineItems[1];
        amountCents += (extra.price_data?.unit_amount || extra.amount || 0) * (extra.quantity || 1);
      }
    } else {
      amountCents = body.amount || 6000;
    }

    // Apply coupon
    if (body.coupon) {
      const code = body.coupon.toUpperCase().trim();
      if (COUPON_MAP[code] !== undefined) {
        if (COUPON_MAP[code] !== null) {
          amountCents = Math.round(amountCents * (1 - COUPON_MAP[code] / 100));
        } else if (COUPON_FLAT[code]) {
          amountCents = Math.max(0, amountCents - COUPON_FLAT[code]);
        }
      }
    }

    // Ensure minimum charge (Stripe requires at least 50 cents, or 0 for free)
    if (amountCents > 0 && amountCents < 50) amountCents = 50;

    const m = body.metadata || {};
    const piParams = {
      amount: amountCents,
      currency: 'usd',
      metadata: {
        customerName: m.customerName || '',
        customerEmail: m.customerEmail || '',
        bay: m.bay || '',
        date: m.date || '',
        time: m.time || '',
        duration: m.duration || '',
        players: m.players || '',
        coupon: body.coupon || '',
      },
      receipt_email: m.customerEmail || undefined,
      description: 'Surfside Hole-In-One Golf — ' + (m.bay||'') + ' on ' + (m.date||'') + ' at ' + (m.time||''),
    };

    // For $0 (100% coupon), return success immediately without charging
    if (amountCents === 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({ free: true, metadata: piParams.metadata, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }),
      };
    }

    const pi = await stripe.paymentIntents.create(piParams);
    return {
      statusCode: 200,
      body: JSON.stringify({ clientSecret: pi.client_secret, amount: amountCents, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY }),
    };
  } catch (err) {
    console.error('create-checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
