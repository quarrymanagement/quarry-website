// ============================================================================
// events-feed.js — what https://thequarrystl.com/events.json serves.
//
// 2026-10-27: /events.json used to be the raw repo file straight off the CDN,
// so anyone could download every registration (Square/Stripe payment + order
// ids, amounts, coupon codes). netlify.toml now rewrites /events.json here,
// and this always returns data-read's anonymous public projection
// (_event-pii.publicEventsDoc): same document shape, registrations cut down
// to qty / seatingOptionId / seatType / arrivalSlot for seat counting.
// Query params (e.g. ?t=cache-bust) are ignored.
// ============================================================================
const dataRead = require('./data-read');

exports.handler = async (event) => {
  const res = await dataRead.handler({
    httpMethod: event.httpMethod === 'OPTIONS' ? 'OPTIONS' : 'GET',
    headers: {},                       // never act on a caller's session here
    queryStringParameters: { file: 'events.json' },
  });
  if (res && res.headers) res.headers['Netlify-Vary'] = 'query=__none__';
  return res;
};
