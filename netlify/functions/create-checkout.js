const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = JSON.parse(event.body);
    const COUPON_MAP = {
      'QUARRY10':'9kWg5Hm0','QUARRY20':'GsFyRnI1','GOLF50':'27Onighg',
      'TESTCODE':'HN3UXdpJ','ADMIN100':'TPMD4tKc',
    };
    const sessionParams = {
      payment_method_types: ['card'],
      line_items: body.lineItems || [],
      mode: 'payment',
      success_url: body.successUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf?success=true',
      cancel_url: body.cancelUrl || 'https://roaring-pegasus-444826.netlify.app/quarry-golf?canceled=true',
      // Store all booking details in metadata so webhook can access them
      metadata: {
        customerName: body.metadata?.customerName || '',
        customerEmail: body.metadata?.customerEmail || '',
        bay: body.metadata?.bay || '',
        date: body.metadata?.date || '',
        time: body.metadata?.time || '',
        duration: body.metadata?.duration || '',
        players: body.metadata?.players || '',
        coupon: body.coupon || '',
      },
      customer_email: body.metadata?.customerEmail || undefined,
    };
    if (body.coupon) {
      const stripeId = COUPON_MAP[body.coupon.toUpperCase().trim()];
      if (stripeId) sessionParams.discounts = [{ coupon: stripeId }];
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    return { statusCode: 200, body: JSON.stringify({ sessionId: session.id, url: session.url }) };
  } catch (err) {
    console.error('Checkout error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
