// ============================================================================
// _event-bundles.js  (added 2026-10-26)
//
// Limited-time ticket BUNDLES, e.g. "Bring a Friend: 2 tickets for $60".
// A bundle is N tickets sold at one fixed price. It is priced and expired
// HERE on the server; the browser only displays what get-event-public returns,
// and event-register re-checks everything, so a tampered page cannot change
// the price or use a deal after it ends.
//
// Where bundles come from (first match wins):
//   1. evData.bundles in events.json (data-driven, for future events), or
//   2. CODE_BUNDLES below, keyed by event id (used for Halloween 2026 so no
//      events.json / data change is needed).
//
// Bundle shape:
//   { id, name, qty, price (cents, for the whole bundle), expiresAt (ISO with
//     offset), label?, note?, perks? (short text for the order summary), maxPerOrder? }
// ============================================================================

// >>> THE ONE VALUE TO CHANGE: Halloween "Bring a Friend" bundle price, in cents. <<<
const HALLOWEEN_2026_BUNDLE_PRICE_CENTS = 6000; // $60 for 2 tickets

const CODE_BUNDLES = {
  // Halloween Day of the Dead, Fri Oct 30 2026. Regular ticket stays $40
  // (events.json tiers). Deal ends end of day Wed Oct 28, America/Chicago (CDT).
  'event_1788301739552': [
    {
      id: 'bring-a-friend-2',
      name: 'Bring a Friend 2-Pack',
      qty: 2,
      price: HALLOWEEN_2026_BUNDLE_PRICE_CENTS,
      expiresAt: '2026-10-28T23:59:59-05:00',
      note: 'Each ticket includes 2 drinks. Through Wed, Oct 28.',
      perks: '2 drinks per ticket',
      maxPerOrder: 10
    }
  ]
};

function rawBundles(evData) {
  if (!evData) return [];
  if (Array.isArray(evData.bundles) && evData.bundles.length) return evData.bundles;
  return CODE_BUNDLES[evData.id] || [];
}

function isActive(b, nowMs) {
  if (!b || !b.id) return false;
  const qty = parseInt(b.qty, 10) || 0;
  const price = parseInt(b.price, 10) || 0;
  if (qty < 2 || price <= 0) return false;
  if (b.startsAt && Date.parse(b.startsAt) > nowMs) return false;
  const exp = Date.parse(b.expiresAt || '');
  if (!isFinite(exp)) return false; // a bundle without a valid end date is never sold
  return nowMs <= exp;
}

// Public, display-safe list of bundles that are on sale right now.
function activeBundles(evData, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return rawBundles(evData).filter(function (b) { return isActive(b, now); }).map(function (b) {
    return {
      id: String(b.id),
      name: String(b.name || 'Bundle'),
      qty: parseInt(b.qty, 10),
      price: parseInt(b.price, 10),
      expiresAt: String(b.expiresAt),
      label: b.label ? String(b.label) : '',
      note: b.note ? String(b.note) : '',
      perks: b.perks ? String(b.perks) : '',
      maxPerOrder: parseInt(b.maxPerOrder, 10) || 10
    };
  });
}

function findActiveBundle(evData, bundleId, nowMs) {
  const want = String(bundleId || '').trim().toLowerCase();
  if (!want) return null;
  return activeBundles(evData, nowMs).find(function (b) { return b.id.toLowerCase() === want; }) || null;
}

module.exports = { activeBundles, findActiveBundle, CODE_BUNDLES, HALLOWEEN_2026_BUNDLE_PRICE_CENTS };
