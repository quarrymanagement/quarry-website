/* ============================================================================
 * The Quarry — Admin "Floor Evals" (manager floor observations)
 * Self-injecting: adds "Team › Floor Evals" to the sidebar + #floorevalsTab.
 * Loaded from admin/index.html with <script src="./floor-evals-admin.js"></script>.
 *
 * Backend: Supabase edge function `floor-observations` (project nkulhtalltbieicvmmad).
 * Tables server_observations / server_observation_audit are service-role only.
 * Login allowed: owner (other roles never see the tab; the function refuses them).
 *
 *   Drafts     every new note starts here. Tick and "Approve & send": each
 *              person gets ONE private email (new notes on top, scoreboard,
 *              full history, Acknowledge link).
 *   People     per-person scoreboard + repeat flags (3+ fixes in one category
 *              inside 30 days). Tap someone: their full history next to their
 *              self-evaluations, edit comments, mark for next week.
 *   Follow-ups marked notes come back the following week with full history.
 *              The weekly job does it on its own (production only); this view
 *              shows what's due and can send now.
 * ==========================================================================*/
(function () {
  'use strict';

  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/floor-observations';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';
  var TAB = 'floorevals';
  var META = null, ROSTER = null, LIST = [], PEOPLE = [], VIEW = 'drafts', PERSON = null;
  var SEL = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function tok() { return localStorage.getItem('quarryAdminToken') || ''; }
  function api(action, extra) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: 'Bearer ' + KEY, 'x-admin-token': tok() },
      body: JSON.stringify(Object.assign({ action: action, actor: me() }, extra || {}))
    }).then(function (r) { return r.json().catch(function () { return { error: 'Bad response (' + r.status + ')' }; }); })
      .catch(function (e) { return { error: e.message || 'Network error' }; });
  }
  function me() { try { return localStorage.getItem('feBy') || localStorage.getItem('evSentBy') || ''; } catch (_) { return ''; } }
  function setMe(v) { try { if (v) localStorage.setItem('feBy', v); } catch (_) {} }
  function day(d) { return d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '—'; }
  function stamp(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }) + ' CT' : '—'; }
  function cat(k) { return (META && META.categories[k]) || k; }
  function toast(msg, bad) {
    Array.prototype.forEach.call(document.querySelectorAll('.fe-toast'), function (o) { o.remove(); });
    var t = document.createElement('div'); t.className = 'fe-toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3600);
  }
  function modal(html) {
    var m = document.createElement('div'); m.className = 'fe-modal'; m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m); return m;
  }

  /* ---------- styles ---------- */
  function injectStyles() {
    if ($('feStyles')) return;
    var css = '' +
      '.fe-panel{padding-bottom:70px;}' +
      '.fe-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;}' +
      '.fe-panel h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '.fe-sub{color:var(--text-muted);font-size:13px;margin-top:4px;max-width:640px;}' +
      '.fe-tabs{display:flex;border:1px solid var(--border-medium);border-radius:10px;overflow:hidden;margin-bottom:14px;max-width:520px;}' +
      '.fe-tabs button{flex:1;border:0;background:var(--bg-card);padding:11px 10px;font:600 13.5px var(--font-sans);cursor:pointer;color:var(--text-secondary);white-space:nowrap;}' +
      '.fe-tabs button+button{border-left:1px solid var(--border-medium);} .fe-tabs button.on{background:#2C1A0E;color:#fff;}' +
      '.fe-btn{background:#2C1A0E;color:#fff;border:0;border-radius:9px;padding:11px 16px;font-weight:600;font-size:14px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;min-height:42px;}' +
      '.fe-btn:disabled{opacity:.45;cursor:not-allowed;} .fe-btn.gold{background:var(--gold);} .fe-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.fe-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .fe-btn.sm{padding:7px 11px;font-size:12.5px;min-height:34px;}' +
      '.fe-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:16px 18px;margin-bottom:12px;}' +
      '.fe-card h3{margin:0 0 10px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.fe-item{border:1px solid var(--border-subtle);border-left:5px solid #3a9a5b;border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--bg-card);}' +
      '.fe-item.fix{border-left-color:#c0392b;} .fe-item.voided{opacity:.5;}' +
      '.fe-item .top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12.5px;color:var(--text-muted);margin-bottom:5px;}' +
      '.fe-item .who{font-weight:700;color:var(--text-primary);font-size:14.5px;}' +
      '.fe-item .note{font-size:14.5px;color:var(--text-primary);line-height:1.45;white-space:pre-wrap;}' +
      '.fe-item .cmt{margin-top:7px;font-size:13.5px;color:#5C3D2E;background:#fbf6ec;border-radius:8px;padding:8px 10px;white-space:pre-wrap;}' +
      '.fe-item .act{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}' +
      '.fe-sel{display:flex;gap:10px;align-items:flex-start;} .fe-sel input[type=checkbox]{width:22px;height:22px;margin-top:2px;flex:0 0 auto;}' +
      '.fe-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;}' +
      '.fe-pill.win{background:#dcf5e3;color:#176b34;} .fe-pill.fix{background:#fde4e1;color:#a52a1e;} .fe-pill.draft{background:#fff4d6;color:#8a5a00;}' +
      '.fe-pill.sent{background:#e8eefc;color:#2a4a9a;} .fe-pill.approved{background:#eef0f4;color:#4b5263;} .fe-pill.ack{background:#dcf5e3;color:#176b34;} .fe-pill.mark{background:#2C1A0E;color:#fff;} .fe-pill.rep{background:#a52a1e;color:#fff;} .fe-pill.test{background:#eee;color:#666;}' +
      '.fe-people{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}' +
      '.fe-person{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:14px;cursor:pointer;text-align:left;font-family:var(--font-sans);}' +
      '.fe-person.rep{border-color:#e2a59d;box-shadow:0 0 0 1px #e2a59d inset;}' +
      '.fe-person b{font-size:15px;color:var(--text-primary);} .fe-person .nums{display:flex;gap:14px;margin:8px 0 4px;font-size:13px;color:var(--text-muted);} .fe-person .nums span b{font-size:18px;margin-right:3px;}' +
      '.fe-score{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;}' +
      '.fe-score div{background:var(--bg-elevated);border-radius:10px;padding:12px;text-align:center;} .fe-score b{display:block;font-size:24px;color:var(--text-primary);} .fe-score span{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);}' +
      '.fe-flag{background:#fdeceb;border:1px solid #f1c4bf;color:#8f1f14;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-bottom:12px;}' +
      '.fe-split{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:14px;align-items:start;}' +
      '@media (max-width:900px){.fe-split{grid-template-columns:1fr;}}' +
      '.fe-in,.fe-ta,.fe-selbox{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--border-medium);border-radius:9px;font-size:16px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.fe-ta{min-height:84px;resize:vertical;line-height:1.45;}' +
      '.fe-lbl{display:block;font-size:12.5px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;} .fe-f{margin-bottom:12px;}' +
      '.fe-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;} @media (max-width:520px){.fe-row{grid-template-columns:1fr;}}' +
      '.fe-seg{display:flex;border:1px solid var(--border-medium);border-radius:9px;overflow:hidden;}' +
      '.fe-seg button{flex:1;border:0;background:#fff;padding:12px 0;font:700 14px var(--font-sans);cursor:pointer;color:var(--text-secondary);}' +
      '.fe-seg button+button{border-left:1px solid var(--border-medium);} .fe-seg button.on.win{background:#176b34;color:#fff;} .fe-seg button.on.fix{background:#a52a1e;color:#fff;}' +
      '.fe-check{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--text-primary);cursor:pointer;} .fe-check input{width:20px;height:20px;margin-top:1px;}' +
      '.fe-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:11px 13px;font-size:13px;color:#6b4e00;margin-bottom:12px;}' +
      '.fe-sticky{position:sticky;bottom:0;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;box-shadow:0 -6px 20px rgba(0,0,0,.06);z-index:2;}' +
      '.fe-ev{border-top:1px solid var(--border-subtle);padding:9px 0;font-size:13px;} .fe-ev:first-child{border-top:0;}' +
      '.fe-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:flex-end;justify-content:center;z-index:10000;padding:0;}' +
      '@media (min-width:700px){.fe-modal{align-items:center;padding:16px;}}' +
      '.fe-modal .box{background:#fff;border-radius:16px 16px 0 0;max-width:600px;width:100%;max-height:92vh;overflow:auto;padding:20px 18px calc(20px + env(safe-area-inset-bottom));box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '@media (min-width:700px){.fe-modal .box{border-radius:14px;padding:22px;}}' +
      '.fe-modal h4{margin:0 0 12px;font-family:var(--font-serif);font-size:1.35rem;}' +
      '.fe-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;max-width:90vw;}' +
      '.fe-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .fe-toast.bad{background:#a52a1e;}' +
      '@media (max-width:700px){.fe-panel h2{font-size:1.45rem;}}';
    var st = document.createElement('style'); st.id = 'feStyles'; st.textContent = css; document.head.appendChild(st);
  }

  /* ---------- nav + panel ---------- */
  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="' + TAB + '"]')) {
      var it = document.createElement('div'); it.className = 'sb-nav-item'; it.dataset.tab = TAB;
      it.innerHTML = '<span class="sb-ic">📝</span><span class="sb-lbl">Floor Evals</span><span id="feBadge" class="sb-badge" style="display:none;">0</span>';
      var anchor = nav.querySelector('[data-tab="staffevals"]') || nav.querySelector('[data-tab="writeups"]');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(it, anchor.nextSibling); else nav.appendChild(it);
    }
    var any = document.querySelector('.tab-content');
    if (!$(TAB + 'Tab') && any) { var d = document.createElement('div'); d.id = TAB + 'Tab'; d.className = 'tab-content fe-panel'; d.innerHTML = '<div id="feBody"></div>'; any.parentNode.appendChild(d); }
  }
  function badge() {
    var b = $('feBadge'); if (!b) return;
    var n = LIST.filter(function (o) { return o.status === 'draft'; }).length;
    b.textContent = n; b.style.display = n ? '' : 'none';
  }
  function load() {
    return Promise.all([META ? Promise.resolve(META) : api('admin_meta'), api('admin_list')]).then(function (r) {
      if (r[0] && !r[0].error) META = r[0];
      if (r[1] && !r[1].error) { LIST = r[1].observations || []; PEOPLE = r[1].people || []; }
      badge();
      return r[0].error || r[1].error || null;
    });
  }
  function roster() {
    if (ROSTER) return Promise.resolve(ROSTER);
    return api('admin_roster').then(function (r) { if (!r.error) ROSTER = r.roster || []; return ROSTER || []; });
  }

  function frame(inner) {
    var drafts = LIST.filter(function (o) { return o.status === 'draft'; }).length;
    var due = LIST.filter(function (o) { return o.marked && !o.followup_sent_at && o.status !== 'voided'; }).length;
    $('feBody').innerHTML =
      '<div class="fe-head"><div><h2>Floor Evals</h2><div class="fe-sub">Wins and fixes from the floor. Notes start as drafts; nothing reaches staff until you approve. ' +
      'Repeat flag = ' + (META ? META.repeat_rule.n : 3) + '+ fixes in one category within ' + (META ? META.repeat_rule.days : 30) + ' days.</div></div>' +
      '<button class="fe-btn gold" id="feAdd">+ Add note</button></div>' +
      (META && META.draft_site ? '<div class="fe-callout"><b>Draft site.</b> Real staff can\'t be emailed from here. Use <b>TEST Server</b> to try the flow (emails management@ only).</div>' : '') +
      '<div class="fe-tabs">' +
      '<button data-v="drafts" class="' + (VIEW === 'drafts' ? 'on' : '') + '">Drafts' + (drafts ? ' (' + drafts + ')' : '') + '</button>' +
      '<button data-v="people" class="' + (VIEW === 'people' || VIEW === 'person' ? 'on' : '') + '">People</button>' +
      '<button data-v="followups" class="' + (VIEW === 'followups' ? 'on' : '') + '">Follow-ups' + (due ? ' (' + due + ')' : '') + '</button></div>' +
      '<div id="feView">' + inner + '</div>';
    $('feAdd').onclick = function () { addNote(PERSON && VIEW === 'person' ? PERSON : null); };
    Array.prototype.forEach.call(document.querySelectorAll('.fe-tabs button'), function (b) {
      b.onclick = function () { VIEW = b.getAttribute('data-v'); PERSON = null; render(); };
    });
  }
  function show() {
    frame('<div class="fe-card" style="color:var(--text-muted)">Loading…</div>');
    load().then(function (err) { if (err) { frame('<div class="fe-callout">Couldn\'t load: ' + esc(err) + '</div>'); return; } render(); });
  }
  function render() {
    if (VIEW === 'person' && PERSON) return personView(PERSON);
    if (VIEW === 'people') return peopleView();
    if (VIEW === 'followups') return followupsView();
    return draftsView();
  }

  function item(o, opts) {
    opts = opts || {};
    var pills = '<span class="fe-pill ' + o.kind + '">' + (o.kind === 'win' ? 'WIN' : 'FIX') + '</span>' +
      '<span>' + esc(cat(o.category)) + '</span><span>· ' + esc(day(o.observed_on)) + (o.shift ? ' · ' + esc(o.shift) : '') + '</span>' +
      (o.observed_by ? '<span>· by ' + esc(o.observed_by) + '</span>' : '') +
      (opts.status ? ' <span class="fe-pill ' + (o.acknowledged_at ? 'ack' : o.status) + '">' + (o.status === 'sent' ? (o.acknowledged_at ? 'Acknowledged' : 'Sent') : o.status === 'approved' ? 'Approved, not emailed' : o.status === 'voided' ? 'Void' : 'Draft') + '</span>' : '') +
      (o.marked ? ' <span class="fe-pill mark">' + (o.followup_sent_at ? 'Followed up' : 'Marked · due ' + esc(day(o.followup_due_on))) + '</span>' : '') +
      (o.is_test ? ' <span class="fe-pill test">TEST</span>' : '');
    var who = opts.who ? '<div class="who">' + esc(o.employee_name) + '</div>' : '';
    var body = '<div class="top">' + pills + '</div><div class="note">' + esc(o.note) + '</div>' + (o.comment ? '<div class="cmt"><b>Comment:</b> ' + esc(o.comment) + '</div>' : '');
    var act = '';
    if (opts.actions && o.status !== 'voided') {
      act = '<div class="act">' +
        '<button class="fe-btn sec sm" data-edit="' + o.id + '">' + (o.status === 'draft' ? 'Edit' : 'Comment / mark') + '</button>' +
        '<button class="fe-btn sec sm" data-mark="' + o.id + '">' + (o.marked ? 'Unmark' : 'Mark for next week') + '</button>' +
        (o.status === 'draft' || o.is_test ? '<button class="fe-btn danger sm" data-del="' + o.id + '">Delete</button>' : '<button class="fe-btn danger sm" data-void="' + o.id + '">Void</button>') +
        '</div>';
    }
    var inner = who + body + act;
    if (opts.select) inner = '<label class="fe-sel"><input type="checkbox" data-pick="' + o.id + '"' + (SEL[o.id] ? ' checked' : '') + '><div style="flex:1;min-width:0">' + inner + '</div></label>';
    return '<div class="fe-item ' + o.kind + (o.status === 'voided' ? ' voided' : '') + '">' + inner + '</div>';
  }
  function bindItems(root, after) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-edit]'), function (b) { b.onclick = function (e) { e.preventDefault(); editNote(find(b.getAttribute('data-edit')), after); }; });
    Array.prototype.forEach.call(root.querySelectorAll('[data-mark]'), function (b) {
      b.onclick = function (e) {
        e.preventDefault(); var o = find(b.getAttribute('data-mark'));
        api('admin_update', { id: o.id, marked: !o.marked }).then(function (r) { toast(r.error || (o.marked ? 'Unmarked.' : 'Marked. It goes back to them next week with their history.'), !!r.error); after(); });
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function (e) { e.preventDefault(); if (!confirm('Delete this draft?')) return; api('admin_delete', { id: b.getAttribute('data-del') }).then(function (r) { toast(r.error || 'Deleted.', !!r.error); after(); }); };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-void]'), function (b) {
      b.onclick = function (e) {
        e.preventDefault(); var why = prompt('Void this note? It disappears from their history. Reason (optional):'); if (why === null) return;
        api('admin_void', { id: b.getAttribute('data-void'), reason: why }).then(function (r) { toast(r.error || 'Voided.', !!r.error); after(); });
      };
    });
  }
  var PCACHE = {};
  function find(id) { return LIST.concat(PCACHE.observations || []).filter(function (o) { return o.id === id; })[0]; }

  /* ---------- Drafts ---------- */
  function draftsView() {
    var d = LIST.filter(function (o) { return o.status === 'draft'; });
    Object.keys(SEL).forEach(function (k) { if (!d.some(function (o) { return o.id === k; })) delete SEL[k]; });
    var h = d.length ? d.map(function (o) { return item(o, { who: true, select: true, actions: true }); }).join('')
      : '<div class="fe-card" style="color:var(--text-muted)">No drafts waiting. Tap <b>+ Add note</b> after a shift.</div>';
    var n = Object.keys(SEL).length;
    if (d.length) h += '<div class="fe-sticky"><label class="fe-check"><input type="checkbox" id="feAll"' + (n === d.length ? ' checked' : '') + '> Select all</label>' +
      '<button class="fe-btn gold" id="feApprove"' + (n ? '' : ' disabled') + '>Approve &amp; send' + (n ? ' (' + n + ')' : '') + '</button></div>';
    frame(h);
    var v = $('feView');
    Array.prototype.forEach.call(v.querySelectorAll('[data-pick]'), function (c) { c.onchange = function () { if (c.checked) SEL[c.getAttribute('data-pick')] = 1; else delete SEL[c.getAttribute('data-pick')]; draftsView(); }; });
    if ($('feAll')) $('feAll').onchange = function () { SEL = {}; if (this.checked) d.forEach(function (o) { SEL[o.id] = 1; }); draftsView(); };
    if ($('feApprove')) $('feApprove').onclick = approve;
    bindItems(v, show);
  }
  function approve() {
    var ids = Object.keys(SEL); if (!ids.length) return;
    var people = {}; LIST.forEach(function (o) { if (SEL[o.id]) people[o.employee_name] = (people[o.employee_name] || 0) + 1; });
    var names = Object.keys(people);
    var m = modal('<h4>Approve &amp; send?</h4><p style="font-size:14px;color:#555;margin:0 0 10px">Each person gets one private email with these notes on top, their scoreboard, their full history and an Acknowledge link.</p>' +
      '<div style="font-size:14px;margin-bottom:14px">' + names.map(function (n) { return '<div>• <b>' + esc(n) + '</b> (' + people[n] + ' note' + (people[n] > 1 ? 's' : '') + ')</div>'; }).join('') + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="fe-btn sec" id="apX">Cancel</button><button class="fe-btn gold" id="apGo">Approve &amp; send</button></div>');
    m.querySelector('#apX').onclick = function () { m.remove(); };
    m.querySelector('#apGo').onclick = function () {
      this.disabled = true; this.textContent = 'Sending…';
      api('admin_approve', { ids: ids }).then(function (r) {
        if (r.error) { m.remove(); toast(r.error, true); return; }
        SEL = {};
        var res = (r.results || []).map(function (x) {
          if (x.error) return '<div class="fe-ev">⚠️ <b>' + esc(x.name) + '</b>: ' + esc(x.error) + '</div>';
          if (x.emailed) return '<div class="fe-ev">✅ <b>' + esc(x.name) + '</b>: emailed.</div>';
          return '<div class="fe-ev">⚠️ <b>' + esc(x.name) + '</b>: approved, but ' + (x.note ? esc(x.note) : 'the email didn\'t send.') + (x.link ? '<br><input class="fe-in" readonly value="' + esc(x.link) + '" onclick="this.select()" style="margin-top:6px;font-size:13px">' : '') + '</div>';
        }).join('');
        m.querySelector('.box').innerHTML = '<h4>Done</h4>' + res + '<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="fe-btn" id="apOk">OK</button></div>';
        m.querySelector('#apOk').onclick = function () { m.remove(); };
        show();
      });
    };
  }

  /* ---------- People ---------- */
  function peopleView() {
    if (!PEOPLE.length) { frame('<div class="fe-card" style="color:var(--text-muted)">No notes yet.</div>'); return; }
    var h = '<div class="fe-people">' + PEOPLE.map(function (p) {
      return '<button class="fe-person' + (p.repeats.length ? ' rep' : '') + '" data-ref="' + esc(p.ref) + '"><b>' + esc(p.name) + '</b>' +
        '<div class="nums"><span><b style="color:#176b34">' + p.wins + '</b>wins</span><span><b style="color:#a52a1e">' + p.fixes + '</b>fixes</span>' + (p.drafts ? '<span><b>' + p.drafts + '</b>drafts</span>' : '') + '</div>' +
        (p.repeats.length ? p.repeats.map(function (x) { return '<span class="fe-pill rep">Repeat: ' + esc(x.label) + ' ×' + x.count + '</span> '; }).join('') : '<span style="font-size:12px;color:var(--text-muted)">Last note ' + esc(day(p.last_on)) + '</span>') +
        '</button>';
    }).join('') + '</div>';
    frame(h);
    Array.prototype.forEach.call(document.querySelectorAll('.fe-person'), function (b) { b.onclick = function () { VIEW = 'person'; PERSON = { ref: b.getAttribute('data-ref'), name: b.querySelector('b').textContent }; render(); }; });
  }
  function avg(o) { var v = Object.keys(o || {}).map(function (k) { return o[k]; }).filter(function (x) { return typeof x === 'number'; }); return v.length ? (v.reduce(function (a, b) { return a + b; }, 0) / v.length).toFixed(1) : '—'; }
  function personView(p) {
    frame('<div class="fe-card" style="color:var(--text-muted)">Loading ' + esc(p.name) + '…</div>');
    api('admin_person', { ref: p.ref, name: p.name }).then(function (r) {
      if (r.error) { frame('<div class="fe-callout">' + esc(r.error) + '</div>'); return; }
      PCACHE = r;
      var sb = r.scoreboard;
      var waiting = r.observations.filter(function (o) { return o.status === 'approved'; }).length;
      var link = (r.observations.filter(function (o) { return o.link; })[0] || {}).link;
      var left = '<div class="fe-card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
        '<div><button class="fe-btn sec sm" id="feBack">← People</button></div><div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="fe-btn gold sm" id="feAddFor">+ Note for ' + esc(String(r.name).split(' ')[0]) + '</button></div></div>' +
        '<h2 style="font-size:1.5rem;margin:0 0 10px">' + esc(r.name) + '</h2>' +
        '<div class="fe-score"><div><b style="color:#176b34">' + sb.wins + '</b><span>Wins</span></div><div><b style="color:#a52a1e">' + sb.fixes + '</b><span>Fixes</span></div><div><b>' + sb.repeats.length + '</b><span>Repeating</span></div></div>' +
        (sb.repeats.length ? '<div class="fe-flag"><b>Repeat flag:</b> ' + sb.repeats.map(function (x) { return esc(x.label) + ' (' + x.count + ' fixes in ' + META.repeat_rule.days + ' days)'; }).join(', ') + '</div>' : '') +
        (r.has_email ? '' : '<div class="fe-callout">No email on file in Square for this person. Approved notes give you a link to text them.</div>') +
        (waiting ? '<div class="fe-callout">' + waiting + ' approved note(s) not emailed yet. <button class="fe-btn sm" id="feResend">Email them now</button></div>' : '') +
        (link ? '<div class="fe-f"><label class="fe-lbl">Their private page (text it if needed)</label><input class="fe-in" readonly value="' + esc(link) + '" onclick="this.select()" style="font-size:13px"></div>' : '') +
        '</div><div class="fe-card"><h3>History · newest first</h3>' +
        (r.observations.length ? r.observations.map(function (o) { return item(o, { status: true, actions: true }); }).join('') : '<div style="color:var(--text-muted)">No notes yet.</div>') + '</div>';
      var ev = (r.self_evals || []);
      var right = '<div class="fe-card"><h3>Self-evaluations</h3>' + (ev.length ? ev.map(function (e) {
        return '<div class="fe-ev"><b>' + esc(e.role_key) + '</b> · ' + esc(e.status) + (e.ref_no ? ' · #' + esc(e.ref_no) : '') +
          '<div style="color:var(--text-muted)">Sent ' + esc(stamp(e.sent_at)) + (e.submitted_at ? ' · self avg <b>' + avg(e.self_ratings) + '</b>' : '') + (e.responded_at ? ' · mgmt avg <b>' + avg(e.mgr_ratings) + '</b>' : '') + '</div>' +
          (e.focus ? '<div style="margin-top:4px"><b>30-day focus:</b> ' + esc(e.focus) + '</div>' : '') +
          (e.strengths ? '<div style="margin-top:2px"><b>Strengths:</b> ' + esc(e.strengths) + '</div>' : '') +
          (window.StaffEvalsUI ? '<button class="fe-btn sec sm" style="margin-top:6px" data-evopen="' + esc(e.id) + '">Open evaluation</button>' : '') + '</div>';
      }).join('') : '<div style="color:var(--text-muted);font-size:13px">No self-evaluations for this person yet.</div>') + '</div>' +
        '<div class="fe-card"><h3>Activity</h3>' + ((r.audit || []).slice(0, 15).map(function (a) { return '<div class="fe-ev">' + esc(stamp(a.created_at)) + ' · ' + esc(a.event) + (a.actor ? ' · ' + esc(a.actor) : '') + '</div>'; }).join('') || '<div style="color:var(--text-muted);font-size:13px">—</div>') + '</div>';
      frame('<div class="fe-split"><div>' + left + '</div><div>' + right + '</div></div>');
      $('feBack').onclick = function () { VIEW = 'people'; PERSON = null; render(); };
      $('feAddFor').onclick = function () { addNote({ ref: r.ref, name: r.name }); };
      if ($('feResend')) $('feResend').onclick = function () { api('admin_send_approved', { ref: r.ref }).then(function (x) { toast(x.error || (x.ok ? 'Emailed.' : 'Email failed.'), !x.ok); personView(p); }); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-evopen]'), function (b) { b.onclick = function () { window.switchTab('staffevals'); setTimeout(function () { window.StaffEvalsUI.detail(b.getAttribute('data-evopen')); }, 400); }; });
      bindItems($('feView'), function () { load().then(function () { personView(p); }); });
    });
  }

  /* ---------- Follow-ups ---------- */
  function followupsView() {
    var open = LIST.filter(function (o) { return o.marked && !o.followup_sent_at; }).sort(function (a, b) { return String(a.followup_due_on).localeCompare(String(b.followup_due_on)); });
    var done = LIST.filter(function (o) { return o.marked && o.followup_sent_at; }).slice(0, 20);
    var h = '<div class="fe-callout">Marked notes go back to the person the following week (observed date + 7 days) with their whole history. ' +
      'The weekly job sends them Monday mornings once it is switched on in production. Drafts and unsent notes wait until approved.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="fe-btn sec" id="feDry">Who\'s due now?</button><button class="fe-btn" id="feRun">Send due follow-ups now</button></div><div id="feDryOut"></div>' +
      '<div class="fe-card"><h3>Waiting · ' + open.length + '</h3>' + (open.length ? open.map(function (o) { return item(o, { who: true, status: true, actions: true }); }).join('') : '<div style="color:var(--text-muted)">Nothing marked.</div>') + '</div>' +
      (done.length ? '<div class="fe-card"><h3>Recently followed up</h3>' + done.map(function (o) { return item(o, { who: true, status: true }); }).join('') + '</div>' : '');
    frame(h);
    var out = function (r) {
      if (r.error) { toast(r.error, true); return; }
      $('feDryOut').innerHTML = '<div class="fe-card"><h3>' + esc(r.today) + '</h3>' + ((r.people || []).map(function (x) {
        return '<div class="fe-ev"><b>' + esc(x.name) + '</b>: ' + x.items + ' note(s) · ' + esc(x.skipped || (x.would_send ? 'would send' : x.sent ? 'sent' : 'failed')) + '</div>';
      }).join('') || '<div style="color:var(--text-muted)">Nobody due.</div>') + '</div>';
    };
    $('feDry').onclick = function () { api('admin_followups', { dry_run: true }).then(out); };
    $('feRun').onclick = function () { if (!confirm('Email everyone who has a follow-up due now?')) return; api('admin_followups', { dry_run: false }).then(function (r) { out(r); load(); }); };
    bindItems($('feView'), show);
  }

  /* ---------- Add / edit ---------- */
  function form(o, lockedPerson) {
    var cats = Object.keys(META.categories).map(function (k) { return '<option value="' + k + '"' + (o.category === k ? ' selected' : '') + '>' + esc(META.categories[k]) + '</option>'; }).join('');
    var shifts = '<option value="">—</option>' + META.shifts.map(function (s) { return '<option value="' + s + '"' + (o.shift === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>'; }).join('');
    var draft = !o.status || o.status === 'draft';
    return (lockedPerson ? '<div class="fe-f"><label class="fe-lbl">Who</label><div style="font-weight:700;font-size:16px">' + esc(lockedPerson.name) + '</div></div>'
        : '<div class="fe-f"><label class="fe-lbl">Who</label><input class="fe-in" id="fWhoQ" placeholder="Type a name…" autocomplete="off"><select class="fe-selbox" id="fWho" size="5" style="margin-top:6px;height:auto"><option>Loading roster…</option></select></div>') +
      (draft ? '<div class="fe-f"><div class="fe-seg" id="fKind"><button type="button" class="win' + (o.kind === 'win' ? ' on' : '') + '" data-k="win">👍 Win</button><button type="button" class="fix' + (o.kind === 'fix' ? ' on' : '') + '" data-k="fix">🔧 Fix</button></div></div>' +
        '<div class="fe-row"><div class="fe-f"><label class="fe-lbl">Category</label><select class="fe-selbox" id="fCat"><option value="">Pick one…</option>' + cats + '</select></div>' +
        '<div class="fe-f"><label class="fe-lbl">Date · shift</label><div style="display:flex;gap:6px"><input class="fe-in" type="date" id="fDate" value="' + esc(o.observed_on || META.today) + '" style="flex:1.4"><select class="fe-selbox" id="fShift" style="flex:1">' + shifts + '</select></div></div></div>' +
        '<div class="fe-f"><label class="fe-lbl">What you saw</label><textarea class="fe-ta" id="fNote" maxlength="4000" placeholder="Specific and short: what happened, which table, what it led to.">' + esc(o.note || '') + '</textarea></div>'
        : '<div class="fe-item ' + o.kind + '" style="margin-bottom:12px"><div class="top"><span class="fe-pill ' + o.kind + '">' + o.kind.toUpperCase() + '</span> ' + esc(cat(o.category)) + ' · ' + esc(day(o.observed_on)) + '</div><div class="note">' + esc(o.note) + '</div></div>') +
      '<div class="fe-f"><label class="fe-lbl">Comment (they see this)</label><textarea class="fe-ta" id="fCmt" maxlength="4000" placeholder="Coaching, what to try next time, or a thank-you.">' + esc(o.comment || '') + '</textarea></div>' +
      '<div class="fe-f"><label class="fe-check"><input type="checkbox" id="fMark"' + (o.marked ? ' checked' : '') + '><span><b>Mark for next week.</b> Sends this back to them the following week along with their history of notes and comments.</span></label></div>' +
      (draft ? '<div class="fe-f"><label class="fe-lbl">Observed by</label><input class="fe-in" id="fBy" value="' + esc(o.observed_by || me()) + '" placeholder="Your name" maxlength="60"></div>' : '');
  }
  function addNote(person) {
    var o = { kind: 'fix' };
    var m = modal('<h4>Add floor note</h4>' + form(o, person) + '<div class="fe-callout" style="margin:4px 0 12px">Saves as a <b>draft</b>. Nothing goes to the employee until it\'s approved.</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="fe-btn sec" id="fX">Cancel</button><button class="fe-btn gold" id="fGo">Save draft</button></div>');
    var kind = 'fix', chosen = person || null;
    Array.prototype.forEach.call(m.querySelectorAll('#fKind button'), function (b) { b.onclick = function () { kind = b.getAttribute('data-k'); Array.prototype.forEach.call(m.querySelectorAll('#fKind button'), function (x) { x.classList.toggle('on', x === b); }); }; });
    if (!person) {
      roster().then(function (list) {
        var sel = m.querySelector('#fWho'), q = m.querySelector('#fWhoQ');
        var draw = function () {
          var t = q.value.trim().toLowerCase();
          var hits = list.filter(function (p) { return !t || p.name.toLowerCase().indexOf(t) >= 0; });
          sel.innerHTML = hits.map(function (p) { return '<option value="' + esc(p.ref) + '">' + esc(p.name) + (p.jobs && p.jobs.length ? ' — ' + esc(p.jobs.slice(0, 2).join(', ')) : '') + (p.has_email ? '' : ' (no email)') + '</option>'; }).join('') || '<option disabled>No match</option>';
          if (chosen) sel.value = chosen.ref;
        };
        q.oninput = draw; draw();
        sel.onchange = function () { var p = list.filter(function (x) { return x.ref === sel.value; })[0]; chosen = p ? { ref: p.ref, name: p.name } : null; if (p) q.value = p.name; };
      });
    }
    m.querySelector('#fX').onclick = function () { m.remove(); };
    m.querySelector('#fGo').onclick = function () {
      var btn = this;
      if (!chosen) { toast('Pick who this is about.', true); return; }
      var body = { employee_ref: chosen.ref, employee_name: chosen.name, kind: kind, category: m.querySelector('#fCat').value, observed_on: m.querySelector('#fDate').value,
        shift: m.querySelector('#fShift').value, note: m.querySelector('#fNote').value, comment: m.querySelector('#fCmt').value, marked: m.querySelector('#fMark').checked, observed_by: m.querySelector('#fBy').value };
      if (!body.category) { toast('Pick a category.', true); return; }
      if (!body.note.trim()) { toast('Write what you saw.', true); return; }
      setMe(body.observed_by); btn.disabled = true;
      api('admin_create', body).then(function (r) {
        btn.disabled = false;
        if (r.error) { toast(r.error, true); return; }
        m.remove(); toast('Saved as a draft.');
        load().then(function () { if (VIEW === 'person' && PERSON) personView(PERSON); else { VIEW = VIEW === 'followups' ? VIEW : 'drafts'; render(); } });
      });
    };
  }
  function editNote(o, after) {
    if (!o) return;
    var draft = o.status === 'draft';
    var m = modal('<h4>' + (draft ? 'Edit draft' : 'Comment / mark') + ' · ' + esc(o.employee_name) + '</h4>' + form(o, { name: o.employee_name }) +
      (!draft ? '<div class="fe-callout" style="margin:4px 0 12px">Already sent. Comment changes show on their page and in the next email.</div>' : '') +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button class="fe-btn sec" id="fX">Cancel</button><button class="fe-btn gold" id="fGo">Save</button></div>');
    var kind = o.kind;
    Array.prototype.forEach.call(m.querySelectorAll('#fKind button'), function (b) { b.onclick = function () { kind = b.getAttribute('data-k'); Array.prototype.forEach.call(m.querySelectorAll('#fKind button'), function (x) { x.classList.toggle('on', x === b); }); }; });
    m.querySelector('#fX').onclick = function () { m.remove(); };
    m.querySelector('#fGo').onclick = function () {
      var body = { id: o.id, comment: m.querySelector('#fCmt').value, marked: m.querySelector('#fMark').checked };
      if (draft) { body.kind = kind; body.category = m.querySelector('#fCat').value; body.observed_on = m.querySelector('#fDate').value; body.shift = m.querySelector('#fShift').value; body.note = m.querySelector('#fNote').value; }
      api('admin_update', body).then(function (r) { if (r.error) { toast(r.error, true); return; } m.remove(); toast('Saved.'); (after || show)(); });
    };
  }

  /* ---------- boot ---------- */
  window.FloorEvalsUI = { open: function () { window.switchTab(TAB); } };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._fe) {
      window.switchTab = function (name) { var out = orig.apply(this, arguments); if (name === TAB) show(); return out; };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._fe = true;
    }
    var it = document.querySelector('.sb-nav-item[data-tab="' + TAB + '"]');
    if (it && !it._feBound) { it._feBound = true; it.addEventListener('click', function () { window.switchTab(TAB); }); }
    if (tok() && (localStorage.getItem('quarryAdminRole') || 'owner') === 'owner') load();
  }
  // After Evaluations (900 ms) so we land right under it in Team.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1100); });
  else setTimeout(boot, 1100);
})();
