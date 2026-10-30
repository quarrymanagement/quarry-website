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
  function gated(ev) { return !!(ev && (ts(ev.onSaleAt) || (ev.memberCode && ev.memberCode.hash))); }
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
    return cell(p.d, p.d === 1 ? 'day' : 'days') + cell(z(p.h), 'hrs') + cell(z(p.m), 'min') + cell(z(p.s), 'sec');
  }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function norm(code) { return String(code || '').trim().toLowerCase(); }
  /** Resolves true when the code matches the event's hash. Case and spaces don't matter. */
  function check(ev, code) {
    var mc = ev && ev.memberCode;
    if (!mc || !mc.hash || !norm(code) || !(window.crypto && crypto.subtle)) return Promise.resolve(false);
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
  var CSS = '.qg{background:#0c3314;color:#fff7e6;border:2px solid #9be23f;border-radius:12px;padding:14px 14px 12px;margin:0 0 16px;text-align:center;font-family:inherit;box-shadow:0 0 0 3px #c8102e inset}'
    + '.qg h4{margin:0 0 4px;font-size:17px;line-height:1.25;color:#9be23f;letter-spacing:.02em;text-transform:none}'
    + '.qg p{margin:4px 0;font-size:14px;line-height:1.4;color:#fff7e6}'
    + '.qg-clock{display:flex;justify-content:center;gap:8px;margin:10px 0 6px}'
    + '.qg-cell{display:flex;flex-direction:column;align-items:center;min-width:56px;background:rgba(255,255,255,.08);border-radius:8px;padding:6px 4px}'
    + '.qg-cell b{font-size:24px;line-height:1.1;color:#fff}.qg-cell i{font-style:normal;font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.8}'
    + '.qg-code{display:flex;gap:8px;margin-top:10px}.qg-code input{flex:1;min-width:0;padding:10px;border-radius:6px;border:1px solid #9be23f;font-size:16px;text-transform:uppercase;background:#fff;color:#111}'
    + '.qg-code button{padding:10px 14px;border:0;border-radius:6px;background:#c8102e;color:#fff;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap}'
    + '.qg-msg{font-size:13px;margin-top:6px;min-height:1em}.qg-ok{color:#9be23f}.qg-bad{color:#ff8a8a}'
    + '.qg-lbl{display:block;font-size:13px;margin-top:8px;color:#fff7e6;text-transform:none;letter-spacing:normal}';
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
        html += '<h4>Tickets go on sale ' + fmtAt(ev.onSaleAt) + '</h4>';
        html += '<div class="qg-clock" data-qg-clock="onSaleAt">' + clockHtml(ts(ev.onSaleAt) - t) + '</div>';
        if (mc.earlyAccess && ts(ev.earlyAccessAt)) html += '<p>' + label + ' members: early booking opens ' + fmtAt(ev.earlyAccessAt) + '.</p>';
      } else if (p === 'early') {
        html += '<h4>' + label + ' early booking is open</h4>';
        html += '<p>Public tickets open in</p><div class="qg-clock" data-qg-clock="onSaleAt">' + clockHtml(ts(ev.onSaleAt) - t) + '</div>';
        html += ctrl.applied ? '' : '<p>Enter your ' + label.toLowerCase() + ' code to book now' + (pct ? ' and save ' + pct + '%' : '') + '.</p>';
      } else {
        html += '<h4 style="font-size:15px">' + label + ' member?</h4>';
      }
      if (mc.hash) {
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
      if (rm) rm.onclick = function (e) { e.preventDefault(); ctrl.applied = false; ctrl.code = ''; save(''); refresh(true); };
    }
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
    if (s && mc.hash) check(ev, s).then(function (ok) { if (ok) { ctrl.applied = true; ctrl.code = s; refresh(true); } else save(''); });
    return ctrl;
  }
  window.QuarryGate = { now: now, phase: phase, gated: gated, fmtAt: fmtAt, clockHtml: clockHtml, check: check, saved: saved, save: save, discount: discount, addDiscountLine: addDiscountLine, extNote: extNote, mount: mount, injectCss: injectCss };
})();
