/* ============================================================================
 * The Quarry — Admin "Write-Ups" (employee corrective action notices)
 * Self-injecting: adds a "Team › Write-Ups" sidebar item + #writeupsTab panel.
 * Loaded from admin/index.html with <script src="./writeups-admin.js"></script>.
 *
 * Backend: Supabase edge function `writeups` (project nkulhtalltbieicvmmad).
 * Records live in employee_writeups (RLS on, no policies — service role only),
 * so nothing here talks to the REST API directly. Owner login only.
 *
 * Flow:  Draft  →  Issue (locks it, mints a private link)  →  one of:
 *          • employee signs on their phone (emailed link / texted link)
 *          • employee signs on the manager's iPad/phone ("Sign on this device")
 *          • employee refuses → manager records it with a witness
 *        Every outcome produces a PDF and emails management@ a copy.
 * Employee-facing page: /writeup.html?t=<token>
 * ==========================================================================*/
(function () {
  'use strict';

  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/writeups';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl'; // publishable key (gateway only)

  var META = null;       // { roster, categories, levels }
  var LIST = [];         // summary rows
  var filter = { q: '', status: 'open' };
  var sigPad = null;

  var DEFAULT_CONSEQ = {
    coaching: 'This conversation is documented so expectations are clear. Repeated issues may lead to formal corrective action.',
    verbal: 'Further violations may result in a written warning or additional corrective action.',
    written: 'Further violations may result in a final written warning, suspension, or termination of employment.',
    final: 'This is a final warning. Any further violation may result in termination of employment.',
    suspension: 'Any further violation following this suspension may result in termination of employment.',
    termination: 'Employment with The Quarry is terminated effective the date above. Final pay will be issued per Missouri law.'
  };
  var STATUS_LABEL = { draft: 'Draft', issued: 'Awaiting signature', acknowledged: 'Signed', refused: 'Refused to sign', voided: 'Void' };

  /* ---------- helpers ---------- */
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
  function fmtDate(d) {
    if (!d) return '—';
    var dt = new Date(String(d).length <= 10 ? d + 'T12:00:00' : d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtStamp(d) { return d ? new Date(d).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  function toast(msg, bad) {
    Array.prototype.forEach.call(document.querySelectorAll('.wu-toast'), function (o) { o.remove(); });
    var t = document.createElement('div');
    t.className = 'wu-toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }
  function lvl(k) { return (META && META.levels[k]) || k; }
  function cat(k) { return (META && META.categories[k]) || k; }

  /* ---------- styles ---------- */
  function injectStyles() {
    if ($('wuStyles')) return;
    var css = '' +
      '#writeupsTab{padding-bottom:60px;}' +
      '#writeupsTab .wu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;}' +
      '#writeupsTab h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '#writeupsTab .wu-sub{color:var(--text-muted);font-size:13px;margin-top:4px;}' +
      '.wu-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;}' +
      '.wu-btn:hover{filter:brightness(1.15);} .wu-btn:disabled{opacity:.45;cursor:not-allowed;}' +
      '.wu-btn.gold{background:var(--gold);} .wu-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.wu-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .wu-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.wu-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.wu-card h3{margin:0 0 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.wu-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px;}' +
      '.wu-stat{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:14px 16px;cursor:pointer;}' +
      '.wu-stat .n{font-size:26px;font-weight:700;color:var(--text-primary);} .wu-stat .l{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.6px;}' +
      '.wu-stat.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset;}' +
      '.wu-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;align-items:center;}' +
      '.wu-in,.wu-sel,.wu-ta{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border-medium);border-radius:8px;font-size:14px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.wu-ta{min-height:84px;resize:vertical;line-height:1.45;}' +
      '.wu-in:focus,.wu-sel:focus,.wu-ta:focus{outline:2px solid rgba(154,123,42,.35);border-color:var(--gold);}' +
      '.wu-lbl{display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;}' +
      '.wu-lbl .req{color:#b42318;} .wu-hint{font-size:11.5px;color:var(--text-muted);margin-top:4px;}' +
      '.wu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;}' +
      '.wu-f{margin-bottom:14px;}' +
      '.wu-table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;}' +
      '.wu-table th,.wu-table td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;vertical-align:middle;}' +
      '.wu-table th{background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);}' +
      '.wu-table tr.click{cursor:pointer;} .wu-table tr.click:hover td{background:var(--bg-hover);}' +
      '.wu-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;}' +
      '.wu-pill.draft{background:#eef0f4;color:#4b5263;} .wu-pill.issued{background:#fff4d6;color:#8a5a00;}' +
      '.wu-pill.acknowledged{background:#dcf5e3;color:#176b34;} .wu-pill.refused{background:#fde4e1;color:#a52a1e;} .wu-pill.voided{background:#f1f1f1;color:#999;text-decoration:line-through;}' +
      '.wu-lv{font-size:12px;font-weight:600;} .wu-lv.final,.wu-lv.suspension,.wu-lv.termination{color:#a52a1e;}' +
      '.wu-sig{border:1px dashed var(--border-medium);border-radius:10px;background:#fffdf8;position:relative;}' +
      '.wu-sig canvas{display:block;width:100%;height:150px;touch-action:none;cursor:crosshair;}' +
      '.wu-sig .x{position:absolute;top:8px;right:8px;} .wu-sig .ph{position:absolute;left:14px;bottom:10px;font-size:11px;color:#b5ab9c;pointer-events:none;}' +
      '.wu-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 18px;}' +
      '.wu-kv div span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-muted);margin-bottom:2px;}' +
      '.wu-kv div b{font-size:14px;color:var(--text-primary);font-weight:600;}' +
      '.wu-txt{white-space:pre-wrap;font-size:14px;line-height:1.55;color:var(--text-primary);margin:0 0 14px;}' +
      '.wu-txt-l{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);margin-bottom:4px;}' +
      '.wu-actions{display:flex;gap:8px;flex-wrap:wrap;}' +
      '.wu-audit{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;max-height:240px;overflow:auto;}' +
      '.wu-audit div{padding:3px 0;border-bottom:1px solid var(--border-subtle);}' +
      '.wu-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b4e00;margin-bottom:14px;}' +
      '.wu-callout.ok{background:#ecf9f0;border-color:#b9e5c6;color:#176b34;} .wu-callout.bad{background:#fdeeee;border-color:#f3c3be;color:#8c2318;}' +
      '.wu-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}' +
      '.wu-modal .box{background:#fff;border-radius:14px;max-width:520px;width:100%;max-height:90vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '.wu-modal h4{margin:0 0 6px;font-family:var(--font-serif);font-size:1.3rem;}' +
      '.wu-opt{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-subtle);border-radius:10px;padding:12px;margin:10px 0;cursor:pointer;}' +
      '.wu-opt input{margin-top:3px;} .wu-opt b{display:block;font-size:14px;} .wu-opt small{color:var(--text-muted);}' +
      '.wu-link{display:flex;gap:8px;} .wu-link input{flex:1;font-size:12px;}' +
      '.wu-hist a{color:var(--gold);cursor:pointer;text-decoration:underline;}' +
      '.wu-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;}' +
      '.wu-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .wu-toast.bad{background:#a52a1e;}' +
      '@media (max-width:700px){.wu-table .hide-sm{display:none;} #writeupsTab h2{font-size:1.45rem;}}';
    var st = document.createElement('style'); st.id = 'wuStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- nav + panel ---------- */
  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="writeups"]')) {
      var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
      var grp = document.createElement('div'); grp.className = 'sb-nav-group';
      var item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = 'writeups';
      item.innerHTML = '<span class="sb-ic">📋</span><span class="sb-lbl">Write-Ups</span><span id="wuBadge" class="sb-badge" style="display:none;">0</span>';
      grp.appendChild(item);
      // place the Team section just above System (fallback: end of nav)
      var sys = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /system/i.test(s.textContent); });
      if (sys) { nav.insertBefore(sec, sys); nav.insertBefore(grp, sys); }
      else { nav.appendChild(sec); nav.appendChild(grp); }
      // admin/index.html's setupNavigation() binds section collapse on login; if it ran
      // before we injected, it missed us. Toggle only if nobody else did.
      sec.addEventListener('click', function () {
        var before = sec.classList.contains('collapsed');
        setTimeout(function () { if (sec.classList.contains('collapsed') === before) sec.classList.toggle('collapsed'); }, 0);
      });
    }
    if (!$('writeupsTab')) {
      var any = document.querySelector('.tab-content');
      if (any) {
        var div = document.createElement('div'); div.id = 'writeupsTab'; div.className = 'tab-content';
        div.innerHTML = '<div id="wuBody"></div>';
        any.parentNode.appendChild(div);
      }
    }
  }

  /* ---------- signature pad ---------- */
  function SignaturePad(canvas) {
    var ctx, drawing = false, last = null, dirty = false;
    function size() {
      var r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, r.width * d); canvas.height = Math.max(1, r.height * d);
      ctx = canvas.getContext('2d'); ctx.scale(d, d);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
      dirty = false;
    }
    function pt(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; last = pt(e); ctx.beginPath(); ctx.arc(last.x, last.y, 1, 0, Math.PI * 2); ctx.fill(); dirty = true; });
    canvas.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; dirty = true; });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { canvas.addEventListener(ev, function () { drawing = false; }); });
    size();
    return {
      clear: size,
      isEmpty: function () { return !dirty; },
      toDataURL: function () { return canvas.toDataURL('image/png'); },
      load: function (src) {
        if (!src) return;
        var img = new Image(); img.onload = function () {
          var r = canvas.getBoundingClientRect(), s = Math.min(r.width / img.width, r.height / img.height, 1);
          ctx.drawImage(img, 0, 0, img.width * s, img.height * s); dirty = true;
        }; img.src = src;
      }
    };
  }

  /* ================= LIST ================= */
  function loadMeta() {
    if (META) return Promise.resolve(META);
    return api('admin_meta').then(function (r) { if (!r.error) META = r; return META; });
  }

  var lastOpen = 0;
  function showList() {
    var body = $('wuBody');
    if (!body) return;
    if (Date.now() - lastOpen < 400) return; // nav click can fire twice (two bound handlers)
    lastOpen = Date.now();
    body.innerHTML = '<div class="wu-head"><div><h2>Employee Write-Ups</h2><div class="wu-sub">Document it, get it acknowledged, keep the record. Signing means received — not agreed.</div></div>' +
      '<button class="wu-btn gold" id="wuNew">+ New write-up</button></div><div id="wuList"><div class="wu-card" style="color:var(--text-muted)">Loading…</div></div>';
    $('wuNew').onclick = function () { showForm(null); };
    Promise.all([loadMeta(), api('admin_list')]).then(function (res) {
      var r = res[1];
      if (r.error) { $('wuList').innerHTML = '<div class="wu-callout bad">' + esc(r.error) + '</div>'; return; }
      LIST = r.writeups || [];
      updateBadge();
      renderList();
    });
  }

  function updateBadge() {
    var n = LIST.filter(function (w) { return w.status === 'issued'; }).length;
    var b = $('wuBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
  }

  function renderList() {
    var counts = { open: 0, draft: 0, issued: 0, closed: 0, all: LIST.length };
    LIST.forEach(function (w) {
      if (w.status === 'draft') counts.draft++;
      if (w.status === 'issued') counts.issued++;
      if (w.status === 'draft' || w.status === 'issued') counts.open++;
      if (w.status === 'acknowledged' || w.status === 'refused') counts.closed++;
    });
    var stats = [['open', 'Open'], ['issued', 'Awaiting signature'], ['closed', 'Signed / refused'], ['all', 'All on file']];
    var h = '<div class="wu-stats">' + stats.map(function (s) {
      return '<div class="wu-stat' + (filter.status === s[0] ? ' on' : '') + '" data-f="' + s[0] + '"><div class="n">' + counts[s[0]] + '</div><div class="l">' + s[1] + '</div></div>';
    }).join('') + '</div>';
    h += '<div class="wu-bar"><input class="wu-in" id="wuQ" placeholder="Search employee, ref #, manager…" style="max-width:360px" value="' + esc(filter.q) + '"></div>';

    var q = filter.q.trim().toLowerCase();
    var rows = LIST.filter(function (w) {
      var s = w.status;
      if (filter.status === 'open' && !(s === 'draft' || s === 'issued')) return false;
      if (filter.status === 'issued' && s !== 'issued') return false;
      if (filter.status === 'closed' && !(s === 'acknowledged' || s === 'refused')) return false;
      if (q && (w.employee_name + ' ' + w.ref_no + ' ' + w.issued_by_name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    if (!rows.length) {
      h += '<div class="wu-card" style="color:var(--text-muted);text-align:center;padding:34px;">' +
        (LIST.length ? 'Nothing matches this filter.' : 'No write-ups on file yet. Click <b>+ New write-up</b> to start one.') + '</div>';
    } else {
      // count per employee so repeat issues stand out
      var per = {};
      LIST.forEach(function (w) { if (w.status !== 'voided') { var k = w.employee_name.toLowerCase(); per[k] = (per[k] || 0) + 1; } });
      h += '<table class="wu-table"><thead><tr><th>Ref</th><th>Employee</th><th>Action</th><th class="hide-sm">Category</th><th class="hide-sm">Incident</th><th>Status</th></tr></thead><tbody>';
      rows.forEach(function (w) {
        var n = per[w.employee_name.toLowerCase()] || 0;
        h += '<tr class="click" data-id="' + w.id + '"><td style="font-family:ui-monospace,monospace;font-size:12px;">' + esc(w.ref_no) + '</td>' +
          '<td><b>' + esc(w.employee_name) + '</b>' + (n > 1 ? ' <span title="Write-ups on file" style="font-size:11px;color:#a52a1e;font-weight:700;">×' + n + '</span>' : '') +
          (w.employee_position ? '<div style="font-size:11.5px;color:var(--text-muted)">' + esc(w.employee_position) + '</div>' : '') + '</td>' +
          '<td><span class="wu-lv ' + w.level + '">' + esc(lvl(w.level)) + '</span></td>' +
          '<td class="hide-sm">' + esc(cat(w.category)) + '</td>' +
          '<td class="hide-sm">' + fmtDate(w.incident_date) + '</td>' +
          '<td><span class="wu-pill ' + w.status + '">' + STATUS_LABEL[w.status] + '</span></td></tr>';
      });
      h += '</tbody></table>';
    }
    $('wuList').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('#wuList .wu-stat'), function (el) {
      el.onclick = function () { filter.status = el.dataset.f; renderList(); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('#wuList tr.click'), function (el) {
      el.onclick = function () { showDetail(el.dataset.id); };
    });
    var qi = $('wuQ');
    qi.oninput = function () { filter.q = qi.value; var pos = qi.selectionStart; renderList(); var n = $('wuQ'); n.focus(); n.setSelectionRange(pos, pos); };
  }

  /* ================= FORM ================= */
  function opt(map, sel) {
    return Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>'; }).join('');
  }

  function showForm(w) {
    loadMeta().then(function () {
      if (!META) { $('wuBody').innerHTML = '<div class="wu-callout bad">Could not reach the write-ups service. Log out and back in, then try again.</div>'; return; }
      w = w || {};
      var last = {};
      try { last = JSON.parse(localStorage.getItem('wuLastIssuer') || '{}'); } catch (_) {}
      var roster = META.roster || [];
      var dl = roster.map(function (p) { return '<option value="' + esc(p.name) + '">' + esc(p.position || '') + '</option>'; }).join('');
      var v = function (k, d) { return esc(w[k] != null ? w[k] : (d || '')); };
      var level = w.level || 'written';

      var h = '<button class="wu-btn sec sm" id="wuBack" style="margin-bottom:14px;">← Back</button>' +
        '<div class="wu-head"><div><h2>' + (w.id ? 'Edit draft · ' + esc(w.ref_no) : 'New write-up') + '</h2>' +
        '<div class="wu-sub">Stick to facts: what happened, when, what the expectation is. Save as a draft anytime — nothing goes to the employee until you issue it.</div></div></div>' +

        '<div class="wu-card"><h3>Employee</h3><div class="wu-grid">' +
        '<div class="wu-f"><label class="wu-lbl">Employee name <span class="req">*</span></label><input class="wu-in" id="f_employee_name" list="wuRoster" autocomplete="off" value="' + v('employee_name') + '" placeholder="Start typing…"><datalist id="wuRoster">' + dl + '</datalist></div>' +
        '<div class="wu-f"><label class="wu-lbl">Position</label><input class="wu-in" id="f_employee_position" value="' + v('employee_position') + '" placeholder="Server, Bartender, Line cook…"></div>' +
        '<div class="wu-f"><label class="wu-lbl">Employee email</label><input class="wu-in" id="f_employee_email" type="email" value="' + v('employee_email') + '" placeholder="For the signing link + their copy"><div class="wu-hint">Optional — leave blank if they\'ll sign in person.</div></div>' +
        '</div><div id="wuPrior"></div></div>' +

        '<div class="wu-card"><h3>Incident</h3><div class="wu-grid">' +
        '<div class="wu-f"><label class="wu-lbl">Date of incident</label><input class="wu-in" id="f_incident_date" type="date" value="' + v('incident_date', today()) + '"></div>' +
        '<div class="wu-f"><label class="wu-lbl">Time</label><input class="wu-in" id="f_incident_time" value="' + v('incident_time') + '" placeholder="e.g. 5:40 PM"></div>' +
        '<div class="wu-f"><label class="wu-lbl">Location / shift</label><input class="wu-in" id="f_incident_location" value="' + v('incident_location') + '" placeholder="Friday dinner, main bar, wedding…"></div>' +
        '</div><div class="wu-grid">' +
        '<div class="wu-f"><label class="wu-lbl">Category <span class="req">*</span></label><select class="wu-sel" id="f_category">' + opt(META.categories, w.category || 'attendance') + '</select></div>' +
        '<div class="wu-f"><label class="wu-lbl">Action level <span class="req">*</span></label><select class="wu-sel" id="f_level">' + opt(META.levels, level) + '</select></div>' +
        '<div class="wu-f" id="wuSuspWrap" style="display:' + (level === 'suspension' ? '' : 'none') + '"><label class="wu-lbl">Suspension details</label><input class="wu-in" id="f_suspension_days" value="' + v('suspension_days') + '" placeholder="e.g. Unpaid, Oct 15–16, return Oct 17"></div>' +
        '</div>' +
        '<div class="wu-f"><label class="wu-lbl">What happened <span class="req">*</span></label><textarea class="wu-ta" id="f_description" style="min-height:130px" placeholder="Facts only — who, what, when, where, impact on guests/team. Include dates of related incidents.">' + v('description') + '</textarea></div>' +
        '<div class="wu-f"><label class="wu-lbl">Policy or expectation not met</label><textarea class="wu-ta" id="f_policy_violated" placeholder="e.g. Attendance policy: call the MOD at least 2 hours before shift if running late.">' + v('policy_violated') + '</textarea></div>' +
        '<div class="wu-f"><label class="wu-lbl">Prior related conversations or warnings</label><textarea class="wu-ta" id="f_prior_actions" placeholder="Dates and who had the conversation.">' + v('prior_actions') + '</textarea></div>' +
        '<div class="wu-f"><label class="wu-lbl">Employee\'s explanation (what they said in the meeting)</label><textarea class="wu-ta" id="f_employee_explanation" placeholder="Optional — record it in their words.">' + v('employee_explanation') + '</textarea></div>' +
        '</div>' +

        '<div class="wu-card"><h3>Going forward</h3>' +
        '<div class="wu-f"><label class="wu-lbl">Required improvement / plan</label><textarea class="wu-ta" id="f_expected_improvement" placeholder="Specific and measurable: what must change, by when.">' + v('expected_improvement') + '</textarea></div>' +
        '<div class="wu-f"><label class="wu-lbl">Consequences if not corrected</label><textarea class="wu-ta" id="f_consequences">' + v('consequences', DEFAULT_CONSEQ[level]) + '</textarea></div>' +
        '<div class="wu-grid"><div class="wu-f"><label class="wu-lbl">Follow-up review date</label><input class="wu-in" id="f_review_date" type="date" value="' + v('review_date') + '"></div></div>' +
        '</div>' +

        '<div class="wu-card"><h3>Issued by</h3><div class="wu-grid">' +
        '<div class="wu-f"><label class="wu-lbl">Manager name <span class="req">*</span></label><input class="wu-in" id="f_issued_by_name" value="' + v('issued_by_name', last.name) + '"></div>' +
        '<div class="wu-f"><label class="wu-lbl">Title</label><input class="wu-in" id="f_issued_by_title" value="' + v('issued_by_title', last.title) + '" placeholder="General Manager, Owner…"></div>' +
        '<div class="wu-f"><label class="wu-lbl">Witness present</label><input class="wu-in" id="f_witness_name" value="' + v('witness_name') + '" placeholder="Recommended for final warnings / terminations"></div>' +
        '</div>' +
        '<label class="wu-lbl">Manager signature <span class="req">*</span> <span style="font-weight:400;color:var(--text-muted)">(required to issue)</span></label>' +
        '<div class="wu-sig"><canvas id="wuMgrSig"></canvas><span class="ph">Sign here with mouse, finger or stylus</span><button class="wu-btn sec sm x" id="wuSigClear" type="button">Clear</button></div>' +
        '</div>' +

        '<div class="wu-card" style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">' +
        '<button class="wu-btn sec" id="wuSave">Save draft</button>' +
        '<button class="wu-btn gold" id="wuSaveIssue">Save &amp; issue…</button></div>';

      $('wuBody').innerHTML = h;
      $('wuBack').onclick = function () { w.id ? showDetail(w.id) : showList(); };
      sigPad = SignaturePad($('wuMgrSig'));
      if (w.manager_signature) sigPad.load(w.manager_signature);
      $('wuSigClear').onclick = function () { sigPad.clear(); };

      var levelSel = $('f_level');
      levelSel.onchange = function () {
        $('wuSuspWrap').style.display = levelSel.value === 'suspension' ? '' : 'none';
        var c = $('f_consequences');
        var isDefault = !c.value.trim() || Object.keys(DEFAULT_CONSEQ).some(function (k) { return DEFAULT_CONSEQ[k] === c.value.trim(); });
        if (isDefault) c.value = DEFAULT_CONSEQ[levelSel.value] || '';
      };
      var nameIn = $('f_employee_name');
      var onName = function () {
        var p = roster.find(function (r) { return r.name.toLowerCase() === nameIn.value.trim().toLowerCase(); });
        if (p) {
          if (p.email && !$('f_employee_email').value) $('f_employee_email').value = p.email;
          if (p.position && !$('f_employee_position').value) $('f_employee_position').value = p.position.charAt(0).toUpperCase() + p.position.slice(1);
          nameIn.dataset.ref = p.ref;
        }
        renderPrior(nameIn.value, w.id);
      };
      nameIn.addEventListener('change', onName);
      nameIn.addEventListener('blur', onName);
      if (w.employee_name) renderPrior(w.employee_name, w.id);

      $('wuSave').onclick = function () { save(w, false); };
      $('wuSaveIssue').onclick = function () { save(w, true); };
    });
  }

  function renderPrior(name, selfId) {
    var box = $('wuPrior'); if (!box) return;
    var k = String(name || '').trim().toLowerCase();
    var prior = LIST.filter(function (x) { return x.employee_name.toLowerCase() === k && x.id !== selfId && x.status !== 'voided'; });
    if (!k || !prior.length) { box.innerHTML = ''; return; }
    var lines = prior.map(function (p) { return fmtDate(p.incident_date || p.created_at) + ' — ' + lvl(p.level) + ' (' + cat(p.category) + '), ' + p.ref_no; });
    box.innerHTML = '<div class="wu-callout"><b>' + prior.length + ' prior write-up' + (prior.length > 1 ? 's' : '') + ' on file:</b><br>' + lines.map(esc).join('<br>') +
      '<div style="margin-top:8px"><button class="wu-btn sec sm" id="wuUsePrior" type="button">Add these to “Prior warnings”</button></div></div>';
    $('wuUsePrior').onclick = function () {
      var t = $('f_prior_actions');
      t.value = (t.value ? t.value.trim() + '\n' : '') + lines.join('\n');
    };
  }

  function collect() {
    var f = {};
    ['employee_name', 'employee_email', 'employee_position', 'incident_date', 'incident_time', 'incident_location', 'category', 'level',
      'description', 'policy_violated', 'prior_actions', 'employee_explanation', 'expected_improvement', 'consequences', 'review_date',
      'suspension_days', 'issued_by_name', 'issued_by_title', 'witness_name'].forEach(function (k) {
      var el = $('f_' + k); if (el) f[k] = el.value.trim();
    });
    var ref = $('f_employee_name').dataset.ref; if (ref) f.employee_ref = ref;
    if (sigPad && !sigPad.isEmpty()) f.manager_signature = sigPad.toDataURL();
    return f;
  }

  function save(w, thenIssue) {
    var f = collect();
    var miss = [];
    if (!f.employee_name) miss.push('employee name');
    if (!f.description) miss.push('what happened');
    if (!f.issued_by_name) miss.push('manager name');
    if (miss.length) { toast('Missing: ' + miss.join(', '), true); return; }
    if (f.employee_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.employee_email)) { toast('That email doesn\'t look right.', true); return; }
    if (thenIssue && !f.manager_signature) { toast('Sign in the manager signature box before issuing.', true); return; }
    try { localStorage.setItem('wuLastIssuer', JSON.stringify({ name: f.issued_by_name, title: f.issued_by_title })); } catch (_) {}
    var btns = [$('wuSave'), $('wuSaveIssue')]; btns.forEach(function (b) { b.disabled = true; });
    api('admin_save', { id: w.id || null, fields: f }).then(function (r) {
      btns.forEach(function (b) { b.disabled = false; });
      if (r.error) { toast(r.error, true); return; }
      toast(w.id ? 'Draft updated.' : 'Draft saved · ' + (r.ref_no || ''));
      if (thenIssue) issueModal(r.id, f); else showDetail(r.id);
    });
  }

  /* ================= ISSUE ================= */
  function modal(html) {
    var m = document.createElement('div'); m.className = 'wu-modal';
    m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
    return m;
  }

  function issueModal(id, w) {
    var hasEmail = !!(w.employee_email);
    var m = modal('<h4>Issue this write-up</h4><p style="color:var(--text-muted);font-size:13px;margin:0 0 6px;">Once issued it\'s locked — no more edits. How will ' + esc(w.employee_name.split(' ')[0]) + ' acknowledge it?</p>' +
      '<label class="wu-opt"><input type="radio" name="wuHow" value="inperson" checked><div><b>In person, right now</b><small>Opens the signing page on this device — hand them the iPad/phone after you talk.</small></div></label>' +
      '<label class="wu-opt"><input type="radio" name="wuHow" value="email"' + (hasEmail ? '' : ' disabled') + '><div><b>Email them a private link</b><small>' + (hasEmail ? 'Sends to ' + esc(w.employee_email) : 'Add an email to the draft to use this') + '</small></div></label>' +
      '<label class="wu-opt"><input type="radio" name="wuHow" value="link"><div><b>Just give me the link</b><small>Copy it and text it to them yourself.</small></div></label>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;"><button class="wu-btn sec" id="wuIx">Cancel</button><button class="wu-btn gold" id="wuIgo">Issue</button></div>');
    m.querySelector('#wuIx').onclick = function () { m.remove(); showDetail(id); };
    m.querySelector('#wuIgo').onclick = function () {
      var how = m.querySelector('input[name=wuHow]:checked').value;
      var btn = m.querySelector('#wuIgo'); btn.disabled = true; btn.textContent = 'Issuing…';
      // open the tab synchronously so pop-up blockers allow it
      var win = how === 'inperson' ? window.open('about:blank', '_blank') : null;
      api('admin_issue', { id: id, email: how === 'email' }).then(function (r) {
        m.remove();
        if (r.error) { if (win) win.close(); toast(r.error, true); showDetail(id); return; }
        if (how === 'inperson' && win) win.location = r.ack_url + '&in_person=1';
        if (how === 'email') toast(r.emailed ? 'Issued — link emailed.' : 'Issued, but the email didn\'t send. Copy the link instead.', !r.emailed);
        else toast('Issued.');
        showDetail(id, how === 'link');
      });
    };
  }

  /* ================= DETAIL ================= */
  function showDetail(id, highlightLink) {
    $('wuBody').innerHTML = '<div class="wu-card" style="color:var(--text-muted)">Loading…</div>';
    Promise.all([loadMeta(), api('admin_get', { id: id })]).then(function (res) {
      var r = res[1];
      if (r.error) { $('wuBody').innerHTML = '<div class="wu-callout bad">' + esc(r.error) + '</div>'; return; }
      var w = r.writeup, audit = r.audit || [], hist = r.history || [];
      var h = '<button class="wu-btn sec sm" id="wuBack" style="margin-bottom:14px;">← All write-ups</button>';
      h += '<div class="wu-head"><div><h2>' + esc(w.employee_name) + '</h2><div class="wu-sub">' + esc(w.ref_no) + ' · ' + esc(lvl(w.level)) + ' · <span class="wu-pill ' + w.status + '">' + STATUS_LABEL[w.status] + '</span></div></div>' +
        '<div class="wu-actions" id="wuAct"></div></div>';

      // status callout
      if (w.status === 'draft') h += '<div class="wu-callout">Draft — the employee can\'t see this yet. Edit it, print it, or issue it when you\'re ready.</div>';
      if (w.status === 'issued') {
        h += '<div class="wu-callout"><b>Waiting on ' + esc(w.employee_name.split(' ')[0]) + '\'s acknowledgment</b> · issued ' + fmtStamp(w.issued_at) +
          '<div class="wu-link" style="margin-top:10px;"><input class="wu-in" id="wuLink" readonly value="' + esc(r.ack_url) + '"><button class="wu-btn sec sm" id="wuCopy">Copy link</button></div>' +
          '<div class="wu-hint" style="color:#6b4e00">If they won\'t sign, use <b>Refused to sign</b> and have a second manager witness it.</div></div>';
      }
      if (w.status === 'acknowledged') h += '<div class="wu-callout ok"><b>Signed by ' + esc(w.employee_signed_name || w.employee_name) + '</b> — ' + fmtStamp(w.acknowledged_at) + ' · ' + (w.ack_method === 'in_person' ? 'in person' : 'via private link') + (w.signer_ip ? ' · IP ' + esc(w.signer_ip) : '') + '</div>';
      if (w.status === 'refused') h += '<div class="wu-callout bad"><b>Employee refused to sign</b> — ' + fmtStamp(w.refused_at) + ' · witness: ' + esc(w.refused_witness) + (w.refused_note ? '<br>' + esc(w.refused_note) : '') + '</div>';
      if (w.status === 'voided') h += '<div class="wu-callout bad"><b>Voided</b> ' + fmtStamp(w.voided_at) + (w.void_reason ? ' — ' + esc(w.void_reason) : '') + '</div>';

      h += '<div class="wu-card"><h3>Details</h3><div class="wu-kv">' +
        kv('Position', w.employee_position) + kv('Email', w.employee_email) + kv('Incident', [fmtDate(w.incident_date), w.incident_time].filter(Boolean).join(' · ')) +
        kv('Location / shift', w.incident_location) + kv('Category', cat(w.category)) + kv('Action level', lvl(w.level)) +
        kv('Issued by', [w.issued_by_name, w.issued_by_title].filter(Boolean).join(', ')) + kv('Witness', w.witness_name) + kv('Review date', w.review_date ? fmtDate(w.review_date) : '') +
        '</div></div>';

      h += '<div class="wu-card"><h3>Notice</h3>' +
        txt('What happened', w.description) + txt('Policy / expectation', w.policy_violated) + txt('Prior warnings', w.prior_actions) +
        txt('Employee\'s explanation', w.employee_explanation) + (w.level === 'suspension' ? txt('Suspension', w.suspension_days) : '') +
        txt('Required improvement', w.expected_improvement) + txt('Consequences', w.consequences) +
        (w.employee_comments ? txt('Employee comments', w.employee_comments) : '') + '</div>';

      if (w.employee_signature || w.manager_signature) {
        h += '<div class="wu-card"><h3>Signatures</h3><div class="wu-grid">' +
          (w.employee_signature ? '<div><div class="wu-txt-l">Employee</div><img src="' + w.employee_signature + '" style="max-width:100%;height:80px;object-fit:contain;background:#fffdf8;border:1px solid var(--border-subtle);border-radius:8px;"></div>' : '') +
          (w.manager_signature ? '<div><div class="wu-txt-l">Manager</div><img src="' + w.manager_signature + '" style="max-width:100%;height:80px;object-fit:contain;background:#fffdf8;border:1px solid var(--border-subtle);border-radius:8px;"></div>' : '') +
          '</div></div>';
      }

      if (hist.length) {
        h += '<div class="wu-card wu-hist"><h3>Other write-ups for ' + esc(w.employee_name) + '</h3>' + hist.map(function (x) {
          return '<div style="padding:5px 0;font-size:13.5px;">' + fmtDate(x.incident_date || x.created_at) + ' — <a data-id="' + x.id + '">' + esc(x.ref_no) + '</a> · ' + esc(lvl(x.level)) + ' · ' + esc(cat(x.category)) + ' <span class="wu-pill ' + x.status + '">' + STATUS_LABEL[x.status] + '</span></div>';
        }).join('') + '</div>';
      }

      h += '<div class="wu-card"><h3>Audit trail</h3><div class="wu-audit">' + audit.map(function (a) {
        return '<div>' + fmtStamp(a.created_at) + ' · <b>' + esc(String(a.event).toUpperCase()) + '</b> · ' + esc(a.actor || '') + (a.ip ? ' · IP ' + esc(a.ip) : '') + '</div>';
      }).join('') + '</div></div>';

      $('wuBody').innerHTML = h;
      $('wuBack').onclick = function () { lastOpen = 0; showList(); };
      Array.prototype.forEach.call(document.querySelectorAll('.wu-hist a'), function (a) { a.onclick = function () { showDetail(a.dataset.id); }; });
      if ($('wuCopy')) {
        $('wuCopy').onclick = function () { copy(r.ack_url); };
        if (highlightLink) { $('wuLink').focus(); $('wuLink').select(); }
      }

      // actions
      var act = [];
      if (w.status === 'draft') {
        act.push(['Edit', 'sec', function () { showForm(w); }]);
        act.push(['Print / PDF', 'sec', function () { pdf(w.id); }]);
        act.push(['Issue…', 'gold', function () { issueModal(w.id, w); }]);
      }
      if (w.status === 'issued') {
        act.push(['Sign on this device', 'gold', function () { window.open(r.ack_url + '&in_person=1', '_blank'); }]);
        if (w.employee_email) act.push(['Re-send email', 'sec', function () { remind(w.id); }]);
        act.push(['Print / PDF', 'sec', function () { pdf(w.id); }]);
        act.push(['Refused to sign', 'danger', function () { refusedModal(w); }]);
      }
      if (w.status === 'acknowledged' || w.status === 'refused') act.push(['Download signed PDF', 'gold', function () { pdf(w.id); }]);
      if (w.status === 'voided') act.push(['PDF (void copy)', 'sec', function () { pdf(w.id); }]);
      if (w.status !== 'voided') act.push(['Void', 'danger', function () { voidIt(w); }]);
      var box = $('wuAct');
      act.forEach(function (a) {
        var b = document.createElement('button'); b.className = 'wu-btn ' + a[1]; b.textContent = a[0]; b.onclick = a[2]; box.appendChild(b);
      });
      // refresh list cache quietly so badge/prior counts stay right
      api('admin_list').then(function (lr) { if (!lr.error) { LIST = lr.writeups || []; updateBadge(); } });
    });
  }
  function kv(k, v) { return '<div><span>' + esc(k) + '</span><b>' + esc(v || '—') + '</b></div>'; }
  function txt(k, v) { return v ? '<div class="wu-txt-l">' + esc(k) + '</div><p class="wu-txt">' + esc(v) + '</p>' : ''; }
  function copy(s) {
    (navigator.clipboard ? navigator.clipboard.writeText(s) : Promise.reject()).then(function () { toast('Link copied — text it to them.'); })
      .catch(function () { var i = $('wuLink'); if (i) { i.select(); document.execCommand('copy'); toast('Link copied.'); } });
  }
  function pdf(id) {
    var win = window.open('about:blank', '_blank');
    api('admin_pdf', { id: id }).then(function (r) {
      if (r.error || !r.url) { if (win) win.close(); toast(r.error || 'PDF failed', true); return; }
      if (win) win.location = r.url; else window.location = r.url;
    });
  }
  function remind(id) {
    api('admin_remind', { id: id }).then(function (r) { toast(r.error || 'Reminder sent.', !!r.error); if (!r.error) showDetail(id); });
  }
  function refusedModal(w) {
    var m = modal('<h4>Employee refused to sign</h4><p style="color:var(--text-muted);font-size:13px;margin:0 0 12px;">That\'s OK — the notice still stands. Have a second manager present, note it here, and give the employee a printed copy.</p>' +
      '<div class="wu-f"><label class="wu-lbl">Witness name <span class="req">*</span></label><input class="wu-in" id="wuRw" value="' + esc(w.witness_name || '') + '" placeholder="Second manager / owner present"></div>' +
      '<div class="wu-f"><label class="wu-lbl">Note</label><textarea class="wu-ta" id="wuRn" placeholder="e.g. Read the notice, said they disagree and would not sign. Copy handed to employee.">Notice was reviewed with the employee, who declined to sign. A copy was provided to the employee.</textarea></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;"><button class="wu-btn sec" id="wuRx">Cancel</button><button class="wu-btn danger" id="wuRgo">Record refusal</button></div>');
    m.querySelector('#wuRx').onclick = function () { m.remove(); };
    m.querySelector('#wuRgo').onclick = function () {
      var wit = m.querySelector('#wuRw').value.trim();
      if (!wit) { toast('A witness is required.', true); return; }
      this.disabled = true;
      api('admin_refused', { id: w.id, witness: wit, note: m.querySelector('#wuRn').value }).then(function (r) {
        m.remove(); toast(r.error || 'Refusal recorded. PDF emailed to management.', !!r.error); showDetail(w.id);
      });
    };
  }
  function voidIt(w) {
    var m = modal('<h4>Void ' + esc(w.ref_no) + '?</h4><p style="color:var(--text-muted);font-size:13px;margin:0 0 12px;">It stays on file marked VOID (records are never deleted) and any signing link stops working.</p>' +
      '<div class="wu-f"><label class="wu-lbl">Reason</label><input class="wu-in" id="wuVr" placeholder="e.g. Wrong employee / reissued as WU-…"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;"><button class="wu-btn sec" id="wuVx">Cancel</button><button class="wu-btn danger" id="wuVgo">Void it</button></div>');
    m.querySelector('#wuVx').onclick = function () { m.remove(); };
    m.querySelector('#wuVgo').onclick = function () {
      api('admin_void', { id: w.id, reason: m.querySelector('#wuVr').value }).then(function (r) { m.remove(); toast(r.error || 'Voided.', !!r.error); showDetail(w.id); });
    };
  }

  /* ---------- boot ---------- */
  window.WriteupsUI = { open: showList, detail: showDetail };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._wu) {
      window.switchTab = function (name) { var out = orig.apply(this, arguments); if (name === 'writeups') showList(); return out; };
      window.switchTab._wu = true;
      Object.keys(orig).forEach(function (k) { if (k !== '_wu') window.switchTab[k] = orig[k]; });
    }
    var item = document.querySelector('.sb-nav-item[data-tab="writeups"]');
    if (item && !item._wuBound) { item._wuBound = true; item.addEventListener('click', function () { window.switchTab('writeups'); }); }
    // badge count on load (silent if not owner / not logged in)
    if (tok()) api('admin_list').then(function (r) { if (!r.error) { LIST = r.writeups || []; updateBadge(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 500); });
  else setTimeout(boot, 500);
})();
