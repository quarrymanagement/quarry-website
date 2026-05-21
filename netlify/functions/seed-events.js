// seed-events.js — one-time event seeder. Migrated to SDK-backed blob writes
// (the prior direct REST call to api.netlify.com/api/v1/blobs silently 404'd).
const { writeBlob } = require('./_blobs');

exports.handler = async () => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const ev = {
    id: 'neon-bingo-apr-2026', title: 'Ladies Neon Singo Bingo Brunch',
    subtitle: 'Neon 80s Singo-Bingo', date: 'April 12, 2026', dateISO: '2026-04-12',
    startTime: '8:40 AM', endTime: '11:40 AM',
    location: 'The Quarry, 3960 State Hwy Z, Wentzville, MO 63385',
    description: 'Get your neon on! A glowing 80s-themed Singo Bingo Brunch at The Quarry.',
    priceBase: 35, pricePremium: 45,
    priceBaseLabel: 'Bingo + Brunch',
    pricePremiumLabel: 'Bottomless Mimosas/Bloody Marys + Brunch + Bingo',
    tableCount: 10, tableSize: 6, barSeatCount: 12, totalCapacity: 72,
    status: 'active', tags: ['Ladies Event', 'Brunch', 'Bingo', '80s Theme'],
  };
  const ok = await writeBlob('quarry-events/' + ev.id, ev);
  if (!ok) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Blob write failed' }) };
  return { statusCode: 200, headers: h, body: JSON.stringify({ seeded: true, id: ev.id }) };
};
