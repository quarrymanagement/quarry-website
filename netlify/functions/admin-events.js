// admin-events.js — admin CRUD for the quarry-events blob store.
// Migrated to SDK-backed blob ops (the prior direct REST calls were 404'ing
// silently — see _blobs.js).
const Stripe = require('stripe');
const { readBlob, writeBlob, deleteBlob, listKeys } = require('./_blobs');

const PW = process.env.ADMIN_PASSWORD || 'quarry2026';

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const body = JSON.parse(event.body || '{}');
  if (body.password !== PW) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const action = body.action;
  try {
    if (action === 'list') {
      const keys = await listKeys('quarry-events');
      const events = [];
      for (const key of keys) {
        const ev = await readBlob('quarry-events/' + key);
        if (ev) events.push(ev);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ events }) };
    }
    if (action === 'create') {
      const { name, date, time, description, pricePerSeat, tableCount, tableSeats, barSeatCount, category } = body.eventData;
      const eventId = 'evt-' + Date.now();
      let stripePaymentLink = null;
      if (pricePerSeat > 0) {
        const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
        const prod = await stripe.products.create({ name, description: `${name} — ${date} at ${time}` });
        const price = await stripe.prices.create({ product: prod.id, unit_amount: pricePerSeat, currency: 'usd' });
        const link = await stripe.paymentLinks.create({ line_items: [{ price: price.id, quantity: 1 }], allow_promotion_codes: true });
        stripePaymentLink = link.url;
      }
      const evData = {
        id: eventId, name, date, time, description,
        pricePerSeat: pricePerSeat || 0,
        tableCount: tableCount || 8,
        tableSeats: tableSeats || 4,
        barSeatCount: barSeatCount || 12,
        totalCapacity: (tableCount || 8) * (tableSeats || 4) + (barSeatCount || 12),
        category: category || 'General',
        stripePaymentLink,
        active: true,
        createdAt: new Date().toISOString(),
      };
      await writeBlob('quarry-events/event-' + eventId, evData);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, event: evData }) };
    }
    if (action === 'update') {
      const { eventId, updates } = body;
      const existing = await readBlob('quarry-events/event-' + eventId);
      if (!existing) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
      const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
      await writeBlob('quarry-events/event-' + eventId, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, event: updated }) };
    }
    if (action === 'delete') {
      await deleteBlob('quarry-events/event-' + body.eventId);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
    if (action === 'registrations') {
      const d = await readBlob('quarry-registrations/event-' + body.eventId);
      return { statusCode: 200, headers, body: JSON.stringify({ registrations: (d && d.registrations) || [] }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
