// event-webhook.js — legacy Stripe webhook for event ticket registrations.
// After the Stripe→Square migration, square-webhook handles new events;
// this stays for old in-flight sessions. Blob writes now go through the SDK
// (the prior direct REST calls were silently failing — see _blobs.js).
const Stripe = require('stripe');
const { readBlob, writeBlob } = require('./_blobs');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  let evt;
  try {
    evt = stripe.webhooks.constructEvent(event.body, event.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, body: 'Signature error' };
  }
  if (evt.type === 'checkout.session.completed') {
    const session = evt.data.object;
    const m = session.metadata || {};
    if (m.eventId) {
      const path = 'event-registrations/' + m.eventId;
      const existing = await readBlob(path);
      const regs = (existing && existing.registrations) || [];
      regs.push({
        firstName: m.firstName,
        lastName: m.lastName,
        email: session.customer_email || '',
        phone: m.phone,
        seatType: m.seatType,
        tableId: m.tableId || null,
        seatIds: (m.seatIds || '').split(',').filter(Boolean),
        partySize: parseInt(m.partySize) || 1,
        ticketType: m.ticketType || 'base',
        amount: session.amount_total,
        registeredAt: new Date().toISOString(),
      });
      await writeBlob(path, { registrations: regs });
    }
  }
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
