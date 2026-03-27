const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = JSON.parse(event.body);

    // Map front-end coupon code strings to Stripe coupon IDs
    const COUPON_MAP = {
      'QUARRY10': '9kWg5Hm0',
      'QUARRY20': 'GsFyRnI1',
      'GOLF50':   '27Onighg',
      'TESTCODE': 'HN3UXdpJ',
      'ADMIN100': 'TPMD4tKc',
    };

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: body.lineItems || [],
      mode: 'payment',
      success_url: body.successUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf.html?success=true',
      cancel_url: body.cancelUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf.html?canceled=true',
      metadata: body.metadata || {},
    };

    // Apply coupon if provided and valid
    if (body.coupon) {
      const couponCode = body.coupon.toUpperCase().trim();
      const stripeId = COUPON_MAP[couponCode];
      if (stripeId) {
        sessionParams.discounts = [{ coupon: stripeId }];
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      body: JSON.stringify({ sessionId: session.id, url: session.url }),
    };
  } catch (err) {
    console.error('Checkout error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
