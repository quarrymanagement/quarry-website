const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { eventName, eventDate, price, quantity, customerEmail } = JSON.parse(event.body);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail || undefined,
      line_items: [{ price_data: { currency: 'usd', product_data: { name: eventName, description: `${eventDate} · The Quarry, New Melle MO` }, unit_amount: Math.round(price * 100) }, quantity: quantity || 1 }],
      mode: 'payment',
      success_url: `${process.env.URL}/quarry-events.html?success=true&event=${encodeURIComponent(eventName)}`,
      cancel_url: `${process.env.URL}/quarry-events.html?cancelled=true`,
      metadata: { eventName, eventDate, quantity: String(quantity || 1) },
    });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
