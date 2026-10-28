/* ==========================================================================
   The Quarry — Featured Event banner (reusable template)
   --------------------------------------------------------------------------
   Two ways to use it:

   1) Markup: drop an empty element with data attributes anywhere.
        <div class="qevent" data-variant="bar|hero|card"
             data-id="christmas-spirits-2026"
             data-kicker="A Holiday Christmas Pop-Up in New Melle"
             data-title="Christmas Spirits in Whoville"
             data-line="Tickets available this Sunday, Nov 1"
             data-cta="Get Tickets"  data-href="/quarry-events.html"
             data-cta2="Learn More"  data-href2="/"          (hero only, optional)
             data-image="assets/whoville-scene.jpg"
             data-from="2026-10-28" data-to="2026-11-01"      (optional window)
             data-place="after-header"                        (bar/hero: sit under the fixed header)
             data-delay="1200"                                (card: ms before it slides in)
             style="--qe-bg:#0c3314;--qe-accent:#c8102e"></div>

   2) Config (how Dev would wire the admin-managed version): set
        window.QUARRY_FEATURED_EVENT = { variant, id, kicker, title, line, cta, href,
                                         cta2, href2, image, from, to, theme:{...css vars} }
      before this script loads, and it builds + places the banner itself.

   Any empty field is simply left out, so one layout works for any event.
   Dismissal is remembered per event id (localStorage), so a new event shows
   again even if the last one was closed.
   ========================================================================== */
(function () {
  "use strict";

  function today() {
    try { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  /* allow <b> only, same rule as notice.js */
  function rich(s) { return esc(s).replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>"); }
  function key(d) { return "qevent-dismissed:" + (d.id || d.title || "event"); }
  function isDismissed(d) { try { return localStorage.getItem(key(d)) === "1"; } catch (e) { return false; } }
  function dismiss(d) { try { localStorage.setItem(key(d), "1"); } catch (e) {} }

  function part(cls, val, tag, html) {
    if (!val) return "";
    tag = tag || "span";
    return "<" + tag + ' class="' + cls + '">' + (html ? rich(val) : esc(val)) + "</" + tag + ">";
  }
  function cta(d, n) {
    var t = n === 2 ? d.cta2 : d.cta, h = n === 2 ? d.href2 : d.href;
    if (!t) return "";
    return '<a class="' + (n === 2 ? "qe-cta2" : "qe-cta") + '" href="' + esc(h || "/") + '">' + esc(t) + "</a>";
  }
  var X = '<button class="qe-x" type="button" aria-label="Close">&#10005;</button>';

  var LAYOUT = {
    bar: function (d) {
      return '<span class="qe-lights" aria-hidden="true"></span><div class="qe-inner">' +
        (d.image ? '<img class="qe-thumb" src="' + esc(d.image) + '" alt="">' : "") +
        '<div class="qe-copy"><div class="qe-stack">' + part("qe-kicker", d.kicker) + part("qe-title", d.title, "strong") + "</div>" +
        (d.line ? '<span class="qe-sep" aria-hidden="true"></span>' + part("qe-line", d.line, "span", true) : "") +
        "</div>" + cta(d, 1) + X + "</div>";
    },
    hero: function (d) {
      return '<div class="qe-inner"><div class="qe-art" role="img" aria-label="' + esc(d.alt || d.title) + '"' +
        (d.image ? ' style="background-image:url(\'' + esc(d.image) + '\')"' : "") + "></div>" +
        '<div class="qe-copy">' + part("qe-kicker", d.kicker) + part("qe-title", d.title, "h2") +
        '<span class="qe-divider" aria-hidden="true"></span>' + part("qe-line", d.line, "p", true) + part("qe-meta", d.meta, "p") +
        '<div class="qe-ctas">' + cta(d, 1) + cta(d, 2) + "</div></div></div>" +
        '<span class="qe-lights" aria-hidden="true"></span>' + X;
    },
    card: function (d) {
      return (d.hand ? '<img class="qe-hand" src="' + esc(d.hand) + '" alt="">' : "") +
        '<div class="qe-box">' + X +
        (d.image ? '<img class="qe-img" src="' + esc(d.image) + '" alt="">' : "") +
        '<span class="qe-lights" aria-hidden="true"></span><div class="qe-body">' +
        part("qe-kicker", d.kicker) + part("qe-title", d.title, "h2") + part("qe-line", d.line, "p", true) +
        cta(d, 1) + '<button class="qe-later" type="button">Maybe later</button></div></div>';
    }
  };

  /* Same idea as notice.js place(): the homepage header is position:fixed and
     reserves nothing on desktop (and too little on mobile), so push the banner
     down by the shortfall. Sticky/static headers need nothing. */
  function place(el) {
    var header = document.querySelector("header");
    if (!header) return;
    if (getComputedStyle(header).position !== "fixed") { el.style.marginTop = "0px"; return; }
    var prev = el.previousElementSibling;
    if (prev && prev !== header) { el.style.marginTop = "0px"; return; } /* something above already made room */
    var reserved = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    el.style.marginTop = Math.max(0, Math.round(header.getBoundingClientRect().height - reserved)) + "px";
  }

  function render(el) {
    var d = el.dataset, v = d.variant || "bar", now = today();
    if (!d.title || (d.from && now < d.from) || (d.to && now > d.to) || isDismissed(d)) { el.hidden = true; return; }
    el.classList.add("qevent", "qe-" + v);
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", d.title);
    el.innerHTML = (LAYOUT[v] || LAYOUT.bar)(d);
    var close = function () { dismiss(d); el.remove(); };
    Array.prototype.forEach.call(el.querySelectorAll(".qe-x,.qe-later"), function (b) { b.addEventListener("click", close); });
    if (d.place === "after-header") {
      place(el);
      var t; window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { place(el); }, 120); });
      /* Stack with the Upcoming Closures notice (notice.js): if the notice
         appears or is dismissed after us, re-measure so neither overlaps the
         fixed header or each other. */
      var again = function () { if (el.isConnected) place(el); };
      document.addEventListener("quarry:notice-ready", again);
      document.addEventListener("quarry:notice-removed", again);
    }
    if (v === "card") setTimeout(function () { el.classList.add("qe-in"); }, parseInt(d.delay || "1200", 10));
  }

  function fromConfig(c) {
    var el = document.createElement("div");
    el.className = "qevent";
    ["variant","id","kicker","title","line","cta","href","cta2","href2","image","hand","alt","meta","from","to","delay"].forEach(function (k) {
      if (c[k] != null && c[k] !== "") el.dataset[k] = c[k];
    });
    Object.keys(c.theme || {}).forEach(function (k) { el.style.setProperty("--qe-" + k, c.theme[k]); });
    if ((c.variant || "bar") === "card") { document.body.appendChild(el); }
    else {
      el.dataset.place = "after-header";
      var header = document.querySelector("header");
      var anchor = document.getElementById("qnotice") || header; /* sit under the closures notice if it's up */
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
      else document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  function init() {
    if (window.QUARRY_FEATURED_EVENT) fromConfig(window.QUARRY_FEATURED_EVENT);
    Array.prototype.forEach.call(document.querySelectorAll(".qevent:empty"), render);
  }
  window.QuarryEventBanner = { render: render, fromConfig: fromConfig, init: init, place: place };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
