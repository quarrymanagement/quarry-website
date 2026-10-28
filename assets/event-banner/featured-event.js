/* ==========================================================================
   The Quarry — featured-event loader (homepage)
   Reads /assets/event-banner/featured-event.json (or, when that file says
   "source": "supabase", the site_featured_events table), picks the first
   active event inside its start/end window, waits for the Upcoming Closures
   notice (notice.js) to settle, then hands it to event-banner.js so it stacks
   directly under the notice. Content changes live in the JSON / table only.
   ========================================================================== */
(function () {
  "use strict";
  var CONFIG_URL = "/assets/event-banner/featured-event.json";
  var SUPA = "https://nkulhtalltbieicvmmad.supabase.co";
  var KEY = "sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl"; /* publishable (same as notice.js) */
  var DB_URL = SUPA + "/rest/v1/site_featured_events?active=eq.true&order=sort_order,id&select=*";
  var STYLE = { a: "bar", b: "hero", c: "card", bar: "bar", hero: "hero", card: "card" };

  function today() {
    try { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function getJSON(url, opts) {
    return fetch(url, opts).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function fromRow(r) { /* site_featured_events row -> same shape as the JSON */
    return { id: r.slug || String(r.id), active: r.active, style: r.style, start: r.from_date, end: r.to_date,
      kicker: r.kicker, title: r.title, line: r.line, meta: r.meta, buttonText: r.button_text, buttonUrl: r.button_url,
      heroImage: r.hero_image, barImage: r.bar_image, alt: r.alt, theme: r.theme || {} };
  }
  function pick(list) {
    var now = today();
    return (list || []).filter(function (e) {
      return e && e.active !== false && e.title && !(e.start && now < e.start) && !(e.end && now > e.end);
    })[0] || null;
  }
  function toBanner(e) {
    var v = STYLE[String(e.style || "b").toLowerCase()] || "hero";
    return { variant: v, id: e.id, kicker: e.kicker, title: e.title, line: e.line,
      meta: v === "hero" ? e.meta : "", cta: e.buttonText, href: e.buttonUrl,
      image: v === "bar" ? (e.barImage || e.heroImage) : (e.heroImage || e.barImage),
      alt: e.alt, from: e.start, to: e.end, theme: e.theme || {} };
  }
  function load() {
    return getJSON(CONFIG_URL, { cache: "no-cache" }).then(function (cfg) {
      var fallback = cfg.events || [];
      if (cfg.source !== "supabase") return fallback;
      return getJSON(DB_URL, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } })
        .then(function (rows) { return (rows || []).map(fromRow); })
        .catch(function () { return fallback; });
    });
  }
  /* Notice first, then us: wait for notice.js to finish (max 3s). */
  function afterNotice(cb) {
    var hasNotice = document.querySelector('script[src="/notice.js"]');
    if (!hasNotice || window.QUARRY_NOTICE_DONE) return cb();
    var done = false, go = function () { if (!done) { done = true; cb(); } };
    document.addEventListener("quarry:notice-ready", go);
    setTimeout(go, 3000);
  }
  function start() {
    if (!window.QuarryEventBanner) return;
    load().then(function (list) {
      var e = pick(list);
      if (!e) return;
      afterNotice(function () {
        var el = window.QuarryEventBanner.fromConfig(toBanner(e));
        window.QuarryEventBanner.render(el);
      });
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
