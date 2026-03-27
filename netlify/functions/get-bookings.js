const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const date = event.queryStringParameters?.date;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };

    const store = getStore('golf-bookings');
    const { blobs } = await store.list({ prefix: date.replace(/[^0-9-]/g, '-') });
    const bookings = await Promise.all(
      blobs.map(async b => {
        try { return JSON.parse(await store.get(b.key)); } catch { return null; }
      })
    );
    // Return just the booked bay+time combos (no personal data to the public)
    const booked = bookings.filter(Boolean).map(b => ({ bay: b.bay, time: b.time }));
    return { statusCode: 200, headers, body: JSON.stringify({ date, booked }) };
  } catch (err) {
    console.error('get-bookings error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
