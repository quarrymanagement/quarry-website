exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const date = event.queryStringParameters && event.queryStringParameters.date;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const dateKey = date.replace(/\//g, '-');
    const url = `https://api.netlify.com/api/v1/blobs/${siteId}/golf-bookings/${dateKey}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      console.log('No bookings found for', dateKey, 'status:', res.status);
      return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
    }
    const data = await res.json();
    const bookings = data.bookings || [];
    const booked = bookings.map(function(b) { return { bay: b.bay, time: b.time }; });
    console.log('get-bookings:', dateKey, 'found', booked.length, 'booking(s)');
    return { statusCode: 200, headers, body: JSON.stringify({ booked: booked }) };
  } catch(err) {
    console.error('get-bookings error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
  }
};