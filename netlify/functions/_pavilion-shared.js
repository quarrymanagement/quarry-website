// ============================================================================
// _pavilion-shared.js
//
// Shared availability logic for pavilion-checkout.js and quarry-pavilions.html
// (via pavilion-availability.js). Filename starts with "_" so Netlify never
// deploys this as its own callable function -- it's an import-only module,
// same convention as _blobs.js.
//
// Two rules, both checked server-side (not just in the page's own UI) so a
// direct API call can't book around them:
//   1. Wednesday-Sunday only -- matches the venue's own open days.
//   2. No wedding booked that date -- reuses venue_bookings (the same table
//      weddings sync into via the wedding_sync_booking trigger) through the
//      existing venue-availability Supabase function, rather than adding a
//      new credential just for this. A wedding fills the whole property's
//      logistics for the day, so this blocks the WHOLE date, not just
//      whichever specific space the wedding claims.
// ============================================================================

const { readBlob } = require('./_blobs');

const VENUE_AVAILABILITY_KEY = process.env.VENUE_AVAILABILITY_KEY || '';
const SUPABASE_FN_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/venue-availability';

async function hasWeddingOn(date) {
  if (!VENUE_AVAILABILITY_KEY) return false; // fail open on missing config rather than blocking every date
  try {
    const r = await fetch(`${SUPABASE_FN_URL}?start=${encodeURIComponent(date)}&days=1`, {
      headers: { 'x-access-key': VENUE_AVAILABILITY_KEY },
    });
    if (!r.ok) return false;
    const body = await r.json();
    return (body.bookings || []).some((b) =>
      b.status !== 'cancelled' && (b.event_type === 'wedding' || b.source === 'wedding portal')
    );
  } catch (_) {
    return false; // a lookup failure shouldn't hard-block every booking attempt
  }
}

// day: 0=Sun ... 6=Sat. Open Wed(3) through Sun(0).
function isOpenDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  return d === 0 || d === 3 || d === 4 || d === 5 || d === 6;
}

// Two fixed slots per open day -- 11 AM-4 PM (5 hours) and 5 PM until
// whatever time the venue closes that night. Every open day closes at 6 PM
// or later (see CLOSE_HOUR), so the 5 PM slot always has at least an hour of
// room, even on Sunday's early close. Shared by pavilion-availability.js (to
// list them) and pavilion-checkout.js (to reject a request for a time that
// was never actually offered).
const CLOSE_HOUR = { 0: 18, 3: 21, 4: 21, 5: 23, 6: 23 };
const SLOT_TIMES = ['11:00 AM', '5:00 PM'];

function slotsForDate(dateStr) {
  const day = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  if (CLOSE_HOUR[day] == null) return [];
  return SLOT_TIMES;
}

// Display label for how a slot ends -- the 11 AM slot has a fixed end time,
// the 5 PM slot just runs until close (which varies by day of week), so
// there's no single clock time to show for it here.
function slotEndLabel(time) {
  return time === '11:00 AM' ? '4:00 PM' : 'Close';
}

async function isDateBookable(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'Invalid date.' };
  if (!isOpenDay(date)) return { ok: false, reason: 'The Quarry is closed Mondays and Tuesdays.' };
  if (await hasWeddingOn(date)) return { ok: false, reason: 'That date is unavailable -- a private wedding is booked.' };
  return { ok: true };
}

// The two slots (11 AM-4 PM and 5 PM-close) never overlap each other, so
// unlike the old rolling-hourly-start version of this file, a conflict is
// just the same pavilion already booked for the exact same slot that date --
// no start/end overlap math needed.
function conflictsWithExisting(bookings, pavilion, time) {
  return bookings.some((b) => String(b.pavilion) === String(pavilion) && b.time === time);
}

async function isSlotTaken(date, pavilion, time) {
  try {
    const data = await readBlob('pavilion-bookings/' + date);
    return conflictsWithExisting((data && data.bookings) || [], pavilion, time);
  } catch (_) {
    return false;
  }
}

module.exports = { isDateBookable, isSlotTaken, isOpenDay, hasWeddingOn, slotsForDate, slotEndLabel, conflictsWithExisting };
