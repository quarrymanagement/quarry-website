/* ============================================================================
 * The Quarry — Admin "Training Tests"
 * Self-injecting: adds "Team › Training Tests" to the sidebar + .tt-panel.
 * Loaded from admin/index.html with <script src="./training-tests-admin.js"></script>.
 *
 * Backend: Supabase edge function `training-tests` (project nkulhtalltbieicvmmad).
 * Tables training_test_attempts / training_test_audit are service-role only.
 * Logins allowed: owner + events_staff (Penny).
 *
 * Flow:  Send (name, email, phone) → private link emailed / texted / copied
 *        → employee takes it on their phone at /training-test.html?t=<token>
 *        → multiple choice graded instantly, written answers land here as
 *          "Needs review" → approve / needs work + notes per answer, overall
 *          Passed / Retake + note → employee is emailed and their link shows it.
 * ==========================================================================*/
(function () {
  'use strict';

  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/training-tests';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';

  var META = null, LIST = [];
  var filter = { q: '' };
  var STATUS = { sent: 'Not started', in_progress: 'In progress', submitted: 'Needs review', reviewed: 'Reviewed', voided: 'Void' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function tok() { return localStorage.getItem('quarryAdminToken') || ''; }
  function api(action, extra) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, 'x-admin-token': tok() },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    }).then(function (r) { return r.json().catch(function () { return { error: 'Bad response (' + r.status + ')' }; }); })
      .catch(function (e) { return { error: e.message || 'Network error' }; });
  }
  function fmtStamp(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
  function toast(msg, bad) {
    Array.prototype.forEach.call(document.querySelectorAll('.tt-toast'), function (o) { o.remove(); });
    var t = document.createElement('div'); t.className = 'tt-toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  function lastSender() { try { return localStorage.getItem('ttSentBy') || ''; } catch (_) { return ''; } }
  function smsHref(phone, url, name) {
    var body = 'Hi ' + String(name || '').split(' ')[0] + ', here is your Quarry server test: ' + url;
    var p = String(phone || '').replace(/[^\d+]/g, '');
    var sep = /iPhone|iPad|Mac/i.test(navigator.userAgent) ? '&' : '?';
    return 'sms:' + p + sep + 'body=' + encodeURIComponent(body);
  }

  /* ---------- styles ---------- */
  function injectStyles() {
    if ($('ttStyles')) return;
    var css = '' +
      '.tt-panel{padding-bottom:60px;}' +
      '.tt-panel .tt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;}' +
      '.tt-panel h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '.tt-panel .tt-sub{color:var(--text-muted);font-size:13px;margin-top:4px;}' +
      '.tt-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;text-decoration:none;display:inline-block;}' +
      '.tt-btn:hover{filter:brightness(1.15);} .tt-btn:disabled{opacity:.45;cursor:not-allowed;}' +
      '.tt-btn.gold{background:var(--gold);} .tt-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.tt-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .tt-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.tt-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.tt-card h3{margin:0 0 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.tt-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px;}' +
      '.tt-stat{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:14px 16px;cursor:pointer;}' +
      '.tt-stat .n{font-size:26px;font-weight:700;color:var(--text-primary);} .tt-stat .l{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;}' +
      '.tt-stat.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}' +
      '.tt-in,.tt-ta{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border-medium);border-radius:8px;font-size:14px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.tt-ta{min-height:70px;resize:vertical;line-height:1.45;}' +
      '.tt-in:focus,.tt-ta:focus{outline:2px solid rgba(154,123,42,.35);border-color:var(--gold);}' +
      '.tt-lbl{display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;} .tt-lbl .req{color:#b42318;}' +
      '.tt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 14px;} .tt-f{margin-bottom:12px;} .tt-hint{font-size:11.5px;color:var(--text-muted);margin-top:4px;}' +
      '.tt-table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;}' +
      '.tt-table th,.tt-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;vertical-align:middle;}' +
      '.tt-table th{background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);}' +
      '.tt-table tr.click{cursor:pointer;} .tt-table tr.click:hover td{background:var(--bg-hover);}' +
      '.tt-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;}' +
      '.tt-pill.sent{background:#eef0f4;color:#4b5263;} .tt-pill.in_progress{background:#e8eefc;color:#2a4a9a;} .tt-pill.submitted{background:#fff4d6;color:#8a5a00;}' +
      '.tt-pill.reviewed,.tt-pill.passed,.tt-pill.approved{background:#dcf5e3;color:#176b34;} .tt-pill.retake,.tt-pill.needs_work,.tt-pill.fail{background:#fde4e1;color:#a52a1e;} .tt-pill.voided{background:#f1f1f1;color:#999;}' +
      '.tt-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b4e00;margin-bottom:14px;}' +
      '.tt-callout.ok{background:#ecf9f0;border-color:#b9e5c6;color:#176b34;}' +
      '.tt-link{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;} .tt-link input{flex:1;min-width:200px;font-size:12px;}' +
      '.tt-actions{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.tt-mc{display:grid;grid-template-columns:28px 1fr;gap:4px 8px;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:13.5px;}' +
      '.tt-mc .m{font-weight:700;} .tt-mc .m.y{color:#176b34;} .tt-mc .m.n{color:#a52a1e;} .tt-mc small{grid-column:2;color:var(--text-muted);}' +
      '.tt-ans{border:1px solid var(--border-subtle);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--bg-card);}' +
      '.tt-ans.approved{border-left:5px solid #2f8a4c;} .tt-ans.needs_work{border-left:5px solid #c0392b;}' +
      '.tt-ans h4{margin:0 0 6px;font-size:15px;color:var(--text-primary);}' +
      '.tt-scene{font-size:13px;color:var(--text-muted);margin-bottom:8px;} .tt-scene b{color:var(--text-secondary);}' +
      '.tt-text{white-space:pre-wrap;background:var(--bg-elevated);border-radius:8px;padding:12px;font-size:14px;line-height:1.55;color:var(--text-primary);margin:8px 0;}' +
      '.tt-look{font-size:12.5px;color:var(--text-secondary);margin:6px 0 10px;} .tt-look b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--gold);margin-bottom:3px;}' +
      '.tt-look span{display:inline-block;background:var(--bg-elevated);border-radius:999px;padding:3px 9px;margin:2px 4px 2px 0;}' +
      '.tt-seg{display:inline-flex;border:1px solid var(--border-medium);border-radius:8px;overflow:hidden;margin-bottom:8px;}' +
      '.tt-seg button{border:0;background:#fff;padding:8px 14px;font:600 13px var(--font-sans);cursor:pointer;color:var(--text-secondary);}' +
      '.tt-seg button+button{border-left:1px solid var(--border-medium);}' +
      '.tt-seg button.on.approved,.tt-seg button.on.passed{background:#2f8a4c;color:#fff;} .tt-seg button.on.needs_work,.tt-seg button.on.retake{background:#c0392b;color:#fff;}' +
      '.tt-audit{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;max-height:200px;overflow:auto;}' +
      '.tt-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}' +
      '.tt-modal .box{background:#fff;border-radius:14px;max-width:480px;width:100%;max-height:90vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '.tt-modal h4{margin:0 0 6px;font-family:var(--font-serif);font-size:1.3rem;}' +
      '.tt-sticky{position:sticky;bottom:0;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:12px 16px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;box-shadow:0 -6px 20px rgba(0,0,0,.06);}' +
      '.tt-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;}' +
      '.tt-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .tt-toast.bad{background:#a52a1e;}' +
      '@media (max-width:700px){.tt-table .hide-sm{display:none;} .tt-panel h2{font-size:1.45rem;}}';
    var st = document.createElement('style'); st.id = 'ttStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- nav + panels ---------- */
  // Two tabs under Team: Invite (send + who hasn't finished) and Submissions (review).
  var MODE = 'subs';
  function bodyEl() { return $(MODE === 'invite' ? 'ttInvBody' : 'ttSubBody'); }
  // Only one panel holds content at a time, so element ids inside never collide.
  function clearOther() { var o = $(MODE === 'invite' ? 'ttSubBody' : 'ttInvBody'); if (o) o.innerHTML = ''; }
  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="ttinvite"]')) {
      var inv = document.createElement('div'); inv.className = 'sb-nav-item'; inv.dataset.tab = 'ttinvite';
      inv.innerHTML = '<span class="sb-ic">✉️</span><span class="sb-lbl">Invite</span>';
      var sub = document.createElement('div'); sub.className = 'sb-nav-item'; sub.dataset.tab = 'ttsubs';
      sub.innerHTML = '<span class="sb-ic">📝</span><span class="sb-lbl">Submissions</span><span id="ttBadge" class="sb-badge" style="display:none;">0</span>';
      // Join the Team group the Write-Ups script creates; otherwise make our own.
      var wu = nav.querySelector('[data-tab="writeups"]');
      if (wu && wu.parentNode) { wu.parentNode.appendChild(inv); wu.parentNode.appendChild(sub); }
      else {
        var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
        var grp = document.createElement('div'); grp.className = 'sb-nav-group'; grp.appendChild(inv); grp.appendChild(sub);
        var sys = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /system/i.test(s.textContent); });
        if (sys) { nav.insertBefore(sec, sys); nav.insertBefore(grp, sys); } else { nav.appendChild(sec); nav.appendChild(grp); }
      }
    }
    var any = document.querySelector('.tab-content');
    [['ttinviteTab', 'ttInvBody'], ['ttsubsTab', 'ttSubBody']].forEach(function (x) {
      if (!$(x[0]) && any) { var div = document.createElement('div'); div.id = x[0]; div.className = 'tab-content tt-panel'; div.innerHTML = '<div id="' + x[1] + '"></div>'; any.parentNode.appendChild(div); }
    });
  }

  function loadMeta() {
    if (META) return Promise.resolve(META);
    return api('admin_meta').then(function (r) { if (!r.error) META = r; return META; });
  }
  function test(key) { return META && META.tests && META.tests[key || 'server']; }

  /* ================= LISTS ================= */
  var lastOpen = 0;
  function showList(force) {
    var body = bodyEl(); if (!body) return;
    clearOther();
    if (!force && Date.now() - lastOpen < 400) return; lastOpen = Date.now();
    if (MODE === 'invite') {
      body.innerHTML = '<div class="tt-head"><div><h2>Invite</h2><div class="tt-sub">Send the server test. They get a private link and take it on their phone.</div></div></div>' +
        '<div class="tt-card"><h3>Send the server test</h3><div class="tt-grid">' +
        '<div class="tt-f"><label class="tt-lbl" for="ttName">Name <span class="req">*</span></label><input class="tt-in" id="ttName" autocomplete="off"></div>' +
        '<div class="tt-f"><label class="tt-lbl" for="ttEmail">Email</label><input class="tt-in" id="ttEmail" type="email" autocomplete="off"></div>' +
        '<div class="tt-f"><label class="tt-lbl" for="ttPhone">Phone</label><input class="tt-in" id="ttPhone" type="tel" autocomplete="off"></div>' +
        '<div class="tt-f"><label class="tt-lbl" for="ttBy">Sent by</label><input class="tt-in" id="ttBy" value="' + esc(lastSender()) + '" placeholder="Your name"></div></div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="tt-btn gold" id="ttGo">Send test</button><span class="tt-hint" style="margin:0">Email → we send the link. Phone → text it from your phone. No email? You can still copy the link.</span></div></div>' +
        '<div id="ttList"><div class="tt-card" style="color:var(--text-muted)">Loading…</div></div>';
      bindSend(document, {}, function (r, f) { sentModal(r, f); });
    } else {
      body.innerHTML = '<div class="tt-head"><div><h2>Submissions</h2><div class="tt-sub">Multiple choice is graded automatically. Review the written answers, leave notes, and mark Passed or Retake.</div></div></div>' +
        '<div id="ttList"><div class="tt-card" style="color:var(--text-muted)">Loading…</div></div>';
    }
    Promise.all([loadMeta(), api('admin_list')]).then(function (res) {
      var r = res[1];
      if (!$('ttList')) return;
      if (r.error) { $('ttList').innerHTML = '<div class="tt-callout">' + esc(r.error) + '</div>'; return; }
      LIST = r.attempts || []; updateBadge(); renderList();
    });
  }
  function updateBadge() {
    var n = LIST.filter(function (a) { return a.status === 'submitted'; }).length;
    var b = $('ttBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  }
  var FILTERS = {
    invite: [['waiting', 'Waiting on employee', function (s) { return s === 'sent' || s === 'in_progress'; }],
             ['notopened', 'Not opened yet', function (s) { return s === 'sent'; }],
             ['allinv', 'All invites', function (s) { return s !== 'voided'; }]],
    subs:   [['review', 'Needs review', function (s) { return s === 'submitted'; }],
             ['reviewed', 'Reviewed', function (s) { return s === 'reviewed'; }],
             ['allsub', 'All submissions', function (s) { return s === 'submitted' || s === 'reviewed'; }]]
  };
  var curFilter = { invite: 'waiting', subs: 'review' };
  function renderList() {
    var defs = FILTERS[MODE], cur = curFilter[MODE];
    var counts = {}; defs.forEach(function (d) { counts[d[0]] = LIST.filter(function (a) { return d[2](a.status); }).length; });
    if (MODE === 'subs' && cur === 'review' && !counts.review && counts.allsub) cur = curFilter.subs = 'allsub';
    var match = defs.filter(function (d) { return d[0] === cur; })[0][2];
    var h = '<div class="tt-stats">' + defs.map(function (d) { return '<div class="tt-stat' + (cur === d[0] ? ' on' : '') + '" data-f="' + d[0] + '"><div class="n">' + counts[d[0]] + '</div><div class="l">' + d[1] + '</div></div>'; }).join('') + '</div>';
    h += '<div style="margin-bottom:12px"><input class="tt-in" id="ttQ" placeholder="Search employee or ref #" style="max-width:340px" value="' + esc(filter.q) + '"></div>';
    var q = filter.q.trim().toLowerCase();
    var rows = LIST.filter(function (a) { return match(a.status) && (!q || (a.employee_name + ' ' + a.ref_no).toLowerCase().indexOf(q) >= 0); });
    if (!rows.length) {
      var empty = MODE === 'invite' ? (LIST.length ? 'Nobody in this list.' : 'No invites yet. Type a name above and send the first test.') :
        (LIST.some(function (a) { return a.status === 'submitted' || a.status === 'reviewed'; }) ? 'Nothing in this list.' : 'No submissions yet. When someone finishes their test it shows up here for review.');
      h += '<div class="tt-card" style="color:var(--text-muted);text-align:center;padding:34px;">' + empty + '</div>';
    } else if (MODE === 'invite') {
      h += '<table class="tt-table"><thead><tr><th>Employee</th><th>Status</th><th class="hide-sm">Sent</th><th class="hide-sm">Contact</th><th></th></tr></thead><tbody>';
      rows.forEach(function (a) {
        var st = a.status === 'reviewed' && a.overall_decision ? '<span class="tt-pill ' + a.overall_decision + '">' + (a.overall_decision === 'passed' ? 'Passed' : 'Retake') + '</span>' : '<span class="tt-pill ' + a.status + '">' + STATUS[a.status] + '</span>';
        h += '<tr class="click" data-id="' + a.id + '"><td><b>' + esc(a.employee_name) + '</b><div style="font-size:11.5px;color:var(--text-muted)">' + esc(a.ref_no) + '</div></td><td>' + st +
          (a.status === 'in_progress' ? '<div style="font-size:11.5px;color:var(--text-muted)">opened ' + fmtStamp(a.opened_at) + '</div>' : '') + '</td>' +
          '<td class="hide-sm">' + fmtStamp(a.sent_at) + (a.sent_by ? '<div style="font-size:11.5px;color:var(--text-muted)">by ' + esc(a.sent_by) + '</div>' : '') + '</td>' +
          '<td class="hide-sm" style="font-size:12.5px">' + esc(a.employee_email || '') + (a.employee_phone ? '<div>' + esc(a.employee_phone) + '</div>' : '') + '</td>' +
          '<td style="text-align:right"><span class="tt-btn sec sm">Open</span></td></tr>';
      });
      h += '</tbody></table>';
    } else {
      h += '<table class="tt-table"><thead><tr><th>Employee</th><th>Multiple choice</th><th>Status</th><th class="hide-sm">Submitted</th><th class="hide-sm">Ref</th></tr></thead><tbody>';
      rows.forEach(function (a) {
        var t = test(a.test_key), pct = a.mc_total ? Math.round(100 * a.mc_score / a.mc_total) : null;
        var mcCell = pct == null ? '—' : '<b>' + pct + '%</b> <span style="color:var(--text-muted);font-size:12px">' + a.mc_score + '/' + a.mc_total + '</span>' + (t && pct < t.passMc ? ' <span class="tt-pill fail">Below ' + t.passMc + '%</span>' : '');
        var st = a.status === 'reviewed' && a.overall_decision ? '<span class="tt-pill ' + a.overall_decision + '">' + (a.overall_decision === 'passed' ? 'Passed' : 'Retake') + '</span>' + (a.reviewed_by ? '<div style="font-size:11.5px;color:var(--text-muted)">by ' + esc(a.reviewed_by) + '</div>' : '') : '<span class="tt-pill ' + a.status + '">' + STATUS[a.status] + '</span>';
        h += '<tr class="click" data-id="' + a.id + '"><td><b>' + esc(a.employee_name) + '</b><div style="font-size:11.5px;color:var(--text-muted)">' + esc(t ? t.title : a.test_key) + '</div></td><td>' + mcCell + '</td><td>' + st + '</td>' +
          '<td class="hide-sm">' + fmtStamp(a.submitted_at) + '</td><td class="hide-sm" style="font-family:ui-monospace,monospace;font-size:12px">' + esc(a.ref_no) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    $('ttList').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#ttList .tt-stat'), function (el) { el.onclick = function () { curFilter[MODE] = el.dataset.f; renderList(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('#ttList tr.click'), function (el) { el.onclick = function () { showDetail(el.dataset.id); }; });
    var qi = $('ttQ'); qi.oninput = function () { filter.q = qi.value; var p = qi.selectionStart; renderList(); var n = $('ttQ'); n.focus(); n.setSelectionRange(p, p); };
  }

  /* ================= SEND ================= */
  function modal(html) {
    var m = document.createElement('div'); m.className = 'tt-modal'; m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m); return m;
  }
  // Wires a name/email/phone/sent-by form (inline on Invite, or in the retake modal).
  function bindSend(root, pre, done) {
    var q = function (id) { return root.querySelector('#' + id); };
    if (pre.employee_name) q('ttName').value = pre.employee_name;
    if (pre.employee_email) q('ttEmail').value = pre.employee_email;
    if (pre.employee_phone) q('ttPhone').value = pre.employee_phone;
    q('ttGo').onclick = function () {
      var f = { employee_name: q('ttName').value.trim(), employee_email: q('ttEmail').value.trim(), employee_phone: q('ttPhone').value.trim(), sent_by: q('ttBy').value.trim(), test_key: 'server' };
      if (!f.employee_name) { toast('Type their name.', true); q('ttName').focus(); return; }
      if (f.employee_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.employee_email)) { toast('That email doesn\'t look right.', true); return; }
      f.delivery = f.employee_email ? 'email' : (f.employee_phone ? 'text' : 'link');
      try { localStorage.setItem('ttSentBy', f.sent_by); } catch (_) {}
      var b = this; b.disabled = true; b.textContent = 'Sending…';
      api('admin_send', { fields: f }).then(function (r) {
        b.disabled = false; b.textContent = 'Send test';
        if (r.error) { toast(r.error, true); return; }
        ['ttName', 'ttEmail', 'ttPhone'].forEach(function (id) { if (q(id)) q(id).value = ''; });
        done(r, f);
      });
    };
  }
  function retakeModal(pre) {
    var m = modal('<h4>Send a retake</h4><p style="color:var(--text-muted);font-size:13px;margin:0 0 14px;">A fresh link to the same test. Their first attempt stays on file.</p>' +
      '<div class="tt-f"><label class="tt-lbl">Name <span class="req">*</span></label><input class="tt-in" id="ttName" autocomplete="off"></div>' +
      '<div class="tt-f"><label class="tt-lbl">Email</label><input class="tt-in" id="ttEmail" type="email" autocomplete="off"></div>' +
      '<div class="tt-f"><label class="tt-lbl">Phone</label><input class="tt-in" id="ttPhone" type="tel" autocomplete="off"></div>' +
      '<div class="tt-f"><label class="tt-lbl">Sent by</label><input class="tt-in" id="ttBy" value="' + esc(lastSender()) + '"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button class="tt-btn sec" id="ttX">Cancel</button><button class="tt-btn gold" id="ttGo">Send test</button></div>');
    m.querySelector('#ttX').onclick = function () { m.remove(); };
    bindSend(m, pre, function (r, f) { m.remove(); sentModal(r, f); });
  }
  function sentModal(r, f) {
    var first = f.employee_name.split(' ')[0];
    var line = f.employee_email ? (r.emailed ? '✓ Emailed to <b>' + esc(f.employee_email) + '</b>.' : 'The email didn\'t go out — copy or text the link instead.') : 'No email on file — text or copy the link.';
    var m = modal('<h4>Test sent to ' + esc(first) + '</h4><p style="font-size:13.5px;margin:0 0 10px;">' + line + '</p>' +
      '<div class="tt-link"><input class="tt-in" id="ttLinkM" readonly value="' + esc(r.link) + '"></div>' +
      '<div class="tt-actions" style="margin-top:12px">' + (f.employee_phone ? '<a class="tt-btn gold" href="' + esc(smsHref(f.employee_phone, r.link, f.employee_name)) + '">Text it to ' + esc(first) + '</a>' : '') +
      '<button class="tt-btn sec" id="ttCopyM">Copy link</button><button class="tt-btn sec" id="ttDone">Done</button></div>' +
      (f.employee_phone ? '<p class="tt-hint" style="margin-top:10px">“Text it” opens Messages on your phone with the link filled in.</p>' : ''));
    m.querySelector('#ttCopyM').onclick = function () { copy(r.link, m.querySelector('#ttLinkM')); };
    m.querySelector('#ttDone').onclick = function () { m.remove(); if (MODE === 'invite') showList(true); };
    if (MODE === 'invite') api('admin_list').then(function (x) { if (!x.error && $('ttList')) { LIST = x.attempts || []; updateBadge(); renderList(); } });
  }
  function copy(s, input) {
    (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('Link copied.'); })
      .catch(function () { if (input) { input.select(); document.execCommand('copy'); toast('Link copied.'); } });
  }

  /* ================= DETAIL / REVIEW ================= */
  var REV = null; // working review state
  function showDetail(id) {
    bodyEl().innerHTML = '<div class="tt-card" style="color:var(--text-muted)">Loading…</div>';
    Promise.all([loadMeta(), api('admin_get', { id: id })]).then(function (res) {
      var r = res[1];
      if (r.error) { bodyEl().innerHTML = '<div class="tt-callout">' + esc(r.error) + '</div>'; return; }
      var a = r.attempt, t = test(a.test_key);
      if (!t) { bodyEl().innerHTML = '<div class="tt-callout">Unknown test.</div>'; return; }
      var done = a.status === 'submitted' || a.status === 'reviewed';
      REV = { reviews: JSON.parse(JSON.stringify(a.reviews || {})), overall: a.overall_decision || null, note: a.overall_note || '', by: a.reviewed_by || lastSender() };

      var h = '<button class="tt-btn sec sm" id="ttBack" style="margin-bottom:14px;">← ' + (MODE === 'invite' ? 'Invite' : 'Submissions') + '</button>';
      h += '<div class="tt-head"><div><h2>' + esc(a.employee_name) + '</h2><div class="tt-sub">' + esc(t.title) + ' · ' + esc(a.ref_no) + ' · <span class="tt-pill ' + a.status + '">' + STATUS[a.status] + '</span>' +
        (a.employee_email ? ' · ' + esc(a.employee_email) : '') + (a.employee_phone ? ' · ' + esc(a.employee_phone) : '') + '</div></div><div class="tt-actions" id="ttAct"></div></div>';

      if (!done && a.status !== 'voided') {
        h += '<div class="tt-callout"><b>' + (a.status === 'sent' ? 'Sent ' + fmtStamp(a.sent_at) + ' — not opened yet.' : 'Opened ' + fmtStamp(a.opened_at) + ' — they\'re working on it.') + '</b>' +
          '<div class="tt-link"><input class="tt-in" id="ttLink" readonly value="' + esc(r.link) + '"><button class="tt-btn sec sm" id="ttCopy">Copy link</button>' +
          (a.employee_phone ? '<a class="tt-btn sec sm" href="' + esc(smsHref(a.employee_phone, r.link, a.employee_name)) + '">Text link</a>' : '') + '</div></div>';
      }
      if (a.status === 'reviewed') h += '<div class="tt-callout ok"><b>Reviewed by ' + esc(a.reviewed_by || '—') + '</b> · ' + fmtStamp(a.reviewed_at) + ' · ' + (a.overall_decision === 'passed' ? 'Passed' : 'Retake') + '. ' + esc(a.employee_name.split(' ')[0]) + '\'s link shows your notes. You can still edit and re-save below.</div>';

      if (done) {
        var pct = Math.round(100 * a.mc_score / a.mc_total), pass = pct >= t.passMc;
        h += '<div class="tt-card"><h3>Part 1 · Multiple choice — graded automatically</h3><div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px">' +
          '<span style="font-size:30px;font-weight:700;">' + pct + '%</span><span>' + a.mc_score + ' of ' + a.mc_total + '</span><span class="tt-pill ' + (pass ? 'passed' : 'fail') + '">' + (pass ? 'Passed' : 'Below ' + t.passMc + '%') + '</span>' +
          '<span style="color:var(--text-muted);font-size:12.5px">Submitted ' + fmtStamp(a.submitted_at) + '</span></div>' +
          '<details' + (pass ? '' : ' open') + '><summary style="cursor:pointer;font-weight:600;font-size:13px">Show every answer</summary>' +
          t.mc.map(function (q, i) {
            var ch = a.mc_answers[q.id], ok = ch === q.answer;
            return '<div class="tt-mc"><span class="m ' + (ok ? 'y' : 'n') + '">' + (ok ? '✓' : '✗') + '</span><span>' + (i + 1) + '. ' + esc(q.q) + '</span>' +
              '<small>' + (ok ? esc(q.options[q.answer]) : 'Picked: ' + esc(q.options[ch]) + ' · Right: ' + esc(q.options[q.answer])) + '</small></div>';
          }).join('') + '</details></div>';

        h += '<div class="tt-card"><h3>Part 2 · Written answers — your review</h3><p class="tt-sub" style="margin:-4px 0 14px">Approve it or mark it needs work, and leave a note. Notes go straight to ' + esc(a.employee_name.split(' ')[0]) + ' — be specific about what to do differently.</p>' +
          t.open.map(function (o) {
            var rv = REV.reviews[o.id] || {};
            return '<div class="tt-ans ' + (rv.decision || '') + '" id="ans_' + o.id + '"><h4>' + esc(o.title) + '</h4>' +
              '<div class="tt-scene"><b>Situation:</b> ' + esc(o.scenario) + ' <b>' + esc(o.ask) + '</b></div>' +
              '<div class="tt-text">' + esc(a.open_answers[o.id] || '') + '</div>' +
              '<div class="tt-look"><b>Looking for</b>' + o.lookFor.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>' +
              '<div class="tt-seg" data-q="' + o.id + '"><button data-v="approved" class="approved' + (rv.decision === 'approved' ? ' on' : '') + '">✓ Approve</button><button data-v="needs_work" class="needs_work' + (rv.decision === 'needs_work' ? ' on' : '') + '">Needs work</button></div>' +
              '<textarea class="tt-ta" data-note="' + o.id + '" placeholder="Note for ' + esc(a.employee_name.split(' ')[0]) + ' — what was great, what to do differently">' + esc(rv.note || '') + '</textarea></div>';
          }).join('') + '</div>';

        h += '<div class="tt-card"><h3>Overall</h3><div class="tt-seg" id="ttOverall"><button data-v="passed" class="passed' + (REV.overall === 'passed' ? ' on' : '') + '">Passed</button><button data-v="retake" class="retake' + (REV.overall === 'retake' ? ' on' : '') + '">Retake</button></div>' +
          '<div class="tt-f"><label class="tt-lbl">Overall note to ' + esc(a.employee_name.split(' ')[0]) + '</label><textarea class="tt-ta" id="ttNote" style="min-height:90px" placeholder="Big picture: strengths, what to work on, next steps in training">' + esc(REV.note) + '</textarea></div>' +
          '<div class="tt-f" style="max-width:320px"><label class="tt-lbl">Reviewed by</label><input class="tt-in" id="ttRevBy" value="' + esc(REV.by) + '"></div></div>';

        h += '<div class="tt-sticky"><span id="ttProg" style="margin-right:auto;font-size:13px;color:var(--text-muted);align-self:center"></span><button class="tt-btn sec" id="ttSave">Save draft</button><button class="tt-btn gold" id="ttFinish">' + (a.status === 'reviewed' ? 'Save & update ' : 'Finish & send to ') + esc(a.employee_name.split(' ')[0]) + '</button></div>';
      }

      if ((r.history || []).length) {
        h += '<div class="tt-card" style="margin-top:14px"><h3>Other tests for ' + esc(a.employee_name) + '</h3>' + r.history.map(function (x) {
          var p = x.mc_total ? Math.round(100 * x.mc_score / x.mc_total) + '%' : '—';
          return '<div style="padding:5px 0;font-size:13.5px;">' + fmtDate(x.sent_at) + ' — <a href="#" data-id="' + x.id + '" class="ttHist" style="color:var(--gold)">' + esc(x.ref_no) + '</a> · MC ' + p + ' · <span class="tt-pill ' + (x.overall_decision || x.status) + '">' + (x.overall_decision ? (x.overall_decision === 'passed' ? 'Passed' : 'Retake') : STATUS[x.status]) + '</span></div>';
        }).join('') + '</div>';
      }
      h += '<div class="tt-card" style="margin-top:14px"><h3>Activity</h3><div class="tt-audit">' + (r.audit || []).map(function (x) { return '<div>' + fmtStamp(x.created_at) + ' · <b>' + esc(String(x.event).toUpperCase()) + '</b> · ' + esc(x.actor || '') + (x.ip ? ' · IP ' + esc(x.ip) : '') + '</div>'; }).join('') + '</div></div>';

      bodyEl().innerHTML = h;
      $('ttBack').onclick = function () { showList(true); };
      if ($('ttCopy')) $('ttCopy').onclick = function () { copy(r.link, $('ttLink')); };
      Array.prototype.forEach.call(document.querySelectorAll('.ttHist'), function (el) { el.onclick = function (e) { e.preventDefault(); showDetail(el.dataset.id); }; });

      if (done) bindReview(a, t);

      var act = [];
      if (done) act.push(['Copy employee link', 'sec', function () { copy(r.link); }]);
      if (a.status === 'sent' || a.status === 'in_progress') { if (a.employee_email) act.push(['Re-send email', 'sec', function () { api('admin_remind', { id: a.id }).then(function (x) { toast(x.error || 'Reminder sent.', !!x.error); }); }]); }
      if (a.status === 'reviewed' && a.overall_decision === 'retake') act.push(['Send a retake', 'gold', function () { retakeModal({ employee_name: a.employee_name, employee_email: a.employee_email, employee_phone: a.employee_phone }); }]);
      if (a.status !== 'voided') act.push(['Void', 'danger', function () { voidIt(a); }]);
      var box = $('ttAct');
      act.forEach(function (x) { var b = document.createElement('button'); b.className = 'tt-btn ' + x[1]; b.textContent = x[0]; b.onclick = x[2]; box.appendChild(b); });
      api('admin_list').then(function (lr) { if (!lr.error) { LIST = lr.attempts || []; updateBadge(); } });
    });
  }

  function bindReview(a, t) {
    function prog() {
      var n = t.open.filter(function (o) { return REV.reviews[o.id] && REV.reviews[o.id].decision; }).length;
      $('ttProg').textContent = n + ' of ' + t.open.length + ' answers reviewed' + (REV.overall ? ' · ' + (REV.overall === 'passed' ? 'Passed' : 'Retake') : ' · overall not set');
    }
    Array.prototype.forEach.call(document.querySelectorAll('.tt-seg[data-q] button'), function (b) {
      b.onclick = function () {
        var q = b.parentNode.dataset.q; REV.reviews[q] = REV.reviews[q] || { note: '' }; REV.reviews[q].decision = b.dataset.v;
        Array.prototype.forEach.call(b.parentNode.children, function (x) { x.classList.toggle('on', x === b); });
        $('ans_' + q).className = 'tt-ans ' + b.dataset.v; prog();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('textarea[data-note]'), function (ta) {
      ta.oninput = function () { var q = ta.dataset.note; REV.reviews[q] = REV.reviews[q] || {}; REV.reviews[q].note = ta.value; };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#ttOverall button'), function (b) {
      b.onclick = function () { REV.overall = b.dataset.v; Array.prototype.forEach.call(b.parentNode.children, function (x) { x.classList.toggle('on', x === b); }); prog(); };
    });
    $('ttNote').oninput = function () { REV.note = this.value; };
    $('ttRevBy').oninput = function () { REV.by = this.value; };
    prog();
    function submit(finish) {
      var btns = [$('ttSave'), $('ttFinish')]; btns.forEach(function (b) { b.disabled = true; });
      try { if (REV.by) localStorage.setItem('ttSentBy', REV.by); } catch (_) {}
      api('admin_review', { id: a.id, reviews: REV.reviews, overall_decision: REV.overall, overall_note: REV.note, reviewed_by: REV.by, finish: finish }).then(function (r) {
        btns.forEach(function (b) { b.disabled = false; });
        if (r.error) { toast(r.error, true); return; }
        if (finish) { toast(r.emailed ? 'Review sent — ' + a.employee_name.split(' ')[0] + ' was emailed.' : 'Review saved. Their link shows your notes' + (a.employee_email ? '' : ' — text them the link') + '.'); showDetail(a.id); }
        else toast('Draft saved.');
      });
    }
    $('ttSave').onclick = function () { submit(false); };
    $('ttFinish').onclick = function () { submit(true); };
  }

  function voidIt(a) {
    var m = modal('<h4>Void ' + esc(a.ref_no) + '?</h4><p style="color:var(--text-muted);font-size:13px;margin:0 0 12px;">It stays on file marked void and the link stops working.</p>' +
      '<div class="tt-f"><label class="tt-lbl">Reason</label><input class="tt-in" id="ttVr" placeholder="e.g. Sent to the wrong person"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;"><button class="tt-btn sec" id="ttVx">Cancel</button><button class="tt-btn danger" id="ttVgo">Void it</button></div>');
    m.querySelector('#ttVx').onclick = function () { m.remove(); };
    m.querySelector('#ttVgo').onclick = function () { api('admin_void', { id: a.id, reason: m.querySelector('#ttVr').value }).then(function (r) { m.remove(); toast(r.error || 'Voided.', !!r.error); showDetail(a.id); }); };
  }

  /* ---------- boot ---------- */
  window.TrainingTestsUI = { invite: function () { window.switchTab('ttinvite'); }, submissions: function () { window.switchTab('ttsubs'); }, detail: showDetail };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._tt) {
      window.switchTab = function (name) {
        var out = orig.apply(this, arguments);
        if (name === 'ttinvite' || name === 'ttsubs') { MODE = name === 'ttinvite' ? 'invite' : 'subs'; showList(true); }
        return out;
      };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._tt = true;
    }
    ['ttinvite', 'ttsubs'].forEach(function (t) {
      var item = document.querySelector('.sb-nav-item[data-tab="' + t + '"]');
      if (item && !item._ttBound) { item._ttBound = true; item.addEventListener('click', function () { window.switchTab(t); }); }
    });
    if (tok()) api('admin_list').then(function (r) { if (!r.error) { LIST = r.attempts || []; updateBadge(); } });
  }
  // Boot after the Write-Ups script (500 ms) so we can join its Team group.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 700); });
  else setTimeout(boot, 700);
})();
