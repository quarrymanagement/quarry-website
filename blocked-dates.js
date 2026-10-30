/* ============================================================================
 * blocked-dates.js: ONE list of whole-day blocked dates for every public
 * reservation / booking-request form on thequarrystl.com.
 *
 * Shared by the browser (<script src="/blocked-dates.js"></script>, exposes
 * window.QuarryBlockedDates) and by the Netlify functions
 * (netlify/functions/_blocked-dates.js re-exports this file), so a date that
 * can't be picked on a form is also rejected by the server.
 *
 * To UNBLOCK a date: delete its line below. Nothing else needs to change.
 * Added 2026-10-30 (Matt: "can we block off dates for reservations people
 * submitting them on website for these dates?").
 * ========================================================================== */
(function (root) {
  'use strict';

  // Christmas Spirits in Whoville nights: whole day blocked.
  var WHOVILLE_BLOCK_DATES = [
    '2026-12-04', // Fri
    '2026-12-05', // Sat
    '2026-12-11', // Fri
    '2026-12-12', // Sat. PENDING Matt keep-or-drop: delete this line to unblock 12/12
    '2026-12-18', // Fri
    '2026-12-19', // Sat
  ];

  var EVENTS_PATH = '/quarry-events.html';
  var EVENTS_URL = 'https://thequarrystl.com' + EVENTS_PATH;
  var CONTACT_EMAIL = 'management@thequarrystl.com';
  // Matt 2026-10-30 9:05 AM CT: "if someone tries to select that date, have the
  // email us for request. So it doesn't push it away." Date stays unbookable
  // online; the note invites an email request instead of turning them away.
  var MESSAGE = 'This date is reserved for Christmas Spirits in Whoville. Want to come in? ' +
    'Email us at ' + CONTACT_EMAIL + " and we'll see what we can do. See our events page.";
  var MESSAGE_WITH_URL = MESSAGE.replace(/\.$/, ': ') + EVENTS_URL;

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  // '2026-12-04' -> 'Friday, December 4, 2026' (no timezone math).
  function prettyDate(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normDate(date));
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    var dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    return DAYS[dow] + ', ' + MONTHS[mo - 1] + ' ' + d + ', ' + y;
  }
  // mailto: link with a "Request for <date>" subject.
  function mailtoHref(date) {
    var pretty = prettyDate(date);
    var subject = pretty ? 'Request for ' + pretty : 'Request for a Christmas Spirits in Whoville date';
    var body = pretty ? 'Hi! I\u2019d like to come in on ' + pretty + '. Party size / time / details: ' : '';
    return 'mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent(subject) +
      (body ? '&body=' + encodeURIComponent(body) : '');
  }
  var LINK_STYLE = 'color:inherit;text-decoration:underline;font-weight:600';
  // Note HTML for a date (mailto subject names the date); NOTE_HTML is the generic one.
  function noteHtml(date) {
    return 'This date is reserved for Christmas Spirits in Whoville. Want to come in? ' +
      'Email us at <a class="qbd-mail" href="' + mailtoHref(date) + '" style="' + LINK_STYLE + '">' + CONTACT_EMAIL + '</a>' +
      " and we'll see what we can do. See our " +
      '<a class="qbd-events" href="' + EVENTS_PATH + '" style="' + LINK_STYLE + '">events page</a>.';
  }
  var NOTE_HTML = noteHtml('');

  // Accepts 'YYYY-MM-DD', 'YYYY-M-D', 'M/D/YYYY' or an ISO timestamp.
  function normDate(s) {
    var raw = String(s == null ? '' : s).trim();
    var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw))) return m[3] + '-' + pad(m[1]) + '-' + pad(m[2]);
    return raw;
  }
  function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  function isBlocked(date) { return !!date && WHOVILLE_BLOCK_DATES.indexOf(normDate(date)) !== -1; }
  // Guest-facing reason (plain text, with the events URL) or null.
  function blockedReason(date) { return isBlocked(date) ? MESSAGE_WITH_URL : null; }

  // Browser helper: wire a <input type="date"> so a blocked date shows the
  // note (with the events link), is marked invalid, and can't be submitted.
  //   QuarryBlockedDates.attach(inputEl, { noteBefore: el, onChange: fn })
  function attach(input, opts) {
    if (!input || input.__qbdAttached) return;
    input.__qbdAttached = true;
    opts = opts || {};
    var doc = input.ownerDocument;
    var note = doc.createElement('div');
    note.className = 'qbd-note';
    note.setAttribute('role', 'alert');
    note.style.cssText = 'display:none;background:#3a2a12;border-left:3px solid #B8933A;color:#f0e6d2;' +
      'padding:0.6rem 0.9rem;margin-top:0.45rem;font-size:0.82rem;line-height:1.45;border-radius:3px;';
    note.innerHTML = NOTE_HTML;
    var anchor = opts.noteAfter || input;
    anchor.parentNode.insertBefore(note, anchor.nextSibling);

    function check() {
      var bad = isBlocked(input.value);
      if (bad) note.innerHTML = noteHtml(input.value);
      note.style.display = bad ? 'block' : 'none';
      try { input.setCustomValidity(bad ? MESSAGE : ''); } catch (_) {}
      if (opts.onChange) opts.onChange(bad);
      return bad;
    }
    input.addEventListener('change', check);
    input.addEventListener('input', check);
    var form = input.form;
    if (form) {
      // Capture phase so this runs before any other submit handler.
      form.addEventListener('submit', function (e) {
        if (check()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          try { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
        }
      }, true);
    }
    check();
    return { check: check, note: note };
  }

  var api = {
    WHOVILLE_BLOCK_DATES: WHOVILLE_BLOCK_DATES,
    MESSAGE: MESSAGE,
    MESSAGE_WITH_URL: MESSAGE_WITH_URL,
    NOTE_HTML: NOTE_HTML,
    EVENTS_PATH: EVENTS_PATH,
    EVENTS_URL: EVENTS_URL,
    CONTACT_EMAIL: CONTACT_EMAIL,
    prettyDate: prettyDate,
    mailtoHref: mailtoHref,
    noteHtml: noteHtml,
    normDate: normDate,
    isBlocked: isBlocked,
    blockedReason: blockedReason,
    attach: attach,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QuarryBlockedDates = api;
})(typeof window !== 'undefined' ? window : this);
