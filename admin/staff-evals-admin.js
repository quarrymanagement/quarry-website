/* ============================================================================
 * The Quarry — Admin "Evaluations" (staff self-evaluations)
 * Self-injecting: adds "Team › Evaluations" to the sidebar + .ev-panel.
 * Loaded from admin/index.html with <script src="./staff-evals-admin.js"></script>.
 *
 * Backend: Supabase edge function `staff-evals` (project nkulhtalltbieicvmmad).
 * Tables staff_evaluations / staff_evaluation_audit are service-role only.
 * Logins allowed: owner + events_staff.
 *
 * Three views:
 *   Send       pick a role → read every question that will go out → pick who
 *              gets it (roster pre-checked by role) → send. Email if on file,
 *              otherwise Text / Copy link per person.
 *   Responses  employee self-ratings land as "Needs response". Rate the same
 *              standards, leave notes, strengths and a 30-day focus → employee
 *              is emailed, sees both side by side, writes a reflection.
 *   Questions  read-only view of all six forms.
 *   Weekly     team focus per role for the week, send check-ins to everyone
 *              with open goals, read the three answers (what they focused on,
 *              how they'll keep improving, two things they're adding), reply.
 *              Backend: edge function `staff-checkins`.
 *   Guest feedback  Google reviews (guest_reviews). Add "what we're changing",
 *              tag staff named, hide any. Staff see the last 60 days of shared
 *              reviews at the start of their evaluation, complaints first.
 * ==========================================================================*/
