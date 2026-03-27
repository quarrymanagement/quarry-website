exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const date = (event.queryStringParameters || {}).date;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };

    const siteId = process.env.SITE_ID || 'roaring-pegasus-444826';
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const storeKey = encodeURIComponent('golf-bookings-' + date);

    const res = await fetch(
      `https://api.netlify.com/api/v1/blobs/${siteId}/${storeKey}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );

    if (res.status === 404) return { statusCode: 200, headers, body: JSON.stringify({ date, booked: [] }) };
    if (!res.ok) throw new Error('Blob fetch failed: ' + res.status);

    const data = await res.json();
    const booked = (data.bookings || []).map(b => ({ bay: b.bay, time: b.time }));
    return { statusCode: 200, headers, body: JSON.stringify({ date, booked }) };
  } catch (err) {
    console.error('get-bookings error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
