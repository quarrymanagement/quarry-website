// get-bookings.js — return the list of booked (bay,time) slots for a given date.
// Uses the SDK-backed _blobs helper; the prior direct REST call to
// api.netlify.com/api/v1/blobs/... was silently 404'ing on PUTs and returning
// empty container listings on GETs, so customer-facing availability never saw
// real bookings (see _blobs.js for context).
const { readBlob } = require('./_blobs');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const date = event.queryStringParameters && event.queryStringParameters.date;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'date required' }) };
    const dateKey = date.replace(/\//g, '-');
    const data = await readBlob('golf-bookings/' + dateKey);
    const bookings = (data && data.bookings) || [];
    const booked = bookings.map(function(b) { return { bay: b.bay, time: b.time }; });
    console.log('get-bookings:', dateKey, 'found', booked.length, 'booking(s)');
    return { statusCode: 200, headers, body: JSON.stringify({ booked: booked }) };
  } catch (err) {
    console.error('get-bookings error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ booked: [] }) };
  }
};
