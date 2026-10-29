// _golf-closed.js: server-side guard for golf bay slots the venue is closed for.
// Helper module only (leading underscore, so it's not deployed as an endpoint).
// Keep in sync with BLOCKED_DATES / LATE_OPEN_DATES / EARLY_CLOSE_DATES in quarry-golf.html.
// EARLY_CLOSE_DATES: 'YYYY-MM-DD' -> first hour (24h) that is NOT bookable that day.
const EARLY_CLOSE_DATES = {}; // none right now (Sat 10/31/2026 4 PM close cancelled Oct 29; open normal hours)

function normDate(s) {
  const raw = String(s || '').trim();
  let mt;
  if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw))) return mt[1] + '-' + mt[2].padStart(2, '0') + '-' + mt[3].padStart(2, '0');
  if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw))) return mt[3] + '-' + mt[1].padStart(2, '0') + '-' + mt[2].padStart(2, '0');
  return raw;
}
function hour24(t) {
  const mt = /(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]/.exec(String(t || ''));
  if (!mt) { const h = /^(\d{1,2}):\d{2}$/.exec(String(t || '').trim()); return h ? +h[1] : null; }
  let h = +mt[1] % 12; if (/p/i.test(mt[3])) h += 12; return h;
}
// First closed hour (24h) for an early-close date, else null. Shared with
// _pavilion-shared.js so both use the same EARLY_CLOSE_DATES list.
function earlyCloseHour(date) {
  const cut = EARLY_CLOSE_DATES[normDate(date)];
  return cut === undefined ? null : cut;
}
// Returns an error message if the slot is closed, else null.
function closedReason(date, time) {
  const d = normDate(date);
  const cut = EARLY_CLOSE_DATES[d];
  if (cut === undefined) return null;
  const h = hour24(time);
  if (h === null || h >= cut) return 'The Quarry closes at 4 PM on ' + d + ', so golf bays aren\'t available from 4 PM on that day. Please choose an earlier time or another date.';
  return null;
}
module.exports = { closedReason, EARLY_CLOSE_DATES, earlyCloseHour, hour24, normDate };
