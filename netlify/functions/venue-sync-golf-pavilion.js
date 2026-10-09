// ============================================================================
// venue-sync-golf-pavilion.js
//
// Scheduled every 15 minutes (see netlify.toml). Reconciles golf-bay and
// pavilion bookings onto the venue calendar. Immediate updates also happen when
// a booking is saved (square-webhook / pavilion admin tools); this is the
// safety net that catches anything those missed and applies removals.
// Netlify blocks direct HTTP calls to scheduled functions -- to run it on demand
// use venue-sync-admin with an owner token.
// ============================================================================
const { syncKind } = require('./_venue-sync-shared');

exports.handler = async () => {
  const out = {};
  for (const kind of ['golf', 'pavilion']) {
    try { out[kind] = await syncKind(kind); }
    catch (e) { out[kind] = { ok: false, error: String(e.message || e) }; console.error('venue sync ' + kind + ':', e.message); }
  }
  console.log('venue-sync-golf-pavilion:', JSON.stringify(out));
  return { statusCode: 200, body: JSON.stringify(out) };
};