(function () {
  'use strict';

  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/staff-evals';
  var FN_CI = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/staff-checkins';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';

  var META = null, LIST = [], ROSTER = null;
  var VIEW = 'responses';
  var STATUS = { sent: 'Not started', in_progress: 'In progress', submitted: 'Needs response', responded: 'Waiting on them', acknowledged: 'Done', voided: 'Void' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function tok() { return localStorage.getItem('quarryAdminToken') || ''; }
  function apiCI(action, extra) { return api(action, extra, FN_CI); }
  function api(action, extra, url) {
    return fetch(url || FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, 'x-admin-token': tok() },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    }).then(function (r) { return r.json().catch(function () { return { error: 'Bad response (' + r.status + ')' }; }); })
      .catch(function (e) { return { error: e.message || 'Network error' }; });
  }
  function fmtStamp(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
  function first(n) { return String(n || '').trim().split(' ')[0]; }
  function toast(msg, bad) {
    Array.prototype.forEach.call(document.querySelectorAll('.ev-toast'), function (o) { o.remove(); });
    var t = document.createElement('div'); t.className = 'ev-toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3400);
  }
  function lastSender() { try { return localStorage.getItem('evSentBy') || localStorage.getItem('ttSentBy') || ''; } catch (_) { return ''; } }
  function setSender(v) { try { if (v) localStorage.setItem('evSentBy', v); } catch (_) {} }
  function smsHref(phone, url, name, title) {
    var body = 'Hi ' + first(name) + ', here is your Quarry ' + String(title || 'self-evaluation').toLowerCase() + ': ' + url;
    var p = String(phone || '').replace(/[^\d+]/g, '');
    var sep = /iPhone|iPad|Mac/i.test(navigator.userAgent) ? '&' : '?';
    return 'sms:' + p + sep + 'body=' + encodeURIComponent(body);
  }
  function copy(s, input) {
    (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('Link copied.'); })
      .catch(function () { if (input) { input.select(); document.execCommand('copy'); toast('Link copied.'); } });
  }
  function avg(obj) {
    var v = Object.keys(obj || {}).map(function (k) { return obj[k]; }).filter(function (x) { return typeof x === 'number'; });
    return v.length ? (v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(1) : null;
  }
  function form(key) { return META && META.forms && META.forms[key]; }
  function modal(html) {
    var m = document.createElement('div'); m.className = 'ev-modal'; m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m); return m;
  }

  /* ---------- styles ---------- */
  function injectStyles() {
    if ($('evStyles')) return;
    var css = '' +
      '.ev-panel{padding-bottom:60px;}' +
      '.ev-panel .ev-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px;}' +
      '.ev-panel h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '.ev-sub{color:var(--text-muted);font-size:13px;margin-top:4px;}' +
      '.ev-tabs{display:inline-flex;border:1px solid var(--border-medium);border-radius:10px;overflow:hidden;margin-bottom:16px;}' +
      '.ev-tabs button{border:0;background:var(--bg-card);padding:9px 16px;font:600 13px var(--font-sans);cursor:pointer;color:var(--text-secondary);}' +
      '.ev-tabs button+button{border-left:1px solid var(--border-medium);} .ev-tabs button.on{background:#2C1A0E;color:#fff;}' +
      '.ev-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;text-decoration:none;display:inline-block;}' +
      '.ev-btn:hover{filter:brightness(1.15);} .ev-btn:disabled{opacity:.45;cursor:not-allowed;}' +
      '.ev-btn.gold{background:var(--gold);} .ev-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.ev-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .ev-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.ev-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.ev-card h3{margin:0 0 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.ev-roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}' +
      '.ev-role{border:1.5px solid var(--border-subtle);border-radius:12px;padding:14px;cursor:pointer;background:var(--bg-card);text-align:left;font-family:var(--font-sans);}' +
      '.ev-role b{display:block;font-size:15px;color:var(--text-primary);} .ev-role span{font-size:12px;color:var(--text-muted);}' +
      '.ev-role.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}' +
      '.ev-steps{display:flex;gap:6px;margin:0 0 14px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;}' +
      '.ev-steps span{padding:4px 10px;border-radius:999px;background:var(--bg-elevated);} .ev-steps span.on{background:#2C1A0E;color:#fff;} .ev-steps span.done{background:#dcf5e3;color:#176b34;}' +
      '.ev-area{border-top:1px solid var(--border-subtle);padding:12px 0;} .ev-area:first-child{border-top:0;}' +
      '.ev-area h4{margin:0 0 4px;font-size:14.5px;color:var(--text-primary);} .ev-area h4 small{color:var(--text-muted);font-weight:500;margin-right:6px;}' +
      '.ev-std{font-size:13.5px;color:var(--text-secondary);margin:2px 0 4px;} .ev-pr{font-size:13px;color:var(--text-muted);} .ev-pr b{color:var(--gold);font-weight:700;}' +
      '.ev-scale{font-size:12.5px;color:var(--text-muted);display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;} .ev-scale span{background:var(--bg-elevated);border-radius:999px;padding:3px 9px;}' +
      '.ev-in,.ev-ta{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border-medium);border-radius:8px;font-size:14px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.ev-ta{min-height:70px;resize:vertical;line-height:1.45;}' +
      '.ev-lbl{display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;} .ev-lbl .req{color:#b42318;}' +
      '.ev-f{margin-bottom:12px;} .ev-hint{font-size:11.5px;color:var(--text-muted);}' +
      '.ev-people{border:1px solid var(--border-subtle);border-radius:10px;max-height:460px;overflow:auto;}' +
      '.ev-grp{padding:8px 12px;background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);font-weight:700;position:sticky;top:0;}' +
      '.ev-p{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--border-subtle);font-size:13.5px;cursor:pointer;}' +
      '.ev-p input{width:17px;height:17px;} .ev-p small{display:block;color:var(--text-muted);font-size:11.5px;}' +
      '.ev-p .tag{font-size:11px;border-radius:999px;padding:2px 8px;background:var(--bg-elevated);color:var(--text-muted);white-space:nowrap;} .ev-p .tag.warn{background:#fff4d6;color:#8a5a00;}' +
      '.ev-table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;}' +
      '.ev-table th,.ev-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;vertical-align:middle;}' +
      '.ev-table th{background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);}' +
      '.ev-table tr.click{cursor:pointer;} .ev-table tr.click:hover td{background:var(--bg-hover);}' +
      '.ev-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px;}' +
      '.ev-stat{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:14px 16px;cursor:pointer;}' +
      '.ev-stat .n{font-size:26px;font-weight:700;color:var(--text-primary);} .ev-stat .l{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;}' +
      '.ev-stat.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}' +
      '.ev-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;}' +
      '.ev-pill.sent{background:#eef0f4;color:#4b5263;} .ev-pill.in_progress{background:#e8eefc;color:#2a4a9a;} .ev-pill.submitted{background:#fff4d6;color:#8a5a00;}' +
      '.ev-pill.responded{background:#e8eefc;color:#2a4a9a;} .ev-pill.acknowledged{background:#dcf5e3;color:#176b34;} .ev-pill.voided{background:#f1f1f1;color:#999;} .ev-pill.gap{background:#fde4e1;color:#a52a1e;}' +
      '.ev-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b4e00;margin-bottom:14px;}' +
      '.ev-callout.ok{background:#ecf9f0;border-color:#b9e5c6;color:#176b34;}' +
      '.ev-ans{border:1px solid var(--border-subtle);border-radius:12px;padding:16px;margin-bottom:12px;background:var(--bg-card);}' +
      '.ev-ans.gap{border-left:5px solid #c0392b;}' +
      '.ev-text{white-space:pre-wrap;background:var(--bg-elevated);border-radius:8px;padding:11px;font-size:14px;line-height:1.5;color:var(--text-primary);margin:8px 0;}' +
      '.ev-rate{display:inline-flex;border:1px solid var(--border-medium);border-radius:8px;overflow:hidden;margin:4px 0 8px;}' +
      '.ev-rate button{border:0;background:#fff;width:42px;padding:8px 0;font:700 14px var(--font-sans);cursor:pointer;color:var(--text-secondary);}' +
      '.ev-rate button+button{border-left:1px solid var(--border-medium);} .ev-rate button.on{background:#2C1A0E;color:#fff;}' +
      '.ev-self{display:inline-flex;align-items:center;gap:8px;font-size:13px;} .ev-self b{font-size:20px;color:var(--text-primary);}' +
      '.ev-sticky{position:sticky;bottom:0;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:12px 16px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;box-shadow:0 -6px 20px rgba(0,0,0,.06);}' +
      '.ev-audit{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;max-height:200px;overflow:auto;}' +
      '.ev-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}' +
      '.ev-modal .box{background:#fff;border-radius:14px;max-width:560px;width:100%;max-height:90vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '.ev-modal h4{margin:0 0 6px;font-family:var(--font-serif);font-size:1.3rem;}' +
      '.ev-res{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #eee;font-size:13.5px;flex-wrap:wrap;}' +
      '.ev-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;}' +
      '.ev-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .ev-toast.bad{background:#a52a1e;}' +
      '@media (max-width:700px){.ev-table .hide-sm{display:none;} .ev-panel h2{font-size:1.45rem;}}';
    var st = document.createElement('style'); st.id = 'evStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- nav + panel ---------- */
  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="staffevals"]')) {
      var it = document.createElement('div'); it.className = 'sb-nav-item'; it.dataset.tab = 'staffevals';
      it.innerHTML = '<span class="sb-ic">🪞</span><span class="sb-lbl">Evaluations</span><span id="evBadge" class="sb-badge" style="display:none;">0</span>';
      var anchor = nav.querySelector('[data-tab="ttsubs"]') || nav.querySelector('[data-tab="writeups"]');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(it, anchor.nextSibling);
      else nav.appendChild(it);
    }
    var any = document.querySelector('.tab-content');
    if (!$('staffevalsTab') && any) { var div = document.createElement('div'); div.id = 'staffevalsTab'; div.className = 'tab-content ev-panel'; div.innerHTML = '<div id="evBody"></div>'; any.parentNode.appendChild(div); }
  }
  function loadMeta() {
    if (META) return Promise.resolve(META);
    return api('admin_meta').then(function (r) { if (!r.error) META = r; return META; });
  }
  function refreshList() {
    return api('admin_list').then(function (r) { if (!r.error) { LIST = r.evaluations || []; updateBadge(); } return r; });
  }
  function updateBadge() {
    var n = LIST.filter(function (a) { return a.status === 'submitted'; }).length;
    var b = $('evBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  }

  function shell(inner) {
    $('evBody').innerHTML = '<div class="ev-head"><div><h2>Evaluations</h2><div class="ev-sub">Staff rate themselves on their role’s standards. You rate the same standards and respond. They reflect.</div></div></div>' +
      '<div class="ev-tabs"><button data-v="send">Send</button><button data-v="responses">Responses</button><button data-v="weekly">Weekly</button><button data-v="questions">Questions</button><button data-v="feedback">Guest feedback</button></div><div id="evView">' + inner + '</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.ev-tabs button'), function (b) {
      b.classList.toggle('on', b.dataset.v === VIEW);
      b.onclick = function () { VIEW = b.dataset.v; show(); };
    });
  }
  function show() {
    shell('<div class="ev-card" style="color:var(--text-muted)">Loading…</div>');
    loadMeta().then(function (m) {
      if (!m) { $('evView').innerHTML = '<div class="ev-callout">Couldn’t load evaluations. Log in again.</div>'; return; }
      if (VIEW === 'send') sendView();
      else if (VIEW === 'questions') questionsView();
      else if (VIEW === 'feedback') feedbackView();
      else if (VIEW === 'weekly') weeklyView();
      else responsesView();
    });
  }

  /* ================= QUESTIONS (read-only) ================= */
  function formHtml(f) {
    var h = '<div class="ev-sub" style="margin:0 0 10px">' + esc(f.intro) + '</div>';
    h += '<div>' + f.areas.map(function (a, i) {
      return '<div class="ev-area"><h4><small>' + (i + 1) + '.</small>' + esc(a.title) + '</h4><div class="ev-std">' + esc(a.standard) + '</div>' +
        '<div class="ev-pr"><b>Rate 1–5, then:</b> ' + esc(a.prompt) + '</div></div>';
    }).join('') + '</div>';
    h += '<div class="ev-scale">' + META.scale.map(function (s) { return '<span>' + s.v + ' · ' + esc(s.label) + '</span>'; }).join('') + '</div>';
    h += '<h3 style="margin:16px 0 6px">Then ' + f.open.length + ' open questions</h3>' + f.open.map(function (o, i) { return '<div class="ev-area"><div class="ev-std">' + (i + 1) + '. ' + esc(o.q) + '</div></div>'; }).join('');
    return h;
  }
  function questionsView() {
    var h = '<div class="ev-callout">These are the exact questions staff see. To change wording, edit <code>FORMS</code> in the <code>staff-evals</code> edge function and bump its version.</div>';
    META.order.forEach(function (k) { var f = form(k); h += '<div class="ev-card"><h3>' + esc(f.title) + ' · ' + f.areas.length + ' standards</h3>' + formHtml(f) + '</div>'; });
    $('evView').innerHTML = h;
  }

  /* ================= SEND ================= */
  var S = { role: null, step: 1, picked: {}, showAll: false, prechecked: false };
  function sendView() {
    var h = '<div class="ev-steps"><span class="' + (S.step === 1 ? 'on' : 'done') + '">1 · Pick the role</span><span class="' + (S.step === 2 ? 'on' : S.step > 2 ? 'done' : '') + '">2 · Review the questions</span><span class="' + (S.step === 3 ? 'on' : '') + '">3 · Choose who gets it</span></div>';
    h += '<div class="ev-card"><h3>Which role?</h3><div class="ev-roles">' + META.order.map(function (k) {
      var f = form(k);
      return '<button class="ev-role' + (S.role === k ? ' on' : '') + '" data-k="' + k + '"><b>' + esc(f.who) + '</b><span>' + f.areas.length + ' standards · ' + f.open.length + ' questions</span></button>';
    }).join('') + '</div></div>';
    if (S.role && S.step >= 2) {
      var f = form(S.role);
      h += '<div class="ev-card" id="evFbPrev"><h3>First screen · what guests are saying</h3><div style="color:var(--text-muted);font-size:13px">Loading…</div></div>';
      h += '<div class="ev-card"><h3>' + esc(f.title) + ' — exactly what they’ll see</h3>' + formHtml(f) +
        (S.step === 2 ? '<div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap"><button class="ev-btn gold" id="evOk">Questions look good → choose who gets it</button><button class="ev-btn sec" id="evNo">Not yet</button></div>' : '') + '</div>';
    }
    if (S.step === 3) h += '<div class="ev-card" id="evPick"><h3>Who gets the ' + esc(form(S.role).title) + '</h3><div style="color:var(--text-muted)">Loading the roster…</div></div>';
    $('evView').innerHTML = h;

    Array.prototype.forEach.call(document.querySelectorAll('.ev-role'), function (b) {
      b.onclick = function () { S.role = b.dataset.k; S.step = 2; S.picked = {}; S.prechecked = false; sendView(); };
    });
    if ($('evOk')) $('evOk').onclick = function () { S.step = 3; sendView(); setTimeout(function () { if ($('evPick')) $('evPick').scrollIntoView({ behavior: 'smooth' }); }, 50); };
    if ($('evNo')) $('evNo').onclick = function () { S.step = 1; S.role = null; sendView(); toast('Nothing sent.'); };
    if (S.step === 3) loadRoster();
    if ($('evFbPrev')) api('admin_feedback_preview', { name: '' }).then(function (r) {
      var b = $('evFbPrev'); if (!b) return;
      var list = (r && r.feedback) || [];
      b.innerHTML = '<h3>First screen · what guests are saying</h3>' + (list.length ?
        '<p class="ev-sub" style="margin:-4px 0 10px">Everyone gets these, plus any review that names them. Edit notes or hide reviews under Guest feedback.</p>' + reviewCards(list) :
        '<p class="ev-sub">No shared reviews from the last 60 days yet, so this screen is skipped. Add reviews under Guest feedback.</p>');
    });
  }
  function loadRoster() {
    var p = ROSTER ? Promise.resolve({ roster: ROSTER }) : api('admin_roster');
    Promise.all([p, refreshList()]).then(function (res) {
      var r = res[0];
      if (!$('evPick')) return;
      if (r.error) { $('evPick').innerHTML = '<div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      ROSTER = r.roster || [];
      if (!S.prechecked) { ROSTER.forEach(function (x) { if (x.suggested.indexOf(S.role) >= 0 && !openFor(x.name)) S.picked[x.name] = true; }); S.prechecked = true; }
      renderPick();
    });
  }
  function openFor(name) {
    return LIST.filter(function (e) { return e.role_key === S.role && e.employee_name.toLowerCase() === name.toLowerCase() && ['sent', 'in_progress', 'submitted'].indexOf(e.status) >= 0; })[0];
  }
  function renderPick() {
    var role = S.role, isSupport = ['host', 'busser', 'expo'].indexOf(role) >= 0;
    var match = ROSTER.filter(function (x) { return x.suggested.indexOf(role) >= 0; });
    var support = isSupport ? ROSTER.filter(function (x) { return x.support && match.indexOf(x) < 0; }) : [];
    var rest = ROSTER.filter(function (x) { return match.indexOf(x) < 0 && support.indexOf(x) < 0; });
    function row(x) {
      var o = openFor(x.name), contact = x.email ? esc(x.email) : (x.phone ? esc(x.phone) + ' · text it' : 'No email or phone · copy link');
      var tag = o ? '<span class="tag warn">Already has one open</span>' : (x.jobs.length ? '<span class="tag">' + esc(x.jobs.join(', ')) + '</span>' : (x.checklist_role ? '<span class="tag">' + esc(x.checklist_role) + '</span>' : ''));
      return '<label class="ev-p"><input type="checkbox" data-n="' + esc(x.name) + '"' + (S.picked[x.name] ? ' checked' : '') + '><span><b>' + esc(x.name) + '</b><small>' + contact + '</small></span>' + tag + '</label>';
    }
    var h = '<h3>Who gets the ' + esc(form(role).title) + '</h3>';
    h += '<div class="ev-sub" style="margin:-6px 0 12px">' + (isSupport ? 'Square lumps hosts, bussers and expo together as Support Staff, so support staff are listed but not pre-checked. Tick the ones who work this role.' : 'Everyone whose checklist role or Square job matches is pre-checked.') + '</div>';
    h += '<div class="ev-people">';
    if (match.length) h += '<div class="ev-grp">Matches this role (' + match.length + ')</div>' + match.map(row).join('');
    if (support.length) h += '<div class="ev-grp">Support staff (' + support.length + ')</div>' + support.map(row).join('');
    if (S.showAll && rest.length) h += '<div class="ev-grp">Everyone else (' + rest.length + ')</div>' + rest.map(row).join('');
    if (!match.length && !support.length && !S.showAll) h += '<div style="padding:16px;color:var(--text-muted)">Nobody on the roster matches this role. Show everyone to pick by hand.</div>';
    h += '</div>';
    h += '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 14px"><button class="ev-btn sec sm" id="evAll">' + (S.showAll ? 'Hide everyone else' : 'Show everyone') + '</button><button class="ev-btn sec sm" id="evNone">Clear all</button><button class="ev-btn sec sm" id="evAdd">+ Add someone not listed</button></div>';
    h += '<div class="ev-f" style="max-width:300px"><label class="ev-lbl">Sent by</label><input class="ev-in" id="evBy" value="' + esc(lastSender()) + '" placeholder="Your name"></div>';
    var n = Object.keys(S.picked).filter(function (k) { return S.picked[k]; }).length;
    h += '<button class="ev-btn gold" id="evSend"' + (n ? '' : ' disabled') + '>Send to ' + n + ' ' + (n === 1 ? 'person' : 'people') + '</button>';
    $('evPick').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#evPick input[type=checkbox]'), function (c) {
      c.onchange = function () { S.picked[c.dataset.n] = c.checked; renderPick(); };
    });
    $('evAll').onclick = function () { S.showAll = !S.showAll; renderPick(); };
    $('evNone').onclick = function () { S.picked = {}; renderPick(); };
    $('evAdd').onclick = addPerson;
    $('evSend').onclick = confirmSend;
  }
  function addPerson() {
    var m = modal('<h4>Add someone</h4><p class="ev-sub" style="margin:0 0 12px">For anyone missing from Square and the checklist roster.</p>' +
      '<div class="ev-f"><label class="ev-lbl">Name <span class="req">*</span></label><input class="ev-in" id="apN"></div>' +
      '<div class="ev-f"><label class="ev-lbl">Email</label><input class="ev-in" id="apE" type="email"></div>' +
      '<div class="ev-f"><label class="ev-lbl">Phone</label><input class="ev-in" id="apP" type="tel"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="ev-btn sec" id="apX">Cancel</button><button class="ev-btn gold" id="apGo">Add</button></div>');
    m.querySelector('#apX').onclick = function () { m.remove(); };
    m.querySelector('#apGo').onclick = function () {
      var name = m.querySelector('#apN').value.trim();
      if (!name) { toast('Type a name.', true); return; }
      ROSTER.unshift({ name: name, email: m.querySelector('#apE').value.trim(), phone: m.querySelector('#apP').value.trim(), jobs: [], checklist_role: '', ref: null, source: 'manual', support: false, suggested: [S.role] });
      S.picked[name] = true; m.remove(); renderPick();
    };
  }
  function confirmSend() {
    var people = ROSTER.filter(function (x) { return S.picked[x.name]; });
    var f = form(S.role), byEmail = people.filter(function (x) { return x.email; }).length;
    var by = $('evBy').value.trim(); setSender(by);
    var m = modal('<h4>Send the ' + esc(f.title) + '?</h4>' +
      '<p style="font-size:14px;margin:0 0 8px">' + people.length + ' ' + (people.length === 1 ? 'person' : 'people') + ': ' + people.map(function (x) { return esc(x.name); }).join(', ') + '.</p>' +
      '<p class="ev-sub" style="margin:0 0 14px">' + byEmail + ' will be emailed now.' + (people.length - byEmail ? ' ' + (people.length - byEmail) + ' have no email, so you’ll get a Text / Copy link button for each on the next screen.' : '') + '</p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="ev-btn sec" id="cX">Cancel</button><button class="ev-btn gold" id="cGo">Send now</button></div>');
    m.querySelector('#cX').onclick = function () { m.remove(); };
    m.querySelector('#cGo').onclick = function () {
      var b = this; b.disabled = true; b.textContent = 'Sending…';
      api('admin_send', { role_key: S.role, sent_by: by, people: people.map(function (x) { return { name: x.name, email: x.email, phone: x.phone, ref: x.ref }; }) }).then(function (r) {
        m.remove();
        if (r.error) { toast(r.error, true); return; }
        sentModal(r.results || [], f);
        S.picked = {}; S.prechecked = false; S.step = 1; S.role = null;
        refreshList().then(function () { if (VIEW === 'send' && $('evView')) sendView(); });
      });
    };
  }
  function sentModal(results, f) {
    var ok = results.filter(function (x) { return x.emailed; }).length;
    var h = '<h4>' + esc(f.title) + ' sent</h4><p class="ev-sub" style="margin:0 0 10px">' + ok + ' emailed. Text or copy the rest.</p>';
    h += results.map(function (x, i) {
      if (x.error) return '<div class="ev-res"><span><b>' + esc(x.name) + '</b></span><span style="color:#a52a1e">' + esc(x.error) + '</span></div>';
      return '<div class="ev-res"><span><b>' + esc(x.name) + '</b> <span class="ev-hint">' + esc(x.ref_no) + '</span></span><span style="display:flex;gap:6px;align-items:center">' +
        (x.emailed ? '<span class="ev-pill acknowledged">✓ Emailed</span>' : (x.email ? '<span class="ev-pill gap">Email failed</span>' : '')) +
        (x.phone ? '<a class="ev-btn ' + (x.emailed ? 'sec' : 'gold') + ' sm" href="' + esc(smsHref(x.phone, x.link, x.name, f.title)) + '">Text</a>' : '') +
        '<button class="ev-btn sec sm" data-i="' + i + '">Copy link</button></span></div>';
    }).join('');
    h += '<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="ev-btn sec" id="sDone">Done</button></div>';
    var m = modal(h);
    Array.prototype.forEach.call(m.querySelectorAll('button[data-i]'), function (b) { b.onclick = function () { copy(results[+b.dataset.i].link); }; });
    m.querySelector('#sDone').onclick = function () { m.remove(); };
  }

  /* ================= GUEST FEEDBACK ================= */
  function starStr(n) { n = +n || 0; return '<span style="color:var(--gold);letter-spacing:1px">' + '★★★★★'.slice(0, n) + '<span style="color:#d9cfbf">' + '★★★★★'.slice(0, 5 - n) + '</span></span>'; }
  function reviewCards(list) {
    return list.map(function (r) {
      var c = r.about_you ? 'var(--gold)' : ((r.rating || 5) <= 3 ? '#c0392b' : '#2f8a4c');
      return '<div class="ev-ans" style="border-left:4px solid ' + c + ';padding:12px 14px"><div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:4px">' + (r.rating ? starStr(r.rating) : '') + '<span>' + esc(r.date || r.review_date || '') + '</span></div>' +
        '<div style="white-space:pre-wrap;font-size:14px">' + esc(r.body) + '</div>' + ((r.note || r.mgmt_note) ? '<div class="ev-text" style="margin-top:8px"><b style="color:var(--gold);font-size:11px;text-transform:uppercase">What we’re changing</b><br>' + esc(r.note || r.mgmt_note) + '</div>' : '') + '</div>';
    }).join('');
  }
  var RV = { list: [], names: [], filter: 'neg' };
  function feedbackView() {
    $('evView').innerHTML = '<div class="ev-card" style="color:var(--text-muted)">Loading reviews…</div>';
    api('admin_reviews').then(function (r) {
      if (r.error) { $('evView').innerHTML = '<div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      RV.list = r.reviews || []; RV.names = r.staff_names || []; renderReviews(r.days);
    });
  }
  function renderReviews(days) {
    var cut = new Date(Date.now() - (days || 60) * 864e5).toISOString().slice(0, 10);
    var defs = [['neg', 'Complaints (1–3★)', function (x) { return (x.rating || 5) <= 3; }], ['recent', 'Last ' + (days || 60) + ' days', function (x) { return (x.review_date || '') >= cut; }],
      ['tagged', 'Name a staff member', function (x) { return (x.staff_mentions || []).length; }], ['hidden', 'Hidden from staff', function (x) { return !x.share; }], ['all', 'All', function () { return true; }]];
    var cur = defs.filter(function (d) { return d[0] === RV.filter; })[0];
    var h = '<div class="ev-callout">Staff see shared reviews from the last ' + (days || 60) + ' days on the first screen of their evaluation: reviews that name them, then complaints, then a couple of 5-star ones. Write a short “what we’re changing” on each complaint; that’s the part they’ll remember.</div>';
    h += '<div class="ev-stats">' + defs.map(function (d) { return '<div class="ev-stat' + (d[0] === RV.filter ? ' on' : '') + '" data-f="' + d[0] + '"><div class="n">' + RV.list.filter(d[2]).length + '</div><div class="l">' + d[1] + '</div></div>'; }).join('') + '</div>';
    var rows = RV.list.filter(cur[2]);
    if (!RV.list.length) h += '<div class="ev-card" style="color:var(--text-muted);text-align:center;padding:30px">No reviews loaded yet.</div>';
    rows.forEach(function (x) {
      h += '<div class="ev-ans" data-id="' + x.id + '" style="' + (x.share ? '' : 'opacity:.55;') + 'border-left:4px solid ' + ((x.rating || 5) <= 3 ? '#c0392b' : '#2f8a4c') + '">' +
        '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--text-muted)"><span>' + (x.rating ? starStr(x.rating) : '') + ' · ' + esc(x.author || 'Guest') + ' · ' + esc(x.review_date || '') + (x.url ? ' · <a href="' + esc(x.url) + '" target="_blank" rel="noopener" style="color:var(--gold)">open</a>' : '') + '</span>' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" class="rvShare"' + (x.share ? ' checked' : '') + '> Show to staff</label></div>' +
        '<div class="ev-text">' + esc(x.body || '(rating only, no text)') + '</div>' + (x.owner_reply ? '<div class="ev-hint" style="margin:-2px 0 8px">Our reply: ' + esc(x.owner_reply) + '</div>' : '') +
        '<div class="ev-grid" style="display:grid;grid-template-columns:1fr 260px;gap:10px"><div><label class="ev-lbl">What we’re changing (staff see this)</label><textarea class="ev-ta rvNote" placeholder="e.g. Drinks were slow: bar now calls for help at 6 tickets">' + esc(x.mgmt_note || '') + '</textarea></div>' +
        '<div><label class="ev-lbl">Staff named</label><input class="ev-in rvTags" value="' + esc((x.staff_mentions || []).join(', ')) + '" placeholder="First names, comma separated" list="evNames"><div class="ev-hint" style="margin-top:4px">Their evaluation shows this review under “Guests who mentioned you.”</div></div></div></div>';
    });
    h += '<datalist id="evNames">' + RV.names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>';
    $('evView').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#evView .ev-stat'), function (el) { el.onclick = function () { RV.filter = el.dataset.f; renderReviews(days); }; });
    Array.prototype.forEach.call(document.querySelectorAll('#evView .ev-ans[data-id]'), function (card) {
      var id = card.dataset.id, x = RV.list.filter(function (y) { return y.id === id; })[0];
      function save(patch, msg) { api('admin_review_update', Object.assign({ id: id }, patch)).then(function (r) { if (r.error) toast(r.error, true); else { Object.assign(x, patch); toast(msg); } }); }
      card.querySelector('.rvShare').onchange = function () { var v = this.checked; card.style.opacity = v ? '' : '.55'; save({ share: v }, v ? 'Shown to staff.' : 'Hidden from staff.'); };
      card.querySelector('.rvNote').onchange = function () { save({ mgmt_note: this.value }, 'Note saved.'); };
      card.querySelector('.rvTags').onchange = function () { save({ staff_mentions: this.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean) }, 'Tags saved.'); };
    });
  }

  /* ================= RESPONSES ================= */
  var F = { tab: 'need', role: '', q: '' };
  var TABS = [
    ['need', 'Needs response', function (s) { return s === 'submitted'; }],
    ['waiting', 'Waiting on employee', function (s) { return s === 'sent' || s === 'in_progress'; }],
    ['responded', 'Waiting on reflection', function (s) { return s === 'responded'; }],
    ['done', 'Done', function (s) { return s === 'acknowledged'; }],
    ['all', 'All', function (s) { return s !== 'voided'; }]
  ];
  function responsesView() {
    $('evView').innerHTML = '<div id="evList"><div class="ev-card" style="color:var(--text-muted)">Loading…</div></div>';
    refreshList().then(function (r) {
      if (!$('evList')) return;
      if (r.error) { $('evList').innerHTML = '<div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      renderList();
    });
  }
  function renderList() {
    var counts = {}; TABS.forEach(function (t) { counts[t[0]] = LIST.filter(function (e) { return t[2](e.status); }).length; });
    var match = TABS.filter(function (t) { return t[0] === F.tab; })[0][2];
    var h = '<div class="ev-stats">' + TABS.map(function (t) { return '<div class="ev-stat' + (F.tab === t[0] ? ' on' : '') + '" data-f="' + t[0] + '"><div class="n">' + counts[t[0]] + '</div><div class="l">' + t[1] + '</div></div>'; }).join('') + '</div>';
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px"><input class="ev-in" id="evQ" placeholder="Search employee or ref #" style="max-width:300px" value="' + esc(F.q) + '">' +
      '<select class="ev-in" id="evR" style="max-width:200px"><option value="">All roles</option>' + META.order.map(function (k) { return '<option value="' + k + '"' + (F.role === k ? ' selected' : '') + '>' + esc(form(k).who) + '</option>'; }).join('') + '</select></div>';
    var q = F.q.trim().toLowerCase();
    var rows = LIST.filter(function (e) { return match(e.status) && (!F.role || e.role_key === F.role) && (!q || (e.employee_name + ' ' + e.ref_no).toLowerCase().indexOf(q) >= 0); });
    if (!rows.length) {
      h += '<div class="ev-card" style="color:var(--text-muted);text-align:center;padding:34px">' + (LIST.length ? 'Nothing in this list.' : 'No evaluations yet. Go to Send, pick a role and review the questions.') + '</div>';
    } else {
      h += '<table class="ev-table"><thead><tr><th>Employee</th><th>Status</th><th>Self</th><th>Mgmt</th><th class="hide-sm">Updated</th></tr></thead><tbody>';
      rows.forEach(function (e) {
        var f = form(e.role_key), sa = avg(e.self_ratings), ma = avg(e.mgr_ratings);
        var when = e.acknowledged_at || e.responded_at || e.submitted_at || e.opened_at || e.sent_at;
        h += '<tr class="click" data-id="' + e.id + '"><td><b>' + esc(e.employee_name) + '</b><div style="font-size:11.5px;color:var(--text-muted)">' + esc(f ? f.who : e.role_key) + ' · ' + esc(e.ref_no) + '</div></td>' +
          '<td><span class="ev-pill ' + e.status + '">' + STATUS[e.status] + '</span></td><td>' + (sa || '—') + '</td><td>' + (ma || '—') + '</td><td class="hide-sm">' + fmtStamp(when) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    $('evList').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#evList .ev-stat'), function (el) { el.onclick = function () { F.tab = el.dataset.f; renderList(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('#evList tr.click'), function (el) { el.onclick = function () { detail(el.dataset.id); }; });
    $('evR').onchange = function () { F.role = this.value; renderList(); };
    var qi = $('evQ'); qi.oninput = function () { F.q = qi.value; var p = qi.selectionStart; renderList(); var n = $('evQ'); n.focus(); n.setSelectionRange(p, p); };
  }

  /* ================= DETAIL / RESPOND ================= */
  var R = null;
  function detail(id) {
    $('evView').innerHTML = '<div class="ev-card" style="color:var(--text-muted)">Loading…</div>';
    api('admin_get', { id: id }).then(function (r) {
      if (r.error) { $('evView').innerHTML = '<div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      var e = r.evaluation, f = form(e.role_key), fn = first(e.employee_name);
      var canEdit = e.status === 'submitted' || e.status === 'responded';
      var has = ['submitted', 'responded', 'acknowledged'].indexOf(e.status) >= 0;
      R = { ratings: Object.assign({}, e.mgr_ratings || {}), notes: Object.assign({}, e.mgr_notes || {}), strengths: e.strengths || '', focus: e.focus || '', overall: e.overall_note || '', by: e.responded_by || lastSender() };
      var h = '<button class="ev-btn sec sm" id="evBack" style="margin-bottom:14px">← Responses</button>';
      h += '<div class="ev-head"><div><h2 style="font-size:1.6rem">' + esc(e.employee_name) + '</h2><div class="ev-sub">' + esc(f.title) + ' · ' + esc(e.ref_no) + ' · <span class="ev-pill ' + e.status + '">' + STATUS[e.status] + '</span>' +
        (e.employee_email ? ' · ' + esc(e.employee_email) : '') + (e.employee_phone ? ' · ' + esc(e.employee_phone) : '') + '</div></div><div id="evAct" style="display:flex;gap:8px;flex-wrap:wrap"></div></div>';

      if (!has && e.status !== 'voided') {
        h += '<div class="ev-callout"><b>' + (e.status === 'sent' ? 'Sent ' + fmtStamp(e.sent_at) + ', not opened yet.' : 'Opened ' + fmtStamp(e.opened_at) + ', they’re working on it.') + '</b>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><input class="ev-in" id="evLink" readonly value="' + esc(r.link) + '" style="flex:1;min-width:200px;font-size:12px"><button class="ev-btn sec sm" id="evCopy">Copy link</button>' +
          (e.employee_phone ? '<a class="ev-btn sec sm" href="' + esc(smsHref(e.employee_phone, r.link, e.employee_name, f.title)) + '">Text link</a>' : '') + '</div></div>';
      }
      if (e.status === 'responded') h += '<div class="ev-callout">Response sent ' + fmtStamp(e.responded_at) + '. Waiting for ' + esc(fn) + '’s reflection. You can still edit and re-save.</div>';
      if (e.status === 'acknowledged') h += '<div class="ev-callout ok"><b>' + esc(fn) + '’s reflection</b> · ' + fmtStamp(e.acknowledged_at) + '<div class="ev-text" style="background:#fff">' + esc(e.reflection) + '</div></div>';

      h += '<div class="ev-card" id="evNums"><h3>The numbers</h3><div style="color:var(--text-muted);font-size:13px">Loading…</div></div>';
      h += '<div class="ev-card" id="evGoals"><h3>Goals</h3><div style="color:var(--text-muted);font-size:13px">Loading…</div></div>';

      if (has) {
        h += '<div class="ev-card"><h3>Standards · their rating vs yours</h3><p class="ev-sub" style="margin:-4px 0 12px">Rate what you actually see on shift. A gap of 2 or more gets flagged on both sides as something to talk about. Notes go straight to ' + esc(fn) + '.</p>';
        f.areas.forEach(function (a) {
          var sv = e.self_ratings[a.id], mv = R.ratings[a.id];
          var gap = mv != null && Math.abs(sv - mv) >= 2;
          h += '<div class="ev-ans' + (gap ? ' gap' : '') + '" id="evA_' + a.id + '"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b style="font-size:15px">' + esc(a.title) + '</b>' +
            '<span class="ev-self">They said <b>' + sv + '</b> ' + esc(META.scale[sv - 1].label) + (gap ? ' <span class="ev-pill gap">Gap</span>' : '') + '</span></div>' +
            '<div class="ev-std">' + esc(a.standard) + '</div><div class="ev-pr">' + esc(a.prompt) + '</div>' +
            '<div class="ev-text">' + esc(e.self_examples[a.id] || '') + '</div>' +
            '<div class="ev-lbl" style="margin-top:6px">Your rating</div><div class="ev-rate" data-a="' + a.id + '">' + [1, 2, 3, 4, 5].map(function (v) { return '<button data-v="' + v + '" title="' + esc(META.scale[v - 1].label) + '"' + (mv === v ? ' class="on"' : '') + (canEdit ? '' : ' disabled') + '>' + v + '</button>'; }).join('') + '</div>' +
            '<textarea class="ev-ta" data-n="' + a.id + '" placeholder="Note for ' + esc(fn) + ': what you see, what to do differently"' + (canEdit ? '' : ' readonly') + '>' + esc(R.notes[a.id] || '') + '</textarea></div>';
        });
        h += '<div class="ev-scale">' + META.scale.map(function (s) { return '<span>' + s.v + ' · ' + esc(s.label) + '</span>'; }).join('') + '</div></div>';

        if ((e.feedback_snapshot || []).length) h += '<div class="ev-card"><h3>Guest reviews they saw</h3>' + reviewCards(e.feedback_snapshot) + '</div>';
        h += '<div class="ev-card"><h3>Their answers</h3>' + f.open.map(function (o) { return '<div class="ev-area"><div class="ev-std"><b>' + esc(o.q) + '</b></div><div class="ev-text">' + esc(e.open_answers[o.id] || '') + '</div>' +
          '<textarea class="ev-ta" data-n="q_' + o.id + '" placeholder="Note for ' + esc(fn) + ' on this answer (optional)"' + (canEdit ? '' : ' readonly') + '>' + esc(R.notes['q_' + o.id] || '') + '</textarea></div>'; }).join('') + '</div>';

        h += '<div class="ev-card"><h3>Your response</h3>' +
          '<div class="ev-f"><label class="ev-lbl">What ' + esc(fn) + ' does well</label><textarea class="ev-ta" id="evStr"' + (canEdit ? '' : ' readonly') + '>' + esc(R.strengths) + '</textarea></div>' +
          '<div class="ev-f"><label class="ev-lbl">Focus for the next 30 days <span class="req">*</span></label><textarea class="ev-ta" id="evFoc" placeholder="One or two specific things"' + (canEdit ? '' : ' readonly') + '>' + esc(R.focus) + '</textarea></div>' +
          '<div class="ev-f"><label class="ev-lbl">Anything else</label><textarea class="ev-ta" id="evOv"' + (canEdit ? '' : ' readonly') + '>' + esc(R.overall) + '</textarea></div>' +
          '<div class="ev-f" style="max-width:300px"><label class="ev-lbl">From</label><input class="ev-in" id="evRb" value="' + esc(R.by) + '"' + (canEdit ? '' : ' readonly') + '></div></div>';
        if (canEdit) h += '<div class="ev-sticky"><span id="evProg" style="margin-right:auto;font-size:13px;color:var(--text-muted);align-self:center"></span><button class="ev-btn sec" id="evSave">Save draft</button><button class="ev-btn gold" id="evFin">' + (e.status === 'responded' ? 'Save & update ' : 'Send to ') + esc(fn) + '</button></div>';
      }

      if ((r.history || []).length) {
        h += '<div class="ev-card" style="margin-top:14px"><h3>Earlier evaluations for ' + esc(e.employee_name) + '</h3>' + r.history.map(function (x) {
          return '<div style="padding:5px 0;font-size:13.5px">' + fmtDate(x.sent_at) + ' · <a href="#" class="evH" data-id="' + x.id + '" style="color:var(--gold)">' + esc(x.ref_no) + '</a> · ' + esc(form(x.role_key) ? form(x.role_key).who : x.role_key) +
            ' · self ' + (avg(x.self_ratings) || '—') + ' / mgmt ' + (avg(x.mgr_ratings) || '—') + ' · <span class="ev-pill ' + x.status + '">' + STATUS[x.status] + '</span></div>';
        }).join('') + '</div>';
      }
      h += '<div class="ev-card"><h3>Activity</h3><div class="ev-audit">' + (r.audit || []).map(function (x) { return '<div>' + fmtStamp(x.created_at) + ' · <b>' + esc(String(x.event).toUpperCase()) + '</b> · ' + esc(x.actor || '') + '</div>'; }).join('') + '</div></div>';

      $('evView').innerHTML = h;
      $('evBack').onclick = function () { responsesView(); };
      if ($('evCopy')) $('evCopy').onclick = function () { copy(r.link, $('evLink')); };
      Array.prototype.forEach.call(document.querySelectorAll('.evH'), function (a) { a.onclick = function (ev) { ev.preventDefault(); detail(a.dataset.id); }; });
      if (has && canEdit) bindRespond(e, f);
      if (e.metrics_snapshot && (e.status === 'responded' || e.status === 'acknowledged')) renderNums(e.metrics_snapshot, e, true);
      else loadNums(e, 60);
      loadGoals(e, f);

      var act = [];
      if (has) act.push(['Copy employee link', 'sec', function () { copy(r.link); }]);
      if ((e.status === 'sent' || e.status === 'in_progress') && e.employee_email) act.push(['Re-send email', 'sec', function () { api('admin_remind', { id: e.id }).then(function (x) { toast(x.error || 'Reminder sent.', !!x.error); }); }]);
      if (e.status !== 'voided' && e.status !== 'acknowledged') act.push(['Void', 'danger', function () { voidIt(e); }]);
      act.forEach(function (x) { var b = document.createElement('button'); b.className = 'ev-btn sm ' + x[1]; b.textContent = x[0]; b.onclick = x[2]; $('evAct').appendChild(b); });
    });
  }
  /* ---------- numbers (management only, never shown to the employee) ---------- */
  function money(c) { return c == null ? '—' : '$' + Math.round(c / 100).toLocaleString('en-US'); }
  function num(v, d) { return v == null || isNaN(v) ? '—' : Number(v).toFixed(d || 0); }
  function loadNums(e, days) {
    var box = $('evNums'); if (!box) return;
    box.innerHTML = '<h3>The numbers</h3><div style="color:var(--text-muted);font-size:13px">Loading…</div>';
    api('admin_metrics', { name: e.employee_name, days: days }).then(function (r) {
      if (!$('evNums')) return;
      if (r.error) { $('evNums').innerHTML = '<h3>The numbers</h3><div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      renderNums(r.metrics, e, false);
    });
  }
  function renderNums(m, e, frozen) {
    var box = $('evNums'); if (!box || !m) return;
    var h = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><h3 style="margin:0">The numbers · last ' + m.days + ' days</h3>';
    h += frozen ? '<span class="ev-hint">Snapshot from when you responded</span>' :
      '<span class="ev-tabs" style="margin:0">' + [30, 60, 90].map(function (d) { return '<button data-d="' + d + '"' + (d === m.days ? ' class="on"' : '') + '>' + d + 'd</button>'; }).join('') + '</span>';
    h += '</div>';
    if (!m.found) {
      h += '<div class="ev-sub">No Square shifts under “' + esc(e.employee_name) + '” in this window. The name has to match Square exactly.</div>';
    } else {
      var me = m.me, pe = m.peers || {}, rows = [];
      function row(label, mine, team, flag, hint) {
        rows.push('<tr' + (flag ? ' style="background:#fff4f2"' : '') + '><td>' + label + (hint ? '<div class="ev-hint">' + hint + '</div>' : '') + '</td><td><b>' + mine + '</b>' + (flag ? ' <span class="ev-pill gap">Look</span>' : '') + '</td><td style="color:var(--text-muted)">' + team + '</td></tr>');
      }
      row('Shifts / hours', num(me.shifts) + ' / ' + num(me.hours, 1), num(pe.shifts, 1) + ' / ' + num(pe.hours, 1));
      row('Shifts over 12 hours', num(me.long_shifts), num(pe.long_shifts, 1), me.long_shifts > 0, 'Usually a missed clock-out');
      if (me.checks > 0) {
        row('Checks closed', num(me.checks), num(pe.checks));
        row('Average check', money(me.avg_check), money(pe.avg_check));
        row('Tips as % of sales', num(me.tip_pct, 1) + '%', num(pe.tip_pct, 1) + '%');
        var cmp = (me.complaint || 0) + (me.entry_error || 0) + (me.changed_mind || 0) + (me.other || 0);
        row('Comps per 100 checks', num(me.comps_per_100, 1), num(pe.comps_per_100, 1), pe.comps_per_100 != null && me.comps_per_100 > pe.comps_per_100 * 1.5 && cmp >= 3,
          cmp + ' comps, ' + money(me.comp_cents) + ': ' + (me.complaint || 0) + ' complaint · ' + (me.entry_error || 0) + ' entry error · ' + (me.changed_mind || 0) + ' changed mind · ' + (me.other || 0) + ' other');
        if (me.cash > 0) row('Cash tips declared', money(me.declared) + ' on ' + money(me.cash) + ' cash', num(pe.declared_pct_of_cash, 1) + '% of cash', (me.declared_pct_of_cash || 0) < 10,
          num(me.declared_pct_of_cash, 1) + '% of the cash they took. A normal cash tip is 15–20%.');
      }
      if (m.checklist) row('Checklist sign-offs', num(m.checklist.n) + ' on ' + num(m.checklist.days) + ' days', '—');
      if (m.training) row('Training test', Math.round(100 * m.training.mc_score / m.training.mc_total) + '%' + (m.training.overall_decision ? ' · ' + (m.training.overall_decision === 'passed' ? 'Passed' : 'Retake') : ''), '—');
      h += '<table class="ev-table" style="font-size:13px"><thead><tr><th></th><th>' + esc(first(e.employee_name)) + '</th><th>' + esc(me.job_title || 'Team') + ' avg' + (pe.n ? ' (' + pe.n + ')' : '') + '</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
      if (me.checks > 0 && !m.comp_approvals_recorded) h += '<p class="ev-hint" style="margin-top:8px">Square isn’t recording who approves comps, so self-approved comps can’t be measured yet.</p>';
      h += '<p class="ev-hint" style="margin-top:6px">Only you see this. Use it in your notes; the employee never sees this table.</p>';
    }
    box.innerHTML = h;
    Array.prototype.forEach.call(box.querySelectorAll('button[data-d]'), function (b) { b.onclick = function () { loadNums(e, +b.dataset.d); }; });
  }

  /* ---------- goals on an evaluation ---------- */
  var GS = { done: 'Done', dropped: 'Dropped', active: 'Open' };
  function loadGoals(e, f) {
    apiCI('admin_goals', { name: e.employee_name }).then(function (r) {
      var box = $('evGoals'); if (!box) return;
      if (r.error) { box.innerHTML = '<h3>Goals</h3><div class="ev-callout">' + esc(r.error) + '</div>'; return; }
      var gs = r.goals || [];
      var h = '<h3>Goals · what ' + esc(first(e.employee_name)) + ' is working on</h3>';
      h += gs.length ? gs.map(function (g) {
        return '<div class="ev-area" data-gid="' + g.id + '" style="' + (g.status === 'active' ? '' : 'opacity:.6') + '"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b style="font-size:13px;color:var(--gold)">' + esc(g.area_title || 'Goal') + (g.set_by === 'mgmt' ? ' · from management' : ' · their goal') + '</b>' +
          '<span><span class="ev-pill ' + (g.status === 'active' ? 'in_progress' : (g.status === 'done' ? 'acknowledged' : 'voided')) + '">' + GS[g.status] + '</span> ' +
          (g.status === 'active' ? '<button class="ev-btn sec sm gDone">Mark done</button> <button class="ev-btn sec sm gDrop">Drop</button>' : '<button class="ev-btn sec sm gOpen">Reopen</button>') + '</span></div>' +
          '<textarea class="ev-ta gTxt" style="margin-top:6px;min-height:50px">' + esc(g.goal) + '</textarea></div>';
      }).join('') : '<p class="ev-sub">No goals yet. They set 1–2 at the end of their evaluation.</p>';
      h += '<div style="display:grid;grid-template-columns:200px 1fr auto;gap:8px;align-items:end;margin-top:10px"><div><label class="ev-lbl">Standard</label><select class="ev-in" id="gArea">' + f.areas.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.title) + '</option>'; }).join('') + '</select></div>' +
        '<div><label class="ev-lbl">Add a goal from management</label><input class="ev-in" id="gNew" placeholder="e.g. Greet every new table within 1 minute on Friday and Saturday"></div><button class="ev-btn gold" id="gAdd">Add</button></div>' +
        '<p class="ev-hint" style="margin-top:6px">Open goals show up on their weekly check-in until they’re done or let go. Max 4 open at a time.</p>';
      box.innerHTML = h;
      function saveG(patch, msg) { apiCI('admin_goal_save', Object.assign({ name: e.employee_name }, patch)).then(function (x) { if (x.error) toast(x.error, true); else { toast(msg); loadGoals(e, f); } }); }
      Array.prototype.forEach.call(box.querySelectorAll('[data-gid]'), function (row) {
        var id = row.dataset.gid;
        var b1 = row.querySelector('.gDone'), b2 = row.querySelector('.gDrop'), b3 = row.querySelector('.gOpen');
        if (b1) b1.onclick = function () { saveG({ id: id, status: 'done' }, 'Marked done.'); };
        if (b2) b2.onclick = function () { saveG({ id: id, status: 'dropped' }, 'Dropped.'); };
        if (b3) b3.onclick = function () { saveG({ id: id, status: 'active' }, 'Reopened.'); };
        row.querySelector('.gTxt').onchange = function () { saveG({ id: id, goal: this.value }, 'Goal updated.'); };
      });
      $('gAdd').onclick = function () {
        var sel = $('gArea'), a = f.areas.filter(function (x) { return x.id === sel.value; })[0];
        saveG({ goal: $('gNew').value, area_id: sel.value, area_title: a ? a.title : '', role_key: e.role_key, evaluation_id: e.id }, 'Goal added.');
      };
    });
  }

  /* ================= WEEKLY ================= */
  var WK = { week: null };
  function mondayISO(d) { d = new Date(d); var dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function shiftWeek(w, n) { var d = new Date(w + 'T12:00:00'); d.setDate(d.getDate() + 7 * n); return mondayISO(d); }
  var RLBL = { done: 'Done', partly: 'Partly', not_yet: 'Not yet' };
  var QUICK = ['Great work. Keep it up.', 'Good goals. I’ll be watching for it this week.', 'Let’s talk on your next shift.', 'Thanks for being honest. What do you need from us?'];
  function weeklyView() {
    WK.week = WK.week || mondayISO(new Date());
    $('evView').innerHTML = '<div class="ev-card" style="color:var(--text-muted)">Loading…</div>';
    Promise.all([apiCI('admin_focus', { week_of: WK.week }), apiCI('admin_due', { week_of: WK.week }), apiCI('admin_list', { week_of: WK.week })]).then(function (res) {
      var fo = res[0], du = res[1], li = res[2];
      if (fo.error || du.error || li.error) { $('evView').innerHTML = '<div class="ev-callout">' + esc(fo.error || du.error || li.error) + '</div>'; return; }
      var wl = new Date(WK.week + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      var h = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px"><button class="ev-btn sec sm" id="wPrev">←</button><b>Week of ' + wl + '</b><button class="ev-btn sec sm" id="wNext">→</button></div>';
      h += '<div class="ev-card"><h3>1 · This week’s focus, by role</h3><p class="ev-sub" style="margin:-4px 0 12px">One line per role, pulled from a policy you’re pushing. It sits at the top of everyone’s check-in. Leave a role blank to skip it.</p>';
      fo.roles.forEach(function (rk) {
        h += '<div class="ev-f"><label class="ev-lbl">' + esc(fo.role_names[rk]) + (fo.last_week[rk] ? ' <span class="ev-hint">· last week: ' + esc(fo.last_week[rk]) + '</span>' : '') + '</label><input class="ev-in wFocus" data-r="' + rk + '" value="' + esc(fo.focus[rk] || '') + '" placeholder="e.g. Every table greeted within 1 minute"></div>';
      });
      h += '</div>';
      h += '<div class="ev-card"><h3>2 · Send check-ins</h3>';
      if (!du.due.length) h += '<p class="ev-sub">' + (du.already_sent ? 'Everyone with open goals already got this week’s check-in.' : 'Nobody has open goals yet. Goals come from finished evaluations.') + '</p>';
      else {
        h += '<p class="ev-sub" style="margin:-4px 0 10px">Everyone with an open goal who hasn’t had this week’s check-in. Set the focus above first; it’s copied into each check-in when you send.</p><div class="ev-people">' +
          du.due.map(function (p, i) { return '<label class="ev-p"><input type="checkbox" class="wPick" data-i="' + i + '" checked><span><b>' + esc(p.name) + '</b><small>' + esc(p.email || (p.phone ? p.phone + ' · text it' : 'No email or phone · copy link')) + '</small></span><span class="tag">' + p.goals + ' open goal' + (p.goals === 1 ? '' : 's') + '</span></label>'; }).join('') +
          '</div><div style="margin-top:12px"><button class="ev-btn gold" id="wSend">Send check-ins</button></div>';
      }
      h += '</div>';
      var cis = li.checkins || [];
      h += '<div class="ev-card"><h3>3 · This week’s check-ins (' + cis.filter(function (c) { return c.status === 'submitted'; }).length + ' of ' + cis.filter(function (c) { return c.status !== 'voided'; }).length + ' in)</h3>';
      h += cis.length ? cis.map(function (c) {
        var head = '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>' + esc(c.employee_name) + '</b><span>' + (c.status === 'submitted' ? '<span class="ev-pill acknowledged">In</span>' : (c.status === 'voided' ? '<span class="ev-pill voided">Void</span>' : '<span class="ev-pill sent">' + (c.opened_at ? 'Opened' : 'Not opened') + '</span> <button class="ev-btn sec sm wCopy" data-l="' + esc(c.link) + '">Copy link</button>')) + '</span></div>';
        var wk = c.worked && ((c.worked.roles || []).length || c.worked.support_shifts) ? '<div class="ev-hint" style="margin-top:4px">Worked: ' + (c.worked.roles || []).map(function (r) { return esc(r.name) + ' ' + r.shifts; }).join(', ') +
          (c.worked.support_shifts ? ((c.worked.roles || []).length ? ', ' : '') + 'Support ' + c.worked.support_shifts + ((c.support_roles || []).length ? ' (mainly ' + esc(c.support_roles[0]) + (c.support_roles.length > 1 ? '; also ' + esc(c.support_roles.slice(1).join(', ')) : '') + ')' : '') : '') + '</div>' : '';
        var body = c.status === 'submitted' ? wk + (c.results || []).map(function (r) {
          return '<div style="margin-top:8px"><span class="ev-pill ' + (r.result === 'done' ? 'acknowledged' : (r.result === 'partly' ? 'submitted' : 'gap')) + '">' + RLBL[r.result] + '</span> <b style="font-size:13.5px">' + esc(r.goal) + '</b><div class="ev-text" style="margin:4px 0 0">' + esc(r.note) + '</div></div>';
        }).join('') + (c.focus_note ? '<div style="margin-top:8px"><b style="font-size:12px;color:var(--gold)">ALSO FOCUSED ON</b><div class="ev-text" style="margin:4px 0 0">' + esc(c.focus_note) + '</div></div>' : '') +
          (c.improve ? '<div style="margin-top:8px"><b style="font-size:12px;color:var(--gold)">HOW THEY’LL KEEP IMPROVING</b><div class="ev-text" style="margin:4px 0 0">' + esc(c.improve) + '</div></div>' : '') +
          ((c.new_goals || []).length ? '<div style="margin-top:8px"><b style="font-size:12px;color:var(--gold)">TWO THINGS THEY’RE ADDING</b>' + c.new_goals.map(function (g) { return '<div class="ev-text" style="margin:4px 0 0"><b>' + esc(g.area_title || '') + '</b> ' + esc(g.goal) + '</div>'; }).join('') + '</div>' : '') +
          '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' + QUICK.map(function (q) { return '<button class="ev-btn sec sm wQuick" data-id="' + c.id + '">' + esc(q) + '</button>'; }).join('') + '</div>' +
          '<div style="margin-top:6px"><textarea class="ev-ta wNote" data-id="' + c.id + '" placeholder="Reply to ' + esc(first(c.employee_name)) + '. Tap one above or write your own; they get an email the first time you reply.">' + esc(c.mgr_note || '') + '</textarea></div>' +
          (c.mgr_at ? '<div class="ev-hint">Replied ' + fmtStamp(c.mgr_at) + (c.mgr_by ? ' by ' + esc(c.mgr_by) : '') + '</div>' : '') : '';
        return '<div class="ev-ans">' + head + body + '</div>';
      }).join('') : '<p class="ev-sub">None sent this week yet.</p>';
      h += '</div>';
      $('evView').innerHTML = h;
      $('wPrev').onclick = function () { WK.week = shiftWeek(WK.week, -1); weeklyView(); };
      $('wNext').onclick = function () { WK.week = shiftWeek(WK.week, 1); weeklyView(); };
      Array.prototype.forEach.call(document.querySelectorAll('.wFocus'), function (inp) {
        inp.onchange = function () { apiCI('admin_focus_set', { week_of: WK.week, role_key: inp.dataset.r, text: inp.value, set_by: lastSender() }).then(function (x) { toast(x.error || 'Focus saved.', !!x.error); }); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('.wCopy'), function (b) { b.onclick = function () { copy(b.dataset.l); }; });
      function sendNote(id, text) { return apiCI('admin_note', { id: id, note: text, by: lastSender() }).then(function (x) { toast(x.error || (x.emailed ? 'Reply sent. They were emailed.' : 'Reply saved.'), !!x.error); }); }
      Array.prototype.forEach.call(document.querySelectorAll('.wNote'), function (ta) { ta.onchange = function () { sendNote(ta.dataset.id, ta.value); }; });
      Array.prototype.forEach.call(document.querySelectorAll('.wQuick'), function (b) {
        b.onclick = function () { var ta = document.querySelector('.wNote[data-id="' + b.dataset.id + '"]'); ta.value = ta.value ? ta.value + ' ' + b.textContent : b.textContent; sendNote(b.dataset.id, ta.value); };
      });
      if ($('wSend')) $('wSend').onclick = function () {
        var people = du.due.filter(function (p, i) { var c = document.querySelector('.wPick[data-i="' + i + '"]'); return c && c.checked; });
        if (!people.length) { toast('Pick at least one person.', true); return; }
        var m = modal('<h4>Send ' + people.length + ' check-in' + (people.length === 1 ? '' : 's') + '?</h4><p class="ev-sub" style="margin:0 0 14px">' + people.filter(function (p) { return p.email; }).length + ' will be emailed now; the rest get Text / Copy link buttons.</p><div style="display:flex;gap:8px;justify-content:flex-end"><button class="ev-btn sec" id="wX">Cancel</button><button class="ev-btn gold" id="wGo">Send now</button></div>');
        m.querySelector('#wX').onclick = function () { m.remove(); };
        m.querySelector('#wGo').onclick = function () {
          this.disabled = true; this.textContent = 'Sending…';
          apiCI('admin_send', { week_of: WK.week, sent_by: lastSender(), people: people.map(function (p) { return { name: p.name, email: p.email, phone: p.phone, role_key: p.role_key, evaluation_id: p.evaluation_id }; }) }).then(function (r) {
            m.remove(); if (r.error) { toast(r.error, true); return; }
            sentModal(r.results || [], { title: 'Weekly check-in' }); weeklyView();
          });
        };
      };
    });
  }

  function bindRespond(e, f) {
    function prog() {
      var n = f.areas.filter(function (a) { return R.ratings[a.id] != null; }).length;
      $('evProg').textContent = n + ' of ' + f.areas.length + ' rated' + (R.focus.trim() ? '' : ' · focus not set');
    }
    Array.prototype.forEach.call(document.querySelectorAll('.ev-rate button'), function (b) {
      b.onclick = function () {
        var id = b.parentNode.dataset.a, v = +b.dataset.v; R.ratings[id] = v;
        Array.prototype.forEach.call(b.parentNode.children, function (x) { x.classList.toggle('on', x === b); });
        var gap = Math.abs(e.self_ratings[id] - v) >= 2, box = $('evA_' + id);
        box.classList.toggle('gap', gap);
        var self = box.querySelector('.ev-self'), pill = self.querySelector('.ev-pill');
        if (gap && !pill) self.insertAdjacentHTML('beforeend', ' <span class="ev-pill gap">Gap</span>');
        if (!gap && pill) pill.remove();
        prog();
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('textarea[data-n]'), function (t) { t.oninput = function () { R.notes[t.dataset.n] = t.value; }; });
    $('evStr').oninput = function () { R.strengths = this.value; };
    $('evFoc').oninput = function () { R.focus = this.value; prog(); };
    $('evOv').oninput = function () { R.overall = this.value; };
    $('evRb').oninput = function () { R.by = this.value; };
    prog();
    function submit(finish) {
      var bs = [$('evSave'), $('evFin')]; bs.forEach(function (b) { b.disabled = true; });
      setSender(R.by);
      api('admin_respond', { id: e.id, ratings: R.ratings, notes: R.notes, strengths: R.strengths, focus: R.focus, overall_note: R.overall, responded_by: R.by, finish: finish }).then(function (x) {
        bs.forEach(function (b) { b.disabled = false; });
        if (x.error) { toast(x.error, true); return; }
        if (finish) { toast(x.emailed ? 'Sent. ' + first(e.employee_name) + ' was emailed.' : 'Saved. Their link shows your response' + (e.employee_email ? '.' : ', so text them the link.')); detail(e.id); refreshList(); }
        else toast('Draft saved.');
      });
    }
    $('evSave').onclick = function () { submit(false); };
    $('evFin').onclick = function () { submit(true); };
  }
  function voidIt(e) {
    var m = modal('<h4>Void ' + esc(e.ref_no) + '?</h4><p class="ev-sub" style="margin:0 0 12px">It stays on file marked void and the link stops working.</p>' +
      '<div class="ev-f"><label class="ev-lbl">Reason</label><input class="ev-in" id="vR" placeholder="e.g. Sent the wrong role"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="ev-btn sec" id="vX">Cancel</button><button class="ev-btn danger" id="vGo">Void it</button></div>');
    m.querySelector('#vX').onclick = function () { m.remove(); };
    m.querySelector('#vGo').onclick = function () { api('admin_void', { id: e.id, reason: m.querySelector('#vR').value }).then(function (r) { m.remove(); toast(r.error || 'Voided.', !!r.error); detail(e.id); refreshList(); }); };
  }

  /* ---------- boot ---------- */
  window.StaffEvalsUI = { open: function () { window.switchTab('staffevals'); }, detail: detail };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._ev) {
      window.switchTab = function (name) {
        var out = orig.apply(this, arguments);
        if (name === 'staffevals') show();
        return out;
      };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._ev = true;
    }
    var item = document.querySelector('.sb-nav-item[data-tab="staffevals"]');
    if (item && !item._evBound) { item._evBound = true; item.addEventListener('click', function () { window.switchTab('staffevals'); }); }
    if (tok()) refreshList();
  }
  // After Write-Ups (500 ms) and Training Tests (700 ms) so we land under them in Team.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 900); });
  else setTimeout(boot, 900);
})();
