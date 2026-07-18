/* ==========================================================================
   The Quarry — site notice banner
   --------------------------------------------------------------------------
   TO ADD OR CHANGE A NOTICE, EDIT THE LIST BELOW. NOTHING ELSE IN THIS FILE.

   Each notice looks like this:

     { day: "Sat July 18", text: "Opening at 12 PM.", from: "2026-07-15", to: "2026-07-18" }

     day   Short label on the left. Keep it short — "Sat July 18", "This Week".
     text  The message. Wrap anything you want in gold with <b>...</b>.
     from  First day it appears.   Format is YYYY-MM-DD.
     to    Last day it appears.    It disappears by itself after this day.

   Dates are read in New Melle time. A notice with to: "2026-07-19" is gone on
   its own first thing Monday the 20th — no need to come back and remove it.

   Set TITLE to whatever fits the notices below ("Hours Update",
   "Upcoming Events", "Holiday Hours"). Leave the list empty — NOTICES = []
   — and no banner shows at all.
   ========================================================================== */

var TITLE = "Hours Update";

var NOTICES = [
  {
    day:  "Sat July 18",
    text: "Opening at <b>12 PM</b> due to a private party.",
    from: "2026-07-15",
    to:   "2026-07-18"
  },
  {
    day:  "Sun July 19",
    text: "Opening at <b>11 AM</b> — no brunch service while we change over our menu.",
    from: "2026-07-15",
    to:   "2026-07-19"
  }
];

/* ==========================================================================
   Nothing below here needs editing.
   ========================================================================== */

(function () {
  "use strict";

  var STORE_KEY = "quarry-notice-dismissed";

  /* Today's date in New Melle, as YYYY-MM-DD, so notices turn over at local
     midnight no matter where the visitor is. */
  function today() {
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function active() {
    var now = today();
    return (NOTICES || []).filter(function (n) {
      if (!n || !n.text) return false;
      if (n.from && now < n.from) return false;
      if (n.to && now > n.to) return false;
      return true;
    });
  }

  function dismissedToday() {
    try {
      return window.localStorage.getItem(STORE_KEY) === today();
    } catch (e) {
      return false;
    }
  }

  function rememberDismiss() {
    try {
      window.localStorage.setItem(STORE_KEY, today());
    } catch (e) {}
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Allows <b> in notice text, escapes everything else. */
  function body(s) {
    return esc(s).replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
  }

  function styles() {
    if (document.getElementById("qnotice-css")) return;
    var css =
      '#qnotice{background:#1A1A1A;padding:0.85rem 2rem 0.95rem;}' +
      '#qnotice .qn-card{max-width:1400px;margin:0 auto;background:#2C1A0E;' +
      'border:1px solid rgba(188,149,106,0.5);padding:0.75rem 1.1rem;' +
      "font-family:'Montserrat',sans-serif;}" +
      '#qnotice .qn-head{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;}' +
      "#qnotice .qn-title{font-family:'Playfair Display',serif;font-size:0.62rem;" +
      'letter-spacing:0.2em;text-transform:uppercase;color:#D4AF6A;font-weight:600;}' +
      '#qnotice .qn-dot{width:5px;height:5px;border-radius:50%;background:#B8933A;flex-shrink:0;}' +
      '#qnotice .qn-x{margin-left:auto;background:none;border:0;cursor:pointer;padding:2px 4px;' +
      'color:rgba(245,240,232,0.45);font-size:0.9rem;line-height:1;transition:color 0.2s;}' +
      '#qnotice .qn-x:hover{color:#D4AF6A;}' +
      '#qnotice .qn-row{display:flex;gap:1rem;padding:0.42rem 0;' +
      'border-bottom:1px solid rgba(188,149,106,0.25);}' +
      '#qnotice .qn-row:first-of-type{padding-top:0;}' +
      '#qnotice .qn-row:last-child{border-bottom:0;padding-bottom:0;}' +
      '#qnotice .qn-day{font-size:0.55rem;font-weight:500;letter-spacing:0.12em;' +
      'text-transform:uppercase;color:#C4956A;min-width:96px;flex-shrink:0;padding-top:0.15rem;}' +
      '#qnotice .qn-text{font-size:0.74rem;font-weight:300;color:#F5F0E8;line-height:1.55;}' +
      '#qnotice .qn-text b{font-weight:500;color:#D4AF6A;}' +
      '@media(max-width:768px){' +
      '#qnotice{padding:0.7rem 1rem 0.8rem;}' +
      '#qnotice .qn-card{padding:0.7rem 0.85rem;}' +
      '#qnotice .qn-row{flex-direction:column;gap:0.15rem;}' +
      '#qnotice .qn-day{min-width:0;padding-top:0;}' +
      '#qnotice .qn-text{font-size:0.72rem;}}';
    var el = document.createElement("style");
    el.id = "qnotice-css";
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
  }

  function build(list) {
    var rows = list
      .map(function (n) {
        var day = n.day ? '<span class="qn-day">' + esc(n.day) + "</span>" : "";
        return '<div class="qn-row">' + day + '<span class="qn-text">' + body(n.text) + "</span></div>";
      })
      .join("");

    var wrap = document.createElement("div");
    wrap.id = "qnotice";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Site notices");
    wrap.innerHTML =
      '<div class="qn-card"><div class="qn-head"><span class="qn-dot"></span>' +
      '<span class="qn-title">' + esc(TITLE) + "</span>" +
      '<button class="qn-x" type="button" aria-label="Dismiss notice">&#10005;</button>' +
      "</div>" + rows + "</div>";
    return wrap;
  }

  /* The banner sits in normal flow so it scrolls away with the page.
     The catch: these pages do not agree on how the header is positioned.
       index.html      header is fixed, nothing reserves space for it
       quarry-menu     header is sticky on desktop (still takes up flow space)
       under 768px     header is fixed and body reserves 64px — but the header
                       actually renders ~81px tall, so 17px would be covered
     So: measure the header, subtract whatever the page already reserves, and
     make up only the shortfall. Sticky and static headers need nothing. */
  function place(banner, header) {
    var fixed = window.getComputedStyle(header).position === "fixed";
    if (!fixed) {
      banner.style.marginTop = "0px";
      return;
    }
    var reserved = parseFloat(banner.dataset.basePad || "0");
    var shortfall = header.getBoundingClientRect().height - reserved;
    banner.style.marginTop = Math.max(0, Math.round(shortfall)) + "px";
  }

  function init() {
    var list = active();
    if (!list.length || dismissedToday()) return;

    var header = document.querySelector("header");
    if (!header || !header.parentNode) return;

    styles();
    var banner = build(list);
    banner.dataset.basePad = String(
      parseFloat(window.getComputedStyle(document.body).paddingTop) || 0
    );

    header.parentNode.insertBefore(banner, header.nextSibling);
    place(banner, header);

    banner.querySelector(".qn-x").addEventListener("click", function () {
      rememberDismiss();
      banner.remove();
    });

    /* Header height and position both change at the 768px breakpoint. */
    var t;
    window.addEventListener("resize", function () {
      clearTimeout(t);
      t = setTimeout(function () {
        place(banner, header);
      }, 120);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
