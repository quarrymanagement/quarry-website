/* ============================================================================
 * The Quarry — Admin "Incidents" (incident reports + signed statements)
 * Self-injecting: adds "Team › Incidents" to the sidebar + #incidentsTab.
 * Loaded from admin/index.html after writeups-admin.js.
 *
 * Backend: Supabase edge function `incidents` (project nkulhtalltbieicvmmad).
 * Tables incidents / incident_statements / incident_audit are service-role only.
 * Logins allowed: owner + events_staff (Penny).
 *
 * Flow:  New incident (what, when, where, who, injuries, medical, police)
 *        → request statements: type name, email, phone → private link
 *          (emailed / texted / opened on this device)
 *        → each person writes and signs their own account on their phone
 *          at /incident-statement.html?t=<token> (they never see the
 *          manager's summary or anyone else's statement)
 *        → Download the full PDF (report + every statement + photos) for
 *          insurance → Close the incident.
 * ==========================================================================*/
(function () {
  'use strict';

  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/incidents';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';
  var META = null, LIST = [], filter = { status: 'open', q: '' };

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
  function fmtDate(d) { if (!d) return '—'; var dt = new Date(String(d).length <= 10 ? d + 'T12:00:00' : d); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function fmtStamp(d) { return d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  function nowTime() { return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }); }
  function toast(msg, bad) {
    Array.prototype.forEach.call(document.querySelectorAll('.ir-toast'), function (o) { o.remove(); });
    var t = document.createElement('div'); t.className = 'ir-toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3400);
  }
  function me() { try { return localStorage.getItem('irMe') || localStorage.getItem('ttSentBy') || ''; } catch (_) { return ''; } }
  function smsHref(phone, url, name) {
    var body = 'Hi ' + String(name || '').split(' ')[0] + ', please write your statement about what happened at The Quarry: ' + url;
    var sep = /iPhone|iPad|Mac/i.test(navigator.userAgent) ? '&' : '?';
    return 'sms:' + String(phone || '').replace(/[^\d+]/g, '') + sep + 'body=' + encodeURIComponent(body);
  }
  function copy(s, input) {
    (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('Link copied.'); })
      .catch(function () { if (input) { input.select(); document.execCommand('copy'); toast('Link copied.'); } });
  }
  function T(k) { return (META && META.types[k]) || k; }

  /* ---------- styles ---------- */
  function injectStyles() {
    if ($('irStyles')) return;
    var css = '' +
      '#incidentsTab{padding-bottom:60px;}' +
      '#incidentsTab .ir-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;}' +
      '#incidentsTab h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '#incidentsTab .ir-sub{color:var(--text-muted);font-size:13px;margin-top:4px;}' +
      '.ir-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;text-decoration:none;display:inline-block;}' +
      '.ir-btn:hover{filter:brightness(1.15);} .ir-btn:disabled{opacity:.45;cursor:not-allowed;}' +
      '.ir-btn.gold{background:var(--gold);} .ir-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.ir-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .ir-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.ir-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.ir-card h3{margin:0 0 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.ir-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px;}' +
      '.ir-stat{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:14px 16px;cursor:pointer;}' +
      '.ir-stat .n{font-size:26px;font-weight:700;color:var(--text-primary);} .ir-stat .l{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;}' +
      '.ir-stat.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}' +
      '.ir-in,.ir-sel,.ir-ta{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border-medium);border-radius:8px;font-size:14px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.ir-ta{min-height:84px;resize:vertical;line-height:1.45;}' +
      '.ir-in:focus,.ir-sel:focus,.ir-ta:focus{outline:2px solid rgba(154,123,42,.35);border-color:var(--gold);}' +
      '.ir-lbl{display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;} .ir-lbl .req{color:#b42318;}' +
      '.ir-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 14px;} .ir-f{margin-bottom:12px;}' +
      '.ir-hint{font-size:11.5px;color:var(--text-muted);margin-top:4px;}' +
      '.ir-check{display:flex;gap:8px;align-items:center;font-size:13.5px;margin:4px 0 12px;} .ir-check input{width:18px;height:18px;}' +
      '.ir-table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;}' +
      '.ir-table th,.ir-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;vertical-align:middle;}' +
      '.ir-table th{background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);}' +
      '.ir-table tr.click{cursor:pointer;} .ir-table tr.click:hover td{background:var(--bg-hover);}' +
      '.ir-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;}' +
      '.ir-pill.open{background:#fff4d6;color:#8a5a00;} .ir-pill.closed{background:#dcf5e3;color:#176b34;}' +
      '.ir-pill.requested{background:#eef0f4;color:#4b5263;} .ir-pill.submitted{background:#dcf5e3;color:#176b34;} .ir-pill.voided{background:#f1f1f1;color:#999;}' +
      '.ir-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 18px;}' +
      '.ir-kv div span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:2px;}' +
      '.ir-kv div b{font-size:14px;color:var(--text-primary);font-weight:600;}' +
      '.ir-txt-l{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin:12px 0 4px;}' +
      '.ir-txt{white-space:pre-wrap;font-size:14px;line-height:1.55;color:var(--text-primary);margin:0;}' +
      '.ir-stmt{border:1px solid var(--border-subtle);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--bg-card);}' +
      '.ir-stmt .top{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;}' +
      '.ir-stmt .q{font-size:12px;font-weight:700;color:var(--text-secondary);margin:12px 0 3px;}' +
      '.ir-stmt .a{white-space:pre-wrap;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;font-size:14px;line-height:1.5;}' +
      '.ir-photos{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;} .ir-photos a img{width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--border-subtle);}' +
      '.ir-actions{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.ir-link{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;} .ir-link input{flex:1;min-width:200px;font-size:12px;}' +
      '.ir-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b4e00;margin-bottom:14px;}' +
      '.ir-callout.ok{background:#ecf9f0;border-color:#b9e5c6;color:#176b34;}' +
      '.ir-audit{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;max-height:200px;overflow:auto;}' +
      '.ir-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}' +
      '.ir-modal .box{background:#fff;border-radius:14px;max-width:480px;width:100%;max-height:90vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '.ir-modal h4{margin:0 0 6px;font-family:var(--font-serif);font-size:1.3rem;}' +
      '.ir-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;}' +
      '.ir-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .ir-toast.bad{background:#a52a1e;}' +
      '@media (max-width:700px){.ir-table .hide-sm{display:none;} #incidentsTab h2{font-size:1.45rem;}}';
    var st = document.createElement('style'); st.id = 'irStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- nav + panel ---------- */
  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="incidents"]')) {
      var item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = 'incidents';
      item.innerHTML = '<span class="sb-ic">⚠️</span><span class="sb-lbl">Incidents</span><span id="irBadge" class="sb-badge" style="display:none;">0</span>';
      var wu = nav.querySelector('[data-tab="writeups"]');
      if (wu && wu.parentNode) wu.parentNode.insertBefore(item, wu.nextSibling);
      else {
        var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
        var grp = document.createElement('div'); grp.className = 'sb-nav-group'; grp.appendChild(item);
        var sys = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /system/i.test(s.textContent); });
        if (sys) { nav.insertBefore(sec, sys); nav.insertBefore(grp, sys); } else { nav.appendChild(sec); nav.appendChild(grp); }
      }
    }
    if (!$('incidentsTab')) {
      var any = document.querySelector('.tab-content');
      if (any) { var div = document.createElement('div'); div.id = 'incidentsTab'; div.className = 'tab-content'; div.innerHTML = '<div id="irBody"></div>'; any.parentNode.appendChild(div); }
    }
  }
  function loadMeta() {
    if (META) return Promise.resolve(META);
    return api('admin_meta').then(function (r) { if (!r.error) META = r; return META; });
  }

  /* ================= LIST ================= */
  var lastOpen = 0;
  function showList(force) {
    var body = $('irBody'); if (!body) return;
    if (!force && Date.now() - lastOpen < 400) return; lastOpen = Date.now();
    body.innerHTML = '<div class="ir-head"><div><h2>Incident Reports</h2><div class="ir-sub">Document what happened, collect signed statements from everyone who saw it, and keep one PDF for insurance.</div></div>' +
      '<button class="ir-btn gold" id="irNew">+ New incident</button></div><div id="irList"><div class="ir-card" style="color:var(--text-muted)">Loading…</div></div>';
    $('irNew').onclick = function () { showForm(null); };
    Promise.all([loadMeta(), api('admin_list')]).then(function (res) {
      var r = res[1];
      if (r.error) { $('irList').innerHTML = '<div class="ir-callout">' + esc(r.error) + '</div>'; return; }
      LIST = r.incidents || []; updateBadge(); renderList();
    });
  }
  function updateBadge() {
    var n = LIST.filter(function (i) { return i.status === 'open'; }).length;
    var b = $('irBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  }
  function renderList() {
    var c = { open: 0, waiting: 0, closed: 0, all: LIST.length };
    LIST.forEach(function (i) { if (i.status === 'open') c.open++; else c.closed++; if (i.status === 'open' && i.pending) c.waiting++; });
    var stats = [['open', 'Open'], ['waiting', 'Waiting on statements'], ['closed', 'Closed'], ['all', 'All on file']];
    var h = '<div class="ir-stats">' + stats.map(function (s) { return '<div class="ir-stat' + (filter.status === s[0] ? ' on' : '') + '" data-f="' + s[0] + '"><div class="n">' + c[s[0]] + '</div><div class="l">' + s[1] + '</div></div>'; }).join('') + '</div>';
    h += '<div style="margin-bottom:12px"><input class="ir-in" id="irQ" placeholder="Search ref #, person, location" style="max-width:340px" value="' + esc(filter.q) + '"></div>';
    var q = filter.q.trim().toLowerCase();
    var rows = LIST.filter(function (i) {
      if (filter.status === 'open' && i.status !== 'open') return false;
      if (filter.status === 'waiting' && !(i.status === 'open' && i.pending)) return false;
      if (filter.status === 'closed' && i.status !== 'closed') return false;
      if (q && [i.ref_no, i.injured_name, i.location, T(i.incident_type)].join(' ').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (!rows.length) h += '<div class="ir-card" style="color:var(--text-muted);text-align:center;padding:34px;">' + (LIST.length ? 'Nothing in this list.' : 'No incidents on file. When something happens, click <b>+ New incident</b> right away while details are fresh.') + '</div>';
    else {
      h += '<table class="ir-table"><thead><tr><th>Ref</th><th>What</th><th>When</th><th class="hide-sm">Where</th><th>Statements</th><th>Status</th></tr></thead><tbody>';
      rows.forEach(function (i) {
        h += '<tr class="click" data-id="' + i.id + '"><td style="font-family:ui-monospace,monospace;font-size:12px">' + esc(i.ref_no) + '</td>' +
          '<td><b>' + esc(T(i.incident_type)) + '</b>' + (i.injured_name ? '<div style="font-size:11.5px;color:var(--text-muted)">' + esc(i.injured_name) + '</div>' : '') + '</td>' +
          '<td>' + fmtDate(i.incident_date) + (i.incident_time ? '<div style="font-size:11.5px;color:var(--text-muted)">' + esc(i.incident_time) + '</div>' : '') + '</td>' +
          '<td class="hide-sm">' + esc(i.location || '') + '</td>' +
          '<td>' + i.submitted + ' in' + (i.pending ? ' · <span style="color:#8a5a00;font-weight:600">' + i.pending + ' waiting</span>' : '') + '</td>' +
          '<td><span class="ir-pill ' + i.status + '">' + (i.status === 'open' ? 'Open' : 'Closed') + '</span></td></tr>';
      });
      h += '</tbody></table>';
    }
    $('irList').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#irList .ir-stat'), function (el) { el.onclick = function () { filter.status = el.dataset.f; renderList(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('#irList tr.click'), function (el) { el.onclick = function () { showDetail(el.dataset.id); }; });
    var qi = $('irQ'); qi.oninput = function () { filter.q = qi.value; var p = qi.selectionStart; renderList(); var n = $('irQ'); n.focus(); n.setSelectionRange(p, p); };
  }

  /* ================= FORM ================= */
  function opts(map, sel, blank) {
    return (blank ? '<option value="">' + esc(blank) + '</option>' : '') + Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>'; }).join('');
  }
  function showForm(inc) {
    loadMeta().then(function () {
      if (!META) { $('irBody').innerHTML = '<div class="ir-callout">Could not reach the incidents service. Log out and back in, then try again.</div>'; return; }
      inc = inc || {};
      var v = function (k, d) { return esc(inc[k] != null ? inc[k] : (d || '')); };
      var h = '<button class="ir-btn sec sm" id="irBack" style="margin-bottom:14px;">← Back</button>' +
        '<div class="ir-head"><div><h2>' + (inc.id ? 'Edit ' + esc(inc.ref_no) : 'New incident') + '</h2><div class="ir-sub">Facts only. Write it while it\'s fresh — you can come back and add to it.</div></div></div>' +
        '<div class="ir-card"><h3>What and when</h3><div class="ir-grid">' +
        '<div class="ir-f"><label class="ir-lbl">Type <span class="req">*</span></label><select class="ir-sel" id="f_incident_type">' + opts(META.types, inc.incident_type || 'guest_injury') + '</select></div>' +
        '<div class="ir-f"><label class="ir-lbl">Date <span class="req">*</span></label><input class="ir-in" type="date" id="f_incident_date" value="' + v('incident_date', today()) + '"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Time</label><input class="ir-in" id="f_incident_time" value="' + v('incident_time', inc.id ? '' : nowTime()) + '" placeholder="e.g. 7:40 PM"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Exact location</label><input class="ir-in" id="f_location" value="' + v('location') + '" placeholder="e.g. Patio steps by the double doors"></div>' +
        '</div><div class="ir-f"><label class="ir-lbl">What happened</label><textarea class="ir-ta" id="f_summary" style="min-height:120px" placeholder="Who, what, when, where — in order. What you saw yourself vs. what you were told.">' + v('summary') + '</textarea></div>' +
        '<div class="ir-f"><label class="ir-lbl">Conditions at the scene</label><textarea class="ir-ta" id="f_conditions" placeholder="Floor wet or dry, lighting, signage, weather, anything on the ground. Take photos.">' + v('conditions') + '</textarea></div></div>' +

        '<div class="ir-card"><h3>Person injured or involved</h3><div class="ir-grid">' +
        '<div class="ir-f"><label class="ir-lbl">Name</label><input class="ir-in" id="f_injured_name" value="' + v('injured_name') + '"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Phone / email</label><input class="ir-in" id="f_injured_contact" value="' + v('injured_contact') + '"></div>' +
        '<div class="ir-f"><label class="ir-lbl">They are a</label><select class="ir-sel" id="f_injured_role">' + opts({ guest: 'Guest', employee: 'Employee', vendor: 'Vendor / contractor', other: 'Other' }, inc.injured_role || 'guest') + '</select></div>' +
        '<div class="ir-f"><label class="ir-lbl">Medical response</label><select class="ir-sel" id="f_medical_response">' + opts(META.medical, inc.medical_response || '', 'Choose…') + '</select></div>' +
        '</div><div class="ir-f"><label class="ir-lbl">Injury details</label><textarea class="ir-ta" id="f_injury_details" placeholder="What they said hurt, what you could see. Don\'t diagnose.">' + v('injury_details') + '</textarea></div>' +
        '<div class="ir-f"><label class="ir-lbl">Everyone else involved or nearby</label><textarea class="ir-ta" id="f_people_involved" placeholder="Staff on shift nearby, guests at the table, anyone who helped.">' + v('people_involved') + '</textarea></div></div>' +

        '<div class="ir-card"><h3>Response</h3>' +
        '<div class="ir-f"><label class="ir-lbl">Actions taken</label><textarea class="ir-ta" id="f_actions_taken" placeholder="First aid, cleaned the spill, blocked the area, offered to call EMS, comped the meal…">' + v('actions_taken') + '</textarea></div>' +
        '<label class="ir-check"><input type="checkbox" id="f_police_called"' + (inc.police_called ? ' checked' : '') + '> Police were called</label>' +
        '<div class="ir-grid"><div class="ir-f"><label class="ir-lbl">Police report #</label><input class="ir-in" id="f_police_report_no" value="' + v('police_report_no') + '"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Reported by</label><input class="ir-in" id="f_reported_by" value="' + v('reported_by', me()) + '" placeholder="Manager on duty"></div></div>' +
        '<div class="ir-f"><label class="ir-lbl">Follow-up</label><textarea class="ir-ta" id="f_follow_up" placeholder="Called the guest next day, fixed the step, notified insurance (Gary)…">' + v('follow_up') + '</textarea></div>' +
        '<label class="ir-check"><input type="checkbox" id="f_insurance_notified"' + (inc.insurance_notified ? ' checked' : '') + '> Insurance has been notified</label>' +
        '<div class="ir-callout" style="margin:8px 0 0">Don\'t admit fault or promise to pay for anything in writing or to the guest. Stick to facts, be kind, and let management handle the rest.</div></div>' +

        '<div class="ir-card" style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;"><button class="ir-btn gold" id="irSave">' + (inc.id ? 'Save changes' : 'Save incident') + '</button></div>';
      $('irBody').innerHTML = h;
      $('irBack').onclick = function () { inc.id ? showDetail(inc.id) : showList(true); };
      $('irSave').onclick = function () {
        var f = {};
        ['incident_type', 'incident_date', 'incident_time', 'location', 'summary', 'conditions', 'injured_name', 'injured_contact', 'injured_role', 'medical_response',
          'injury_details', 'people_involved', 'actions_taken', 'police_report_no', 'reported_by', 'follow_up'].forEach(function (k) { f[k] = $('f_' + k).value.trim(); });
        f.police_called = $('f_police_called').checked; f.insurance_notified = $('f_insurance_notified').checked;
        if (!f.incident_date) { toast('Pick the date.', true); return; }
        try { if (f.reported_by) localStorage.setItem('irMe', f.reported_by); } catch (_) {}
        var b = this; b.disabled = true;
        api('admin_save', { id: inc.id || null, fields: f }).then(function (r) {
          b.disabled = false;
          if (r.error) { toast(r.error, true); return; }
          toast(inc.id ? 'Saved.' : 'Incident saved · ' + r.ref_no + '. Now request statements.');
          showDetail(r.id);
        });
      };
    });
  }

  /* ================= DETAIL ================= */
  function modal(html) {
    var m = document.createElement('div'); m.className = 'ir-modal'; m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m); return m;
  }
  function kv(k, v) { return '<div><span>' + esc(k) + '</span><b>' + esc(v || '—') + '</b></div>'; }
  function txt(k, v) { return v ? '<div class="ir-txt-l">' + esc(k) + '</div><p class="ir-txt">' + esc(v) + '</p>' : ''; }

  function showDetail(id) {
    $('irBody').innerHTML = '<div class="ir-card" style="color:var(--text-muted)">Loading…</div>';
    Promise.all([loadMeta(), api('admin_get', { id: id })]).then(function (res) {
      var r = res[1];
      if (r.error) { $('irBody').innerHTML = '<div class="ir-callout">' + esc(r.error) + '</div>'; return; }
      var i = r.incident, st = r.statements || [];
      var sub = st.filter(function (s) { return s.status === 'submitted'; }), wait = st.filter(function (s) { return s.status === 'requested'; });
      var h = '<button class="ir-btn sec sm" id="irBack" style="margin-bottom:14px;">← All incidents</button>' +
        '<div class="ir-head"><div><h2>' + esc(T(i.incident_type)) + '</h2><div class="ir-sub">' + esc(i.ref_no) + ' · ' + fmtDate(i.incident_date) + (i.incident_time ? ' · ' + esc(i.incident_time) : '') +
        (i.location ? ' · ' + esc(i.location) : '') + ' · <span class="ir-pill ' + i.status + '">' + (i.status === 'open' ? 'Open' : 'Closed') + '</span></div></div><div class="ir-actions" id="irAct"></div></div>';

      h += '<div class="ir-card"><h3>Statements · ' + sub.length + ' in' + (wait.length ? ', ' + wait.length + ' waiting' : '') + '</h3>' +
        '<div class="ir-grid">' +
        '<div class="ir-f"><label class="ir-lbl">Name <span class="req">*</span></label><input class="ir-in" id="sName" autocomplete="off"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Email</label><input class="ir-in" id="sEmail" type="email" autocomplete="off"></div>' +
        '<div class="ir-f"><label class="ir-lbl">Phone</label><input class="ir-in" id="sPhone" type="tel" autocomplete="off"></div>' +
        '<div class="ir-f"><label class="ir-lbl">They are a</label><select class="ir-sel" id="sRole">' + opts({ employee: 'Employee', witness: 'Guest / witness', manager: 'Manager', injured: 'Injured person' }, 'employee') + '</select></div></div>' +
        '<div class="ir-actions"><button class="ir-btn gold" id="sGo">Request statement</button><button class="ir-btn sec" id="sHere">Write it on this device now</button></div>' +
        '<div class="ir-hint">Email → we send the link. Phone → text it from your phone. "On this device" opens the form here so they can write it before they leave.</div></div>';

      if (!st.length) h += '<div class="ir-callout">No statements yet. Get one from everyone who saw it — staff and guests — the same day if you can.</div>';
      st.forEach(function (s) {
        h += '<div class="ir-stmt"><div class="top"><div><b>' + esc(s.person_name) + '</b> <span style="color:var(--text-muted);font-size:12.5px">' + esc(s.person_role || '') +
          (s.person_email ? ' · ' + esc(s.person_email) : '') + (s.person_phone ? ' · ' + esc(s.person_phone) : '') + '</span></div>' +
          '<span class="ir-pill ' + s.status + '">' + (s.status === 'submitted' ? 'Signed ' + fmtStamp(s.submitted_at) : s.status === 'voided' ? 'Withdrawn' : (s.opened_at ? 'Opened, not submitted' : 'Requested ' + fmtStamp(s.requested_at))) + '</span></div>';
        if (s.status === 'requested') {
          h += '<div class="ir-link"><input class="ir-in" readonly value="' + esc(s.link) + '" id="lk_' + s.id + '"><button class="ir-btn sec sm" data-copy="' + s.id + '">Copy</button>' +
            (s.person_phone ? '<a class="ir-btn sec sm" href="' + esc(smsHref(s.person_phone, s.link, s.person_name)) + '">Text</a>' : '') +
            (s.person_email ? '<button class="ir-btn sec sm" data-remind="' + s.id + '">Re-send email</button>' : '') +
            '<button class="ir-btn sec sm" data-here="' + esc(s.link) + '">Open here</button><button class="ir-btn danger sm" data-void="' + s.id + '">Withdraw</button></div>';
        }
        if (s.status === 'submitted') {
          var a = s.answers || {};
          h += '<div class="q">' + esc((META.seen || {})[a.seen] || '') + '</div>';
          (META.questions || []).forEach(function (q) { if (a[q.id]) h += '<div class="q">' + esc(q.label) + '</div><div class="a">' + esc(a[q.id]) + '</div>'; });
          if ((s.photo_urls || []).length) h += '<div class="ir-photos">' + s.photo_urls.map(function (p) { return '<a href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.url) + '" alt="Photo"></a>'; }).join('') + '</div>';
          if (s.signature) h += '<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">Signed: ' + esc(s.signed_name) + '</div><img src="' + s.signature + '" alt="" style="height:54px;background:#fffdf8;border:1px solid var(--border-subtle);border-radius:8px;margin-top:4px">';
        }
        h += '</div>';
      });

      h += '<div class="ir-card"><h3>Incident details</h3><div class="ir-kv">' +
        kv('Person injured / involved', [i.injured_name, i.injured_role].filter(Boolean).join(' · ')) + kv('Their contact', i.injured_contact) +
        kv('Medical response', (META.medical || {})[i.medical_response]) + kv('Police', i.police_called ? 'Called' + (i.police_report_no ? ' · ' + i.police_report_no : '') : 'Not called') +
        kv('Reported by', i.reported_by) + kv('Insurance notified', i.insurance_notified ? 'Yes' : 'No') + '</div>' +
        txt('What happened', i.summary) + txt('Conditions at the scene', i.conditions) + txt('Injury details', i.injury_details) +
        txt('People involved', i.people_involved) + txt('Actions taken', i.actions_taken) + txt('Follow-up', i.follow_up) + '</div>';

      h += '<div class="ir-card"><h3>Activity</h3><div class="ir-audit">' + (r.audit || []).map(function (x) { return '<div>' + fmtStamp(x.created_at) + ' · <b>' + esc(String(x.event).replace(/_/g, ' ').toUpperCase()) + '</b> · ' + esc(x.actor || '') + (x.ip ? ' · IP ' + esc(x.ip) : '') + '</div>'; }).join('') + '</div></div>';
      $('irBody').innerHTML = h;

      $('irBack').onclick = function () { showList(true); };
      function request(here) {
        var f = { person_name: $('sName').value.trim(), person_email: $('sEmail').value.trim(), person_phone: $('sPhone').value.trim(), person_role: $('sRole').value, requested_by: me() };
        if (!f.person_name) { toast('Type their name.', true); $('sName').focus(); return; }
        if (f.person_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.person_email)) { toast('That email doesn\'t look right.', true); return; }
        var win = here ? window.open('about:blank', '_blank') : null;
        api('admin_request', { id: i.id, fields: f, no_email: here }).then(function (x) {
          if (x.error) { if (win) win.close(); toast(x.error, true); return; }
          if (here && win) { win.location = x.link + '&in_person=1'; showDetail(i.id); return; }
          var first = f.person_name.split(' ')[0];
          var m = modal('<h4>Statement requested from ' + esc(first) + '</h4><p style="font-size:13.5px;margin:0 0 10px;">' +
            (f.person_email ? (x.emailed ? '✓ Emailed to <b>' + esc(f.person_email) + '</b>.' : 'The email didn\'t go out — text or copy the link.') : 'No email — text or copy the link.') + '</p>' +
            '<div class="ir-link"><input class="ir-in" id="irLinkM" readonly value="' + esc(x.link) + '"></div><div class="ir-actions" style="margin-top:12px">' +
            (f.person_phone ? '<a class="ir-btn gold" href="' + esc(smsHref(f.person_phone, x.link, f.person_name)) + '">Text it to ' + esc(first) + '</a>' : '') +
            '<button class="ir-btn sec" id="irCopyM">Copy link</button><button class="ir-btn sec" id="irDoneM">Done</button></div>');
          m.querySelector('#irCopyM').onclick = function () { copy(x.link, m.querySelector('#irLinkM')); };
          m.querySelector('#irDoneM').onclick = function () { m.remove(); showDetail(i.id); };
        });
      }
      $('sGo').onclick = function () { request(false); };
      $('sHere').onclick = function () { request(true); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (b) { b.onclick = function () { var inp = $('lk_' + b.dataset.copy); copy(inp.value, inp); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-here]'), function (b) { b.onclick = function () { window.open(b.dataset.here + '&in_person=1', '_blank'); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-remind]'), function (b) { b.onclick = function () { api('admin_remind', { statement_id: b.dataset.remind }).then(function (x) { toast(x.error || 'Reminder sent.', !!x.error); }); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-void]'), function (b) { b.onclick = function () { api('admin_void_stmt', { statement_id: b.dataset.void }).then(function (x) { toast(x.error || 'Request withdrawn.', !!x.error); showDetail(i.id); }); }; });

      var act = [['Edit details', 'sec', function () { showForm(i); }], ['Download PDF', 'gold', function () { pdf(i.id); }]];
      act.push(i.status === 'open' ? ['Close incident', 'sec', function () { setStatus(i, 'closed', wait.length); }] : ['Reopen', 'sec', function () { setStatus(i, 'open'); }]);
      var box = $('irAct');
      act.forEach(function (a) { var b = document.createElement('button'); b.className = 'ir-btn ' + a[1]; b.textContent = a[0]; b.onclick = a[2]; box.appendChild(b); });
      api('admin_list').then(function (lr) { if (!lr.error) { LIST = lr.incidents || []; updateBadge(); } });
    });
  }
  function setStatus(i, status, waiting) {
    if (status === 'closed' && waiting) {
      var m = modal('<h4>Close with ' + waiting + ' statement' + (waiting > 1 ? 's' : '') + ' still out?</h4><p style="font-size:13.5px;color:var(--text-muted)">Their links keep working, so a late statement still lands here.</p>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="ir-btn sec" id="irCx">Cancel</button><button class="ir-btn gold" id="irCgo">Close incident</button></div>');
      m.querySelector('#irCx').onclick = function () { m.remove(); };
      m.querySelector('#irCgo').onclick = function () { m.remove(); setStatus(i, 'closed', 0); };
      return;
    }
    api('admin_status', { id: i.id, status: status }).then(function (r) { toast(r.error || (status === 'closed' ? 'Incident closed.' : 'Reopened.'), !!r.error); showDetail(i.id); });
  }
  function pdf(id) {
    var win = window.open('about:blank', '_blank');
    api('admin_pdf', { id: id }).then(function (r) {
      if (r.error || !r.url) { if (win) win.close(); toast(r.error || 'PDF failed', true); return; }
      if (win) win.location = r.url; else window.location = r.url;
    });
  }

  /* ---------- boot ---------- */
  window.IncidentsUI = { open: showList, detail: showDetail };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._ir) {
      window.switchTab = function (name) { var out = orig.apply(this, arguments); if (name === 'incidents') showList(true); return out; };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._ir = true;
    }
    var item = document.querySelector('.sb-nav-item[data-tab="incidents"]');
    if (item && !item._irBound) { item._irBound = true; item.addEventListener('click', function () { window.switchTab('incidents'); }); }
    if (tok()) api('admin_list').then(function (r) { if (!r.error) { LIST = r.incidents || []; updateBadge(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 600); });
  else setTimeout(boot, 600);
})();
