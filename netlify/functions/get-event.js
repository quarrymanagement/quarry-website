exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const eventId = event.queryStringParameters?.eventId;
  if (!eventId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'eventId required' }) };
  try {
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';
    const evRes = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-events/event-${eventId}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!evRes.ok) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };
    const evData = await evRes.json();
    let registrations = [];
    try {
      const regRes = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quarry-registrations/event-${eventId}`, { headers: { Authorization: 'Bearer ' + token } });
      if (regRes.ok) { const d = await regRes.json(); registrations = d.registrations || []; }
    } catch(e) {}
    const barSeatsTaken=[], tablesTaken=[];
    registrations.forEach(r => {
      if (r.seatType==='table') tablesTaken.push(r.tableId);
      else if (r.seatType==='bar') (r.barSeats||[]).forEach(s=>barSeatsTaken.push(s));
    });
    return { statusCode:200, headers, body: JSON.stringify({ event:evData, registrationCount:registrations.length, tablesTaken:[...new Set(tablesTaken)], barSeatsTaken:[...new Set(barSeatsTaken)], registrations:registrations.map(r=>({name:r.name,partySize:r.partySize,tableId:r.tableId,barSeats:r.barSeats,email:r.email})) }) };
  } catch(err) { return { statusCode:500, headers, body: JSON.stringify({ error: err.message }) }; }
};