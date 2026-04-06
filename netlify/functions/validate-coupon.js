const Stripe = require('stripe');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ valid: false, error: 'Method not allowed' }) };

  try {
    const { code } = JSON.parse(event.body || '{}');
    if (!code) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'No code provided' }) };
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    // Search for active promotion codes matching the entered code
    const promoCodes = await stripe.promotionCodes.list({
      code: code.toUpperCase().trim(),
      active: true,
      limit: 1
    });

    if (promoCodes.data.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'Coupon code not found or expired.' }) };
    }

    const promo = promoCodes.data[0];

    // Check if it's restricted to a specific customer
    if (promo.customer) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'This coupon is restricted.' }) };
    }

    // Check max redemptions
    if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'This coupon has been fully redeemed.' }) };
    }

    // Check expiration
    if (promo.expires_at && Date.now() / 1000 > promo.expires_at) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'This coupon has expired.' }) };
    }

    // Get the coupon details — in Stripe SDK v14+, promo.coupon is already the expanded coupon object
    let coupon = promo.coupon;
    if (typeof coupon === 'string') {
      // If it's just an ID string, fetch the full object
      coupon = await stripe.coupons.retrieve(coupon);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        code: code.toUpperCase().trim(),
        percent_off: coupon.percent_off || null,
        amount_off: coupon.amount_off || null,
        promoId: promo.id
      })
    };

  } catch (err) {
    console.error('validate-coupon error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: 'Error validating coupon.' }) };
  }
};
