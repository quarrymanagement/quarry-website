// ============================================================================
// _foodtruck-shared.js
//
// Shared constants for the food truck booking system. Filename starts with
// "_" so Netlify never deploys this as its own callable function -- same
// convention as _blobs.js and _pavilion-shared.js.
//
// Food trucks book Friday, Saturday, or Sunday only, up to 4 per day. Unlike
// pavilions (fixed slots, flat price), each food truck slot has its own
// staff-chosen time and price -- there's no fixed public schedule to offer,
// since every invite is staff picking one specific lead for one specific
// date/time/price (see food-truck-invite.js).
// ============================================================================

const MAX_SLOTS_PER_DAY = 4;

// day: 0=Sun, 5=Fri, 6=Sat
function isFoodTruckDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 5 || d === 6;
}

// Active bookings occupy a slot; declined/expired ones free it back up.
const ACTIVE_STATUSES = ['pending_payment', 'booked'];

function countActiveSlots(bookings) {
  return (bookings || []).filter((b) => ACTIVE_STATUSES.includes(b.status)).length;
}

module.exports = { MAX_SLOTS_PER_DAY, isFoodTruckDay, ACTIVE_STATUSES, countActiveSlots };
