/* ============================================================================
 * The Quarry — Admin "Call-in Reservations"
 * Self-injecting tab (sits under Pending Approvals). Lists reservations staff
 * took by phone on the iPad form (quarry-checklist /callin.html) and lets a
 * manager tick them off as followed up. Every call-in is ALSO emailed to
 * management@ the moment it's saved; this is the safety net if an email is missed.
 * Backend: Supabase edge function `callin-reservation` (owner, events_staff).
 * ==========================================================================*/
(function () {
  'use strict';
  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/callin-reservation';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';
  var TAB = 'callins', ROWS = [], FILTER = 'new';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(action, extra) {
    return fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, 'x-admin-token': localStorage.getItem('quarryAdminToken') || '' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})) })
      .then(function (r) { return r.json().catch(function () { return { error: 'Bad response' }; }); }).catch(function (e) { return { error: e.message }; });
  }
  function when(r) {
    var d = r.requested_date ? new Date(r.requested_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'No date';
    var t = '';
    if (r.requested_time && /^\d{1,2}:\d{2}$/.test(r.requested_time)) { var p = r.requested_time.split(':'), h = +p[0]; t = ' at ' + ((h % 12) || 12) + ':' + p[1] + (h < 12 ? ' AM' : ' PM'); }
    else if (r.requested_time) t = ' at ' + r.requested_time;
    return d + t;
  }
  function stamp(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT' : ''; }
  function styles() {
    if ($('ciStyles')) return;
    var s = document.createElement('style'); s.id = 'ciStyles';
    s.textContent = '.ci-wrap h2{font-family:var(--font-serif);font-size:1.8rem;margin:0;color:var(--text-primary);} .ci-sub{color:var(--text-muted);font-size:13px;margin:4px 0 14px;max-width:640px;}' +
      '.ci-tabs{display:flex;border:1px solid var(--border-medium);border-radius:10px;overflow:hidden;margin-bottom:14px;max-width:420px;} .ci-tabs button{flex:1;border:0;background:var(--bg-card);padding:11px;font:600 13.5px var(--font-sans);cursor:pointer;color:var(--text-secondary);} .ci-tabs button+button{border-left:1px solid var(--border-medium);} .ci-tabs button.on{background:#2C1A0E;color:#fff;}' +
      '.ci-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;}' +
      '.ci-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-left:5px solid var(--gold);border-radius:12px;padding:14px 16px;} .ci-card.done{border-left-color:#3a9a5b;opacity:.8;}' +
      '.ci-card .nm{font-size:16px;font-weight:700;color:var(--text-primary);} .ci-card .meta{font-size:12.5px;color:var(--text-muted);margin:2px 0 8px;}' +
      '.ci-card .row{font-size:14px;margin:3px 0;color:var(--text-primary);} .ci-card .row b{color:var(--text-secondary);font-weight:600;margin-right:4px;}' +
      '.ci-card a.tel{display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border-radius:9px;background:var(--gold);color:#fff;font-weight:700;text-decoration:none;font-size:14px;}' +
      '.ci-btn{border:1px solid var(--border-subtle);background:var(--bg-elevated);border-radius:9px;padding:9px 14px;font:600 13.5px var(--font-sans);cursor:pointer;color:var(--text-primary);margin-top:6px;}' +
      '.ci-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#eee;color:#666;margin-left:6px;} .ci-pill.err{background:#fde4e1;color:#a52a1e;}';
    document.head.appendChild(s);
  }
  function dom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="' + TAB + '"]')) {
      var it = document.createElement('div'); it.className = 'sb-nav-item'; it.dataset.tab = TAB;
      it.innerHTML = '<span class="sb-ic">📞</span><span class="sb-lbl">Call-in Reservations</span><span id="ciBadge" class="sb-badge" style="display:none;">0</span>';
      var a = nav.querySelector('[data-tab="resInqPending"]');
      if (a && a.parentNode) a.parentNode.insertBefore(it, a.nextSibling); else nav.appendChild(it);
    }
    var any = document.querySelector('.tab-content');
    if (!$(TAB + 'Tab') && any) { var d = document.createElement('div'); d.id = TAB + 'Tab'; d.className = 'tab-content ci-wrap'; any.parentNode.appendChild(d); }
  }
  function badge() { var b = $('ciBadge'); if (!b) return; var n = ROWS.filter(function (r) { return r.status === 'new' && !r.is_test; }).length; b.textContent = n; b.style.display = n ? '' : 'none'; }
  function load() { return api('admin_list').then(function (r) { if (!r.error) { ROWS = r.callins || []; badge(); } return r.error; }); }
  function render(err) {
    var el = $(TAB + 'Tab'); if (!el) return;
    var nNew = ROWS.filter(function (r) { return r.status === 'new'; }).length;
    var list = ROWS.filter(function (r) { return FILTER === 'all' || r.status === FILTER; });
    el.innerHTML = '<h2>Call-in Reservations</h2><div class="ci-sub">Taken by phone on the staff iPads. Each one was also emailed to management@ when it was saved. Call the guest, then tap <b>Followed up</b>.</div>' +
      '<div class="ci-tabs"><button data-f="new" class="' + (FILTER === 'new' ? 'on' : '') + '">To call (' + nNew + ')</button><button data-f="followed_up" class="' + (FILTER === 'followed_up' ? 'on' : '') + '">Done</button><button data-f="all" class="' + (FILTER === 'all' ? 'on' : '') + '">All</button></div>' +
      (err ? '<div class="ci-sub" style="color:#a52a1e">' + esc(err) + '</div>' : '') +
      (list.length ? '<div class="ci-grid">' + list.map(function (r) {
        return '<div class="ci-card' + (r.status === 'followed_up' ? ' done' : '') + '"><div class="nm">' + esc(r.guest_name) + (r.is_test ? '<span class="ci-pill">TEST</span>' : '') + (r.email_error ? '<span class="ci-pill err">email failed</span>' : '') + '</div>' +
          '<div class="meta">#' + r.ref_no + ' · taken ' + esc(stamp(r.created_at)) + (r.taken_by ? ' by ' + esc(r.taken_by) : '') + '</div>' +
          '<div class="row"><b>When</b>' + esc(when(r)) + '</div><div class="row"><b>Guests</b>' + (r.guest_count || '—') + '</div>' +
          '<div class="row"><b>Catering</b>' + (r.catering ? 'Yes' + (r.catering_notes ? ': ' + esc(r.catering_notes) : '') : 'No') + '</div>' +
          (r.notes ? '<div class="row"><b>Notes</b>' + esc(r.notes) + '</div>' : '') +
          '<div><a class="tel" href="tel:' + esc(String(r.guest_phone).replace(/[^\d+]/g, '')) + '">📞 ' + esc(r.guest_phone) + '</a>' + (r.guest_email ? '<a class="tel" style="background:#2C1A0E" href="mailto:' + esc(r.guest_email) + '">✉️ Email</a>' : '') + '</div>' +
          (r.status === 'followed_up' ? '<div class="meta" style="margin-top:8px">Followed up ' + esc(stamp(r.followed_up_at)) + (r.followed_up_by ? ' by ' + esc(r.followed_up_by) : '') + ' · <a href="#" data-undo="' + r.id + '">undo</a></div>'
            : '<button class="ci-btn" data-done="' + r.id + '">✓ Followed up</button>') + '</div>';
      }).join('') + '</div>' : '<div class="ci-sub">Nothing here.</div>');
    Array.prototype.forEach.call(el.querySelectorAll('[data-f]'), function (b) { b.onclick = function () { FILTER = b.getAttribute('data-f'); render(); }; });
    Array.prototype.forEach.call(el.querySelectorAll('[data-done],[data-undo]'), function (b) {
      b.onclick = function (e) {
        e.preventDefault(); var done = b.hasAttribute('data-done');
        api('admin_status', { id: b.getAttribute(done ? 'data-done' : 'data-undo'), status: done ? 'followed_up' : 'new', actor: localStorage.getItem('feBy') || localStorage.getItem('evSentBy') || '' })
          .then(function (r) { load().then(function () { render(r.error); }); });
      };
    });
  }
  function show() { var el = $(TAB + 'Tab'); if (el) el.innerHTML = '<div class="ci-sub">Loading…</div>'; load().then(render); }
  function boot() {
    styles(); dom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._ci) {
      window.switchTab = function (name) { var out = orig.apply(this, arguments); if (name === TAB) show(); return out; };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._ci = true;
    }
    var it = document.querySelector('.sb-nav-item[data-tab="' + TAB + '"]');
    if (it && !it._ciBound) { it._ciBound = true; it.addEventListener('click', function () { window.switchTab(TAB); }); }
    if (localStorage.getItem('quarryAdminToken')) load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1200); });
  else setTimeout(boot, 1200);
})();
