// get-event.js — return event + registrations for a given eventId.
// Migrated to SDK-backed blob reads (see _blobs.js).
const { readBlob } = require('./_blobs');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const eventId = event.queryStringParameters?.eventId;
  if (!eventId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId required' }) };
  try {
    const evData = await readBlob('quarry-events/event-' + eventId);
    if (!evData) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };
    const regs = (await readBlob('quarry-registrations/event-' + eventId)) || {};
    const registrations = regs.registrations || [];
    const barSeatsTaken = [], tablesTaken = [];
    registrations.forEach((r) => {
      if (r.seatType === 'table') tablesTaken.push(r.tableId);
      else if (r.seatType === 'bar') (r.barSeats || []).forEach((s) => barSeatsTaken.push(s));
    });
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        event: evData,
        registrationCount: registrations.length,
        tablesTaken: [...new Set(tablesTaken)],
        barSeatsTaken: [...new Set(barSeatsTaken)],
        registrations: registrations.map((r) => ({
          name: r.name, partySize: r.partySize, tableId: r.tableId,
          barSeats: r.barSeats, email: r.email,
        })),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
