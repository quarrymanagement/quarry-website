/* Ticket on-sale gate + member early-access code (Christmas Spirits in Whoville, 10/30).
 * Driven by event fields only, so go-live needs no redeploy: tickets unlock on the clock.
 *   earlyAccessAt  ISO time members with the code may book (e.g. "2026-10-31T10:00:00-05:00")
 *   onSaleAt       ISO time everyone may book            (e.g. "2026-11-01T10:00:00-06:00")
 *   memberCode     { hash, salt, pct, label, earlyAccess, extension }
 *                  hash = SHA-256 hex of salt + code.trim().toLowerCase(). The code itself is never in this
 *                  file or in events.json. The server (event-register.js) checks the same hash and the same
 *                  times, so this script only decides what the page shows.
 * Events without these fields are untouched (phase "none"). */
(function () {
  'use strict';
  var KEY = 'quarryMemberCode';
  function previewHost() { var h = location.hostname; return h === 'localhost' || h === '127.0.0.1' || h.indexOf('--') > 0; }
  /** Current time. Preview/localhost only: ?gateNow=2026-10-31T10:00:00-05:00 shows the page as of that moment. */
  function now() {
    try {
      var o = new URLSearchParams(location.search).get('gateNow');
      if (o && previewHost()) { var t = Date.parse(o); if (!isNaN(t)) return t + (Date.now() - LOADED); }
    } catch (e) {}
    return Date.now();
  }
  var LOADED = Date.now();
  function ts(v) { var t = v ? Date.parse(v) : NaN; return isNaN(t) ? null : t; }
  function hasCode(mc) { return !!(mc && (mc.hash || mc.codeEnv)); }
  function gated(ev) { return !!(ev && (ts(ev.onSaleAt) || hasCode(ev.memberCode))); }
  /** "none" | "soon" (nobody can book) | "early" (code holders only) | "open" */
  function phase(ev, t) {
    if (!gated(ev)) return 'none';
    t = t == null ? now() : t;
    var on = ts(ev.onSaleAt), early = ts(ev.earlyAccessAt);
    if (!on || t >= on) return 'open';
    if (early && t >= early && ev.memberCode && ev.memberCode.earlyAccess) return 'early';
    return 'soon';
  }
  function fmtAt(iso) {
    var t = ts(iso); if (t == null) return '';
    try {
      var d = new Date(t);
      var day = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
      var tm = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
      return day + ' at ' + tm + ' CT';
    } catch (e) { return new Date(t).toString(); }
  }
  function parts(ms) {
    ms = Math.max(0, ms); var s = Math.floor(ms / 1000);
    return { d: Math.floor(s / 86400), h: Math.floor(s % 86400 / 3600), m: Math.floor(s % 3600 / 60), s: s % 60 };
  }
  function clockHtml(ms) {
    var p = parts(ms), z = function (n) { return (n < 10 ? '0' : '') + n; };
    var cell = function (n, l) { return '<span class="qg-cell"><b>' + n + '</b><i>' + l + '</i></span>'; };
    return cell(p.d, p.d === 1 ? 'Day' : 'Days') + cell(z(p.h), 'Hours') + cell(z(p.m), 'Minutes') + cell(z(p.s), 'Seconds');
  }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function norm(code) { return String(code || '').trim().toLowerCase(); }
  /** Resolves true when the code matches the event's hash. Case and spaces don't matter. */
  function check(ev, code) {
    var mc = ev && ev.memberCode;
    if (!mc || !norm(code)) return Promise.resolve(false);
    if (!mc.hash && mc.codeEnv) {   // code kept in a server env var: ask the site (event-register re-checks on booking)
      return fetch(window.QG_CODE_URL || '/.netlify/functions/member-code-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codeEnv: mc.codeEnv, code: norm(code) }) })
        .then(function (r) { return r.ok ? r.json() : {}; }).then(function (j) { return !!(j && j.ok); }, function () { return false; });
    }
    if (!mc.hash || !(window.crypto && crypto.subtle)) return Promise.resolve(false);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode((mc.salt || '') + norm(code)))
      .then(function (b) { return hex(b) === String(mc.hash).toLowerCase(); }, function () { return false; });
  }
  function saved() { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function save(code) { try { code ? sessionStorage.setItem(KEY, norm(code)) : sessionStorage.removeItem(KEY); } catch (e) {} }
  /** Same rounding as the server: each ticket and each extra-2-hours block is discounted on its own. */
  function discount(ev, qty, ext) {
    var mc = (ev && ev.memberCode) || {}, pct = parseFloat(mc.pct) || 0; qty = parseInt(qty, 10) || 0;
    var base = (ev.tiers && ev.tiers[0] && ev.tiers[0].pricePerPerson) || ev.pricePerPerson || ev.price || 0;
    var extBase = Math.round(base * (1 - (parseFloat(ev.arrivalExtendPct) || 0) / 100));
    var off = function (c) { return c - Math.round(c * (1 - pct / 100)); };
    var cents = qty * off(base) + (ext && mc.extension !== false ? qty * off(extBase) : 0);
    return { pct: pct, cents: cents, label: (mc.label || 'Member') + ' ' + pct + '% off' };
  }
  /** Extra-2-hours offer text when a member code is applied, e.g. " Wine club price: $20.25." */
  function extNote(ev) {
    var g = window.__gate, mc = (ev && ev.memberCode) || {};
    if (!g || !g.applied || mc.extension === false) return '';
    var base = (ev.tiers && ev.tiers[0] && ev.tiers[0].pricePerPerson) || ev.pricePerPerson || ev.price || 0;
    var extBase = Math.round(base * (1 - (parseFloat(ev.arrivalExtendPct) || 0) / 100));
    var c = Math.round(extBase * (1 - (parseFloat(mc.pct) || 0) / 100));
    return ' ' + (mc.label || 'Member') + ' price: $' + (c / 100).toFixed(2) + '.';
  }
  function addDiscountLine(ev, qty, ext, detailsEl, totalEl) {
    if (!detailsEl || !totalEl) return 0;
    var d = discount(ev, qty, ext); if (!d.cents) return 0;
    var line = document.createElement('div'); line.className = 'summary-line'; line.setAttribute('data-member', '1');
    line.style.cssText = 'display:flex;justify-content:space-between;color:#3c9b2c;font-weight:600;';
    var a = document.createElement('span'); a.textContent = d.label + (ext && (ev.memberCode || {}).extension !== false ? ' (tickets + extra 2 hours)' : '');
    var b = document.createElement('span'); b.textContent = '\u2212$' + (d.cents / 100).toFixed(2);
    line.appendChild(a); line.appendChild(b); detailsEl.appendChild(line);
    var cur = parseFloat(String(totalEl.textContent).replace(/[^0-9.]/g, '')) || 0;
    totalEl.textContent = '$' + Math.max(0, cur - d.cents / 100).toFixed(2);
    return d.cents;
  }
  var CSS = '@font-face{font-family:"QG Whimsy";font-weight:700;src:url("/assets/event-banner/fonts/MountainsofChristmas-Bold.woff2") format("woff2");font-display:swap}'
    + '.qg{position:relative;overflow:hidden;background:radial-gradient(120% 90% at 50% 0%,#1d5a22 0%,#0b2f12 60%,#072109 100%);color:#fff7e6;border:3px solid #9be23f;border-radius:18px;padding:16px 12px 14px;margin:0 0 16px;text-align:center;font-family:inherit;box-shadow:0 0 0 4px #c8102e,0 10px 26px rgba(0,0,0,.35);max-width:100%;box-sizing:border-box}'
    + '.qg:before{content:"";position:absolute;left:0;right:0;top:0;height:8px;background:repeating-linear-gradient(-45deg,#c8102e 0 10px,#fff7e6 10px 20px);opacity:.9}'
    + '.qg h4{margin:0 0 4px;font-size:17px;line-height:1.25;color:#9be23f;letter-spacing:.02em;text-transform:none}'
    + '.qg-title{font-family:"QG Whimsy","Mountains of Christmas",cursive;font-weight:700;font-size:clamp(26px,7.4vw,36px);line-height:1.02;color:#9be23f;text-shadow:2px 2px 0 #c8102e,4px 4px 0 rgba(0,0,0,.35);margin:8px 0 10px;transform:rotate(-1.5deg)}'
    + '.qg p{margin:4px 0;font-size:14px;line-height:1.4;color:#fff7e6}.qg .qg-when{font-weight:600;letter-spacing:.02em;margin-top:8px}.qg .qg-sub{font-size:13px;opacity:.9}'
    + '.qg-clock{display:flex;justify-content:center;gap:clamp(5px,1.8vw,10px);margin:8px auto 4px;max-width:380px}'
    + '.qg-cell{flex:1 1 0;min-width:0;max-width:86px;display:flex;flex-direction:column;align-items:center;background:linear-gradient(180deg,#e0263f 0%,#a70d24 100%);border:3px solid #9be23f;border-radius:14px 14px 10px 10px;padding:6px 2px 5px;box-shadow:0 4px 0 #5f0614,0 6px 12px rgba(0,0,0,.35);transform:rotate(-2deg)}'
    + '.qg-cell:nth-child(even){transform:rotate(2deg) translateY(2px)}'
    + '.qg-cell b{font-family:"QG Whimsy","Mountains of Christmas",cursive;font-weight:700;font-size:clamp(30px,9vw,42px);line-height:1;color:#fff;text-shadow:2px 2px 0 rgba(0,0,0,.35);font-variant-numeric:tabular-nums}'
    + '.qg-cell i{font-style:normal;font-weight:700;font-size:clamp(9px,2.5vw,11px);letter-spacing:.08em;text-transform:uppercase;color:#d9ffb0;margin-top:2px}'
    + '.qg-cta{display:block;margin:12px auto 4px;padding:12px 14px;border-radius:999px;background:#9be23f;color:#0b2f12!important;font-weight:800;font-size:15px;line-height:1.25;text-decoration:none!important;box-shadow:0 4px 0 #5b8f1f;max-width:340px}'
    + '.qg-code{display:flex;gap:8px;margin-top:10px}.qg-code input{flex:1;min-width:0;padding:10px;border-radius:8px;border:2px solid #9be23f;font-size:16px;text-transform:uppercase;background:#fff;color:#111}'
    + '.qg-code button{padding:10px 14px;border:0;border-radius:8px;background:#c8102e;color:#fff;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}'
    + '.qg-msg{font-size:13px;margin-top:6px;min-height:1em}.qg-ok{color:#9be23f}.qg-bad{color:#ff8a8a}'
    + '.qg-lbl{display:block;font-size:13px;margin-top:10px;color:#fff7e6;text-transform:none;letter-spacing:normal}';
  function injectCss() { if (document.getElementById('qg-css')) return; var s = document.createElement('style'); s.id = 'qg-css'; s.textContent = CSS; document.head.appendChild(s); }

  /**
   * Renders the on-sale panel into `el` and keeps it current every second.
   * opts.onChange(ctrl) fires when the lock state or code changes.
   * ctrl: { phase, locked, applied, code, destroy() }
   */
  function mount(ev, el, opts) {
    opts = opts || {};
    var ctrl = { phase: phase(ev), locked: false, applied: false, code: '', destroy: function () { clearInterval(timer); } };
    if (!el) return ctrl;
    if (!gated(ev)) { el.style.display = 'none'; el.innerHTML = ''; el.classList.remove('qg'); return ctrl; }
    injectCss(); el.classList.add('qg'); el.style.display = 'block';
    var mc = ev.memberCode || {}, label = mc.label || 'Member', pct = parseFloat(mc.pct) || 0, lastKey = '', timer = null;
    function lockState() { var p = phase(ev); return p === 'soon' || (p === 'early' && !ctrl.applied); }
    function draw() {
      var p = phase(ev), t = now(), html = '';
      ctrl.phase = p;
      if (p === 'soon') {
        html += '<div class="qg-title">Countdown to Whoville tickets</div>';
        html += '<div class="qg-clock" data-qg-clock="onSaleAt">' + clockHtml(ts(ev.onSaleAt) - t) + '</div>';
        html += '<p class="qg-when">Tickets go on sale ' + fmtAt(ev.onSaleAt) + '</p>';
        if (mc.earlyAccess && ts(ev.earlyAccessAt)) html += '<p>' + label + ' members: early booking opens ' + fmtAt(ev.earlyAccessAt) + '.</p>';
      } else if (p === 'early') {
        html += '<div class="qg-title">Countdown to Whoville tickets</div>';
        html += '<div class="qg-clock" data-qg-clock="onSaleAt">' + clockHtml(ts(ev.onSaleAt) - t) + '</div>';
        html += '<p class="qg-when">Public tickets go on sale ' + fmtAt(ev.onSaleAt) + '</p>';
        html += ctrl.applied ? '' : '<a href="#qgCode" class="qg-cta" data-qg-cta>' + label + ' members: book now with your code</a>'
          + '<p class="qg-sub">' + label + ' early booking is open' + (pct ? ' \u2014 and you save ' + pct + '%' : '') + '.</p>';
      } else {
        html += '<h4 style="font-size:15px">' + label + ' member?</h4>';
      }
      if (hasCode(mc)) {
        if (ctrl.applied) {
          html += '<p class="qg-ok">\u2713 ' + label + ' code applied' + (pct ? ' \u2014 ' + pct + '% off' : '') + (p === 'soon' ? '. You can book as soon as early booking opens.' : '') + ' <a href="#" data-qg-remove style="color:#ff8a8a;font-size:12px;margin-left:6px">Remove</a></p>';
        } else {
          html += '<label class="qg-lbl" for="qgCode">' + label + ' code' + (pct ? ' (' + pct + '% off)' : '') + '</label>';
          html += '<div class="qg-code"><input id="qgCode" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Enter code"><button type="button" data-qg-apply>Apply</button></div>';
        }
        html += '<div class="qg-msg" data-qg-msg></div>';
      }
      el.innerHTML = html;
      var ap = el.querySelector('[data-qg-apply]'), inp = el.querySelector('#qgCode'), rm = el.querySelector('[data-qg-remove]');
      if (ap) ap.onclick = function () { apply(inp.value); };
      if (inp) inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); apply(inp.value); } };
      var cta = el.querySelector('[data-qg-cta]');
      if (cta) cta.onclick = function (e) { e.preventDefault(); focusCode(); };
      if (rm) rm.onclick = function (e) { e.preventDefault(); ctrl.applied = false; ctrl.code = ''; save(''); refresh(true); };
    }
    function focusCode() { var i = el.querySelector('#qgCode'); if (i) { i.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { try { i.focus({ preventScroll: true }); } catch (e) { i.focus(); } }, 350); } }
    ctrl.focusCode = focusCode;
    function msg(text, ok) { var m = el.querySelector('[data-qg-msg]'); if (m) { m.textContent = text; m.className = 'qg-msg ' + (ok ? 'qg-ok' : 'qg-bad'); } }
    function apply(code) {
      if (!norm(code)) { msg('Please enter your code.', false); return; }
      check(ev, code).then(function (ok) {
        if (!ok) { msg('That code isn\u2019t valid. Check the spelling and try again.', false); return; }
        ctrl.applied = true; ctrl.code = norm(code); save(code); refresh(true);
      });
    }
    function refresh(force) {
      var p = phase(ev), key = p + '|' + ctrl.applied;
      ctrl.locked = lockState();
      if (force || key !== lastKey) { lastKey = key; draw(); if (opts.onChange) opts.onChange(ctrl); return; }
      var c = el.querySelector('[data-qg-clock]'); if (c) c.innerHTML = clockHtml(ts(ev.onSaleAt) - now());
    }
    refresh(true);
    timer = setInterval(function () { refresh(false); }, 1000);
    var s = saved();
    if (s && hasCode(mc)) check(ev, s).then(function (ok) { if (ok) { ctrl.applied = true; ctrl.code = s; refresh(true); } else save(''); });
    return ctrl;
  }
  window.QuarryGate = { now: now, phase: phase, gated: gated, fmtAt: fmtAt, clockHtml: clockHtml, check: check, saved: saved, save: save, discount: discount, addDiscountLine: addDiscountLine, extNote: extNote, mount: mount, injectCss: injectCss };
})();
