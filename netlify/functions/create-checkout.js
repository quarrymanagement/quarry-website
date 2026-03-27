const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Map of frontend coupon codes to Stripe coupon IDs
const COUPON_MAP = {
  'QUARRY10': '9kWg5Hm0',
  'QUARRY20': 'GsFyRnI1',
  'GOLF50':   '27Onighg',
  'TESTCODE': 'HN3UXdpJ',
  'ADMIN100': 'UBEv5vic',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { priceId, quantity, coupon } = body;

    // Build session params
    const sessionParams = {
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: quantity || 1 }],
      mode: 'payment',
      success_url: body.successUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf.html?success=true',
      cancel_url: body.cancelUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf.html?canceled=true',
    };

    // Apply coupon if provided and valid
    if (coupon) {
      const stripeId = COUPON_MAP[coupon.toUpperCase()];
      if (stripeId) {
        sessionParams.discounts = [{ coupon: stripeId }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
