/* =========================================================================
   The Quarry — live Hole-In-One progressive jackpot badge (golf page).
   Pins a small gold "Live Jackpot" chip under the header, top-right. Reads the
   current jackpot from the public Supabase view (read-only) and animates a
   count-up; flashes a "+$5" pop when the number climbs. Golf page only.
   ============================================================================ */
(function () {
  "use strict";

  if (!document.getElementById("booking") && location.pathname.indexOf("golf") === -1) return;

  var SUPA = "https://nkulhtalltbieicvmmad.supabase.co";
  var KEY = "sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl";
  var ENDPOINT = SUPA + "/rest/v1/golf_progressive_current?select=jackpot,buckets_since_reset,last_reset_at";

  function fmt(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

  function styles() {
    if (document.getElementById("qjk-css")) return;
    var css =
      "@keyframes qjk-shim{0%{background-position:-200% 0}100%{background-position:200% 0}}" +
      "@keyframes qjk-glow{0%,100%{box-shadow:0 0 0 0 rgba(212,175,106,0),0 6px 18px rgba(0,0,0,0.4)}50%{box-shadow:0 0 22px 2px rgba(212,175,106,0.45),0 6px 18px rgba(0,0,0,0.4)}}" +
      "@keyframes qjk-ping{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.6);opacity:0}}" +
      "@keyframes qjk-float{0%{transform:translate(-50%,4px);opacity:0}20%{opacity:1}100%{transform:translate(-50%,-20px);opacity:0}}" +
      "#qjk{position:fixed;right:16px;z-index:150;background:#241609;border:1px solid rgba(212,175,106,0.55);" +
      "border-radius:9px;padding:0.5rem 0.95rem;text-align:center;font-family:'Montserrat',sans-serif;cursor:pointer;" +
      "text-decoration:none;display:block;animation:qjk-glow 2.8s ease-in-out infinite;}" +
      "#qjk .qjk-lbl{display:flex;align-items:center;gap:6px;justify-content:center;margin-bottom:1px;}" +
      "#qjk .qjk-dot{position:relative;width:6px;height:6px;flex-shrink:0;}" +
      "#qjk .qjk-dot i{position:absolute;inset:0;border-radius:50%;background:#e24b4a;}" +
      "#qjk .qjk-dot .p{animation:qjk-ping 1.8s ease-out infinite;}" +
      "#qjk .qjk-cap{font-size:0.46rem;letter-spacing:0.2em;text-transform:uppercase;color:#C4956A;}" +
      "#qjk .qjk-amt{display:block;font-family:'Playfair Display',Georgia,serif;font-size:1.7rem;font-weight:700;" +
      "line-height:1.05;color:#D4AF6A;background:linear-gradient(100deg,#B8933A 20%,#FFF1C4 45%,#FFE9A8 50%,#B8933A 75%);" +
      "background-size:200% auto;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;" +
      "animation:qjk-shim 2.6s linear infinite;}" +
      "#qjk .qjk-sub{font-size:0.44rem;letter-spacing:0.1em;text-transform:uppercase;color:rgba(245,240,232,0.5);margin-top:2px;}" +
      "@media(max-width:768px){#qjk{right:8px;padding:0.4rem 0.7rem;}#qjk .qjk-amt{font-size:1.25rem;}#qjk .qjk-sub{display:none;}#qjk .qjk-cap{font-size:0.42rem;}}";
    var el = document.createElement("style");
    el.id = "qjk-css";
    el.appendChild(document.createTextNode(css));
    document.head.appendChild(el);
  }

  var badge, amtEl, curVal = null;

  function build() {
    styles();
    badge = document.createElement("a");
    badge.id = "qjk";
    badge.href = "#booking";
    badge.setAttribute("aria-label", "Hole-in-one progressive jackpot — book a bay");
    badge.innerHTML =
      '<span class="qjk-lbl"><span class="qjk-dot"><i class="p"></i><i></i></span>' +
      '<span class="qjk-cap">Live Jackpot</span></span>' +
      '<span class="qjk-amt" id="qjk-amt">$1,000</span>' +
      '<span class="qjk-sub">+$5 every golf bucket</span>';
    document.body.appendChild(badge);
    amtEl = document.getElementById("qjk-amt");
    position();
    window.addEventListener("resize", position);
  }

  /* Sit just under the header, whatever its height is on this page/breakpoint. */
  function position() {
    var h = document.querySelector("header");
    var hh = h ? h.getBoundingClientRect().height : 80;
    badge.style.top = Math.round(hh + 10) + "px";
  }

  function animateTo(target) {
    var start = curVal == null ? 0 : curVal;
    if (start === target) { amtEl.textContent = fmt(target); curVal = target; return; }
    if (target > start && start !== 0) floatPop(target - start);
    var dur = 1000, t0 = performance.now();
    function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var v = start + (target - start) * (1 - Math.pow(1 - p, 3));
      amtEl.textContent = fmt(v);
      if (p < 1) requestAnimationFrame(step);
      else amtEl.textContent = fmt(target);
    }
    requestAnimationFrame(step);
    curVal = target;
  }

  function floatPop(delta) {
    var pop = document.createElement("div");
    pop.textContent = "+" + fmt(delta);
    pop.style.cssText =
      "position:absolute;left:50%;top:-4px;transform:translateX(-50%);font-family:'Montserrat',sans-serif;" +
      "font-size:0.6rem;font-weight:700;color:#FFE9A8;pointer-events:none;animation:qjk-float 1.3s ease-out forwards;";
    badge.appendChild(pop);
    setTimeout(function () { pop.remove(); }, 1300);
  }

  function load() {
    fetch(ENDPOINT, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows || !rows.length) return;
        animateTo(Math.round(Number(rows[0].jackpot) || 1000));
      })
      .catch(function () {});
  }

  function init() { build(); load(); setInterval(load, 60000); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
