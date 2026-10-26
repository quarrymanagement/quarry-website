/* ============================================================================
 * The Quarry — Admin "Personnel Docs" (employee document e-signature)
 * Self-injecting: adds "Team › Personnel Docs" to the sidebar + #hrdocsTab.
 * Loaded from admin/index.html with <script src="./hr-docs-admin.js"></script>.
 *
 * Backend: Supabase edge function `hr-docs` (project nkulhtalltbieicvmmad).
 * Tables hr_* have RLS on with no policies (service role only); files live in
 * the PRIVATE bucket hr-documents. Nothing here talks to the REST API or
 * storage directly, and nothing is ever deleted (void only).
 *
 * Who sees what (enforced server-side, not here):
 *   owner / HR admins  -> everything, incl. disciplinary notices
 *   managers           -> policy + training acknowledgments for their departments only
 * Employee/guardian page: /hr-sign.html?t=<token>
 * ==========================================================================*/
(function () {
  'use strict';

  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var FN = LOCAL ? location.origin + '/functions/v1/hr-docs' : 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/hr-docs';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl'; // publishable key (gateway only)
  var TAB = 'hrdocs';

  var META = null, EMPS = [], DOCS = [], view = 'assign', sel = {};
  var STATUS = {
    not_sent: 'Not sent', sent: 'Sent', viewed: 'Viewed', awaiting_guardian: 'Awaiting guardian', signed: 'Signed',
    declined: 'Declined', refused_witnessed: 'Refused (witnessed)', voided: 'Void'
  };
  var KIND = { discipline: 'Disciplinary', policy: 'Policy', training: 'Training' };

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
  function ct(d) { return d ? new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' : '—'; }
  function pill(s) { return '<span class="hd-pill ' + esc(s) + '">' + esc(STATUS[s] || s) + '</span>'; }
  function toast(msg, bad) {
    var t = document.createElement('div'); t.className = 'hd-toast' + (bad ? ' bad' : ''); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.classList.add('on'); }, 10);
    setTimeout(function () { t.classList.remove('on'); setTimeout(function () { t.remove(); }, 300); }, 3600);
  }
  function modal(html) {
    var m = document.createElement('div'); m.className = 'hd-modal'; m.innerHTML = '<div class="box">' + html + '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m); return m;
  }
  function savePdf(r) {
    if (r.error) { toast(r.error, true); return; }
    var bin = atob(r.pdf_base64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([u], { type: 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function injectStyles() {
    if ($('hdStyles')) return;
    var css = '' +
      '#hrdocsTab{padding-bottom:60px;} #hrdocsTab h2{font-family:var(--font-serif);font-size:1.85rem;margin:0;color:var(--text-primary);}' +
      '.hd-sub{color:var(--text-muted);font-size:13px;margin:4px 0 16px;}' +
      '.hd-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;border-bottom:1px solid var(--border-subtle);}' +
      '.hd-tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:9px 12px;font-weight:600;font-size:13.5px;color:var(--text-muted);cursor:pointer;font-family:var(--font-sans);}' +
      '.hd-tabs button.on{color:var(--text-primary);border-bottom-color:var(--gold);}' +
      '.hd-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;font-family:var(--font-sans);white-space:nowrap;}' +
      '.hd-btn:disabled{opacity:.45;cursor:not-allowed;} .hd-btn.sec{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.hd-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .hd-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.hd-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.hd-card h3{margin:0 0 12px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--gold);font-weight:700;}' +
      '.hd-in,.hd-sel,.hd-ta{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid var(--border-medium);border-radius:8px;font-size:14px;font-family:var(--font-sans);background:#fff;color:var(--text-primary);}' +
      '.hd-ta{min-height:120px;resize:vertical;line-height:1.45;} .hd-lbl{display:block;font-size:12px;font-weight:600;color:var(--text-secondary);margin:0 0 5px;}' +
      '.hd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;} .hd-f{margin-bottom:14px;}' +
      '.hd-hint{font-size:11.5px;color:var(--text-muted);margin-top:4px;}' +
      '.hd-table{width:100%;border-collapse:collapse;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;}' +
      '.hd-table th,.hd-table td{text-align:left;padding:10px 13px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;vertical-align:middle;}' +
      '.hd-table th{background:var(--bg-elevated);font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-muted);}' +
      '.hd-table tr.click{cursor:pointer;} .hd-table tr.click:hover td{background:var(--bg-hover);}' +
      '.hd-pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;background:#eef0f4;color:#4b5263;}' +
      '.hd-pill.sent,.hd-pill.viewed{background:#fff4d6;color:#8a5a00;} .hd-pill.awaiting_guardian{background:#e8e6ff;color:#3d33a6;}' +
      '.hd-pill.signed{background:#dcf5e3;color:#176b34;} .hd-pill.declined,.hd-pill.refused_witnessed{background:#fde4e1;color:#a52a1e;}' +
      '.hd-pill.voided{background:#f1f1f1;color:#999;text-decoration:line-through;} .hd-pill.not_sent{background:#f4f4f6;color:#6b7280;}' +
      '.hd-kind{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text-muted);} .hd-kind.discipline{color:#a52a1e;}' +
      '.hd-emps{max-height:300px;overflow:auto;border:1px solid var(--border-subtle);border-radius:10px;padding:6px 10px;background:#fff;}' +
      '.hd-emps label{display:flex;gap:8px;align-items:center;padding:6px 2px;border-bottom:1px solid var(--border-subtle);font-size:13.5px;cursor:pointer;}' +
      '.hd-tag{font-size:10.5px;padding:2px 7px;border-radius:6px;background:var(--bg-elevated);color:var(--text-muted);margin-left:auto;}' +
      '.hd-tag.minor{background:#e8e6ff;color:#3d33a6;font-weight:700;} .hd-tag.warn{background:#fff4d6;color:#8a5a00;}' +
      '.hd-callout{background:#fff8e6;border:1px solid #f0dca6;border-radius:10px;padding:12px 14px;font-size:13px;color:#6b4e00;margin-bottom:14px;}' +
      '.hd-callout.ok{background:#ecf9f0;border-color:#b9e5c6;color:#176b34;}' +
      '.hd-audit{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg-elevated);border-radius:8px;padding:10px 12px;max-height:260px;overflow:auto;}' +
      '.hd-audit div{padding:3px 0;border-bottom:1px solid var(--border-subtle);}' +
      '.hd-modal{position:fixed;inset:0;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;}' +
      '.hd-modal .box{background:#fff;border-radius:14px;max-width:620px;width:100%;max-height:90vh;overflow:auto;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);}' +
      '.hd-modal h4{margin:0 0 6px;font-family:var(--font-serif);font-size:1.3rem;}' +
      '.hd-link{display:flex;gap:8px;margin:4px 0;} .hd-link input{flex:1;font-size:12px;}' +
      '.hd-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:#1c1f26;color:#fff;padding:11px 18px;border-radius:10px;font-size:13.5px;z-index:10001;opacity:0;transition:.25s;}' +
      '.hd-toast.on{opacity:1;transform:translateX(-50%) translateY(0);} .hd-toast.bad{background:#a52a1e;}';
    var st = document.createElement('style'); st.id = 'hdStyles'; st.textContent = css; document.head.appendChild(st);
  }

  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="' + TAB + '"]')) {
      var item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = TAB;
      item.innerHTML = '<span class="sb-ic">🗂️</span><span class="sb-lbl">Personnel Docs</span>';
      var team = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /^\s*team\s*$/i.test(s.textContent); });
      var grp = team && team.nextElementSibling && team.nextElementSibling.classList.contains('sb-nav-group') ? team.nextElementSibling : null;
      if (grp) grp.appendChild(item);
      else {
        var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
        grp = document.createElement('div'); grp.className = 'sb-nav-group'; grp.appendChild(item);
        nav.appendChild(sec); nav.appendChild(grp);
      }
    }
    if (!$('hrdocsTab')) {
      var any = document.querySelector('.tab-content');
      if (any) { var div = document.createElement('div'); div.id = 'hrdocsTab'; div.className = 'tab-content'; div.innerHTML = '<div id="hdBody"></div>'; any.parentNode.appendChild(div); }
    }
  }

  /* ================= shell ================= */
  var lastOpen = 0;
  function open(v) {
    if (!v && Date.now() - lastOpen < 400) return; // nav click can fire twice
    lastOpen = Date.now();
    if (v) view = v;
    var body = $('hdBody'); if (!body) return;
    body.innerHTML = '<div class="hd-sub">Loading…</div>';
    api('meta').then(function (m) {
      if (m.error) { body.innerHTML = '<div class="hd-callout">' + esc(m.error) + '</div>'; return; }
      META = m;
      var tabs = [['assign', 'Send a document'], ['status', 'Status'], ['docs', 'Documents'], ['people', 'Personnel files'], ['unsigned', 'Who hasn\'t signed']];
      body.innerHTML = '<h2>Personnel Docs</h2><div class="hd-sub">Send policies, training sign-offs' + (m.is_admin ? ' and disciplinary notices' : '') +
        ' for e-signature. Signing means <b>acknowledged receipt, not agreement</b>. ' +
        (m.is_admin ? 'You are an HR admin.' : 'You see policy and training documents for: ' + esc((m.departments || []).join(', ')) + '.') +
        (m.email_mode === 'off' ? ' <b>Email is off</b>: copy the signing link to send it yourself.' : '') + '</div>' +
        '<div class="hd-tabs">' + tabs.map(function (t) { return '<button data-v="' + t[0] + '" class="' + (view === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div id="hdView"></div>';
      Array.prototype.forEach.call(body.querySelectorAll('.hd-tabs button'), function (b) { b.onclick = function () { open(b.dataset.v); }; });
      return Promise.all([api('employees_list'), api('documents_list')]).then(function (r) {
        EMPS = r[0].employees || []; DOCS = r[1].documents || [];
        ({ assign: vAssign, status: vStatus, docs: vDocs, people: vPeople, unsigned: vUnsigned })[view]();
      });
    });
  }

  /* ================= assign ================= */
  function vAssign() {
    var el = $('hdView');
    if (!DOCS.length) { el.innerHTML = '<div class="hd-callout">No documents yet. ' + (META.is_admin ? 'Add one under <b>Documents</b>.' : 'Ask an HR admin to add one.') + '</div>'; return; }
    el.innerHTML = '<div class="hd-card"><h3>1 · Document</h3><select class="hd-sel" id="hdDoc">' +
      DOCS.map(function (d) { return '<option value="' + d.id + '">' + esc(KIND[d.kind] + ' · ' + d.title + ' (v' + d.version + ')') + '</option>'; }).join('') + '</select>' +
      '<div class="hd-hint" id="hdDocHint"></div></div>' +
      '<div class="hd-card"><h3>2 · Who</h3><div class="hd-grid" style="margin-bottom:10px;"><input class="hd-in" id="hdQ" placeholder="Search staff">' +
      '<select class="hd-sel" id="hdDept"><option value="">All departments</option><option>FOH</option><option>BOH</option><option>Bar</option><option>Events</option><option>Management</option><option>Other</option></select></div>' +
      '<div class="hd-emps" id="hdEmps"></div><div class="hd-hint"><a href="#" id="hdAll">Select all shown</a> · <a href="#" id="hdNone">Clear</a> · <span id="hdCount">0</span> selected</div></div>' +
      '<div class="hd-card"><h3>3 · Send</h3><div class="hd-grid"><div class="hd-f"><label class="hd-lbl">Due date (optional)</label><input type="date" class="hd-in" id="hdDue"></div></div>' +
      '<button class="hd-btn" id="hdSend">Send for signature</button> <span class="hd-hint" id="hdSendHint"></span></div><div id="hdResult"></div>';
    function docHint() {
      var d = DOCS.find(function (x) { return x.id === $('hdDoc').value; });
      $('hdDocHint').innerHTML = d ? esc(d.page_count + ' page(s) · SHA-256 ' + d.sha256.slice(0, 16) + '… · ' + d.signed + ' of ' + d.assigned + ' signed') +
        (d.kind === 'discipline' ? ' · <b>one person at a time</b>' : '') : '';
    }
    function list() {
      var q = $('hdQ').value.toLowerCase(), dep = $('hdDept').value;
      $('hdEmps').innerHTML = EMPS.filter(function (e) { return e.active && (!q || e.full_name.toLowerCase().indexOf(q) >= 0) && (!dep || e.department === dep); }).map(function (e) {
        return '<label><input type="checkbox" data-id="' + e.id + '"' + (sel[e.id] ? ' checked' : '') + '> ' + esc(e.full_name) +
          '<span class="hd-tag">' + esc(e.department) + (e.position ? ' · ' + esc(e.position) : '') + '</span>' +
          (e.minor ? '<span class="hd-tag minor">Minor</span>' : '') + (!e.email ? '<span class="hd-tag warn">No email</span>' : '') + '</label>';
      }).join('') || '<div class="hd-hint">No staff match.</div>';
      Array.prototype.forEach.call($('hdEmps').querySelectorAll('input'), function (c) { c.onchange = function () { if (c.checked) sel[c.dataset.id] = 1; else delete sel[c.dataset.id]; count(); }; });
      count();
    }
    function count() { $('hdCount').textContent = Object.keys(sel).length; }
    $('hdDoc').onchange = docHint; $('hdQ').oninput = list; $('hdDept').onchange = list;
    $('hdAll').onclick = function (e) { e.preventDefault(); Array.prototype.forEach.call($('hdEmps').querySelectorAll('input'), function (c) { sel[c.dataset.id] = 1; }); list(); };
    $('hdNone').onclick = function (e) { e.preventDefault(); sel = {}; list(); };
    $('hdSend').onclick = function () {
      var ids = Object.keys(sel); if (!ids.length) { toast('Pick at least one person.', true); return; }
      var b = this; b.disabled = true;
      api('assign', { document_id: $('hdDoc').value, employee_ids: ids, due_date: $('hdDue').value || null }).then(function (r) {
        b.disabled = false;
        if (r.error) { toast(r.error, true); return; }
        sel = {}; list();
        $('hdResult').innerHTML = '<div class="hd-card"><h3>Sent · ' + r.assigned.length + '</h3>' + r.assigned.map(function (a) {
          return '<div style="margin-bottom:10px;"><b>' + esc(a.employee) + '</b> · ' + esc(a.ref_no) + ' · ' + (a.emailed ? 'emailed' : '<span style="color:#8a5a00">not emailed (email off or missing) — send this private link yourself</span>') +
            (a.minor ? ' · <span class="hd-pill awaiting_guardian">Minor: guardian signs after</span>' : '') + (a.missing_guardian ? ' <b style="color:#a52a1e">No guardian email on file</b>' : '') +
            '<div class="hd-link"><input class="hd-in" readonly value="' + esc(a.link) + '"><button class="hd-btn sec sm" data-copy="' + esc(a.link) + '">Copy</button></div></div>';
        }).join('') + '</div>';
        Array.prototype.forEach.call($('hdResult').querySelectorAll('[data-copy]'), function (c) { c.onclick = function () { navigator.clipboard.writeText(c.dataset.copy); toast('Link copied'); }; });
      });
    };
    docHint(); list();
  }

  /* ================= status ================= */
  function vStatus() {
    var el = $('hdView');
    el.innerHTML = '<div class="hd-bar" style="display:flex;gap:10px;margin-bottom:12px;"><select class="hd-sel" id="hdSt" style="max-width:240px;"><option value="">All statuses</option>' +
      Object.keys(STATUS).filter(function (k) { return k !== 'not_sent'; }).map(function (k) { return '<option value="' + k + '">' + STATUS[k] + '</option>'; }).join('') + '</select></div><div id="hdList">Loading…</div>';
    function load() {
      api('assignments_list', { status: $('hdSt').value || null }).then(function (r) {
        var rows = r.assignments || [];
        $('hdList').innerHTML = rows.length ? '<table class="hd-table"><thead><tr><th>Employee</th><th>Document</th><th>Status</th><th>Sent</th><th>Ref</th></tr></thead><tbody>' +
          rows.map(function (a) { return '<tr class="click" data-id="' + a.id + '"><td>' + esc(a.full_name) + '</td><td><span class="hd-kind ' + a.kind + '">' + KIND[a.kind] + '</span><br>' + esc(a.title) + '</td><td>' + pill(a.status) + '</td><td>' + ct(a.created_at) + '</td><td>' + esc(a.ref_no) + '</td></tr>'; }).join('') +
          '</tbody></table>' : '<div class="hd-hint">Nothing here yet.</div>';
        Array.prototype.forEach.call($('hdList').querySelectorAll('tr.click'), function (tr) { tr.onclick = function () { detail(tr.dataset.id); }; });
      });
    }
    $('hdSt').onchange = load; load();
  }

  function detail(id) {
    api('assignment_get', { id: id }).then(function (r) {
      if (r.error) { toast(r.error, true); return; }
      var a = r.assignment, isOpen = ['sent', 'viewed', 'awaiting_guardian'].indexOf(a.status) >= 0;
      var m = modal('<h4>' + esc(a.title) + '</h4><div class="hd-sub">' + esc(a.full_name) + ' · ' + esc(a.ref_no) + ' · ' + pill(a.status) + '</div>' +
        '<div class="hd-card"><h3>Signatures</h3>' + (r.signatures.length ? r.signatures.map(function (s) {
          return '<div style="margin-bottom:8px;"><b>' + (s.party === 'guardian' ? 'Parent/guardian' : 'Employee') + ':</b> ' + esc(s.signer_name) + ' · ' + ct(s.signed_at) + ' · IP ' + esc(s.ip) +
            (s.comments ? '<div class="hd-hint">Comments: ' + esc(s.comments) + '</div>' : '') + '</div>';
        }).join('') : '<div class="hd-hint">Not signed yet.</div>') +
        (a.refusal_witness ? '<div><b>Refused to sign</b>, witnessed by ' + esc(a.refusal_witness) + ' (recorded by ' + esc(a.refusal_recorded_by) + ')</div>' : '') +
        (a.decline_reason ? '<div><b>Declined:</b> ' + esc(a.decline_reason) + '</div>' : '') + '</div>' +
        '<div class="hd-card"><h3>Audit trail (CT)</h3><div class="hd-audit">' + r.audit.map(function (e) { return '<div>' + ct(e.created_at) + ' · ' + esc(e.event) + ' · ' + esc(e.actor) + (e.ip ? ' · ' + esc(e.ip) : '') + '</div>'; }).join('') + '</div>' +
        '<div class="hd-hint">Document SHA-256: ' + esc(a.doc_sha256) + (a.final_pdf_sha256 ? '<br>Signed PDF SHA-256: ' + esc(a.final_pdf_sha256) : '') + '</div></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        (a.final_pdf_path ? '<button class="hd-btn" data-a="final">Download signed PDF</button>' : '') +
        '<button class="hd-btn sec" data-a="orig">Original</button>' +
        (isOpen ? '<button class="hd-btn sec" data-a="remind">New link / remind</button>' : '') +
        (['sent', 'viewed'].indexOf(a.status) >= 0 ? '<button class="hd-btn danger" data-a="refuse">Refused in person</button>' : '') +
        (META.is_admin && a.status !== 'voided' ? '<button class="hd-btn danger" data-a="void">Void</button>' : '') +
        '<button class="hd-btn sec" data-a="close" style="margin-left:auto;">Close</button></div>');
      m.querySelector('[data-a=close]').onclick = function () { m.remove(); };
      var q = function (k) { return m.querySelector('[data-a=' + k + ']'); };
      if (q('final')) q('final').onclick = function () { api('download', { id: id, which: 'final' }).then(savePdf); };
      q('orig').onclick = function () { api('download', { id: id, which: 'original' }).then(savePdf); };
      if (q('remind')) q('remind').onclick = function () {
        api('remind', { id: id }).then(function (x) { if (x.error) return toast(x.error, true); m.remove(); modal('<h4>New private link</h4><div class="hd-sub">' + (x.emailed ? 'Emailed. ' : 'Email is off: send this yourself. ') + 'The old link no longer works.</div><div class="hd-link"><input class="hd-in" readonly value="' + esc(x.link) + '"></div>'); });
      };
      if (q('refuse')) q('refuse').onclick = function () {
        m.remove();
        var r2 = modal('<h4>Refused to sign (in person)</h4><div class="hd-sub">Have a second manager present. The document still stands.</div>' +
          '<div class="hd-f"><label class="hd-lbl">Witness name *</label><input class="hd-in" id="hdW"></div><div class="hd-f"><label class="hd-lbl">Note</label><textarea class="hd-ta" id="hdWn">Document was reviewed with the employee, who declined to sign. A copy was provided.</textarea></div>' +
          '<button class="hd-btn danger" id="hdWgo">Record refusal</button>');
        r2.querySelector('#hdWgo').onclick = function () {
          api('record_refusal', { id: id, witness: r2.querySelector('#hdW').value, note: r2.querySelector('#hdWn').value }).then(function (x) { toast(x.error || 'Refusal recorded.', !!x.error); if (!x.error) { r2.remove(); open('status'); } });
        };
      };
      if (q('void')) q('void').onclick = function () {
        var why = prompt('Reason for voiding? (It stays on file marked VOID; nothing is deleted.)'); if (!why) return;
        api('void', { id: id, reason: why }).then(function (x) { toast(x.error || 'Voided.', !!x.error); m.remove(); vStatus(); });
      };
    });
  }

  /* ================= documents ================= */
  function vDocs() {
    var el = $('hdView');
    el.innerHTML = (META.is_admin ? '<div class="hd-card"><h3>Add a document</h3><div class="hd-grid">' +
      '<div class="hd-f"><label class="hd-lbl">Type</label><select class="hd-sel" id="hdK">' + Object.keys(META.kinds).map(function (k) { return '<option value="' + k + '">' + esc(META.kinds[k]) + '</option>'; }).join('') + '</select></div>' +
      '<div class="hd-f"><label class="hd-lbl">Title</label><input class="hd-in" id="hdT" placeholder="e.g. Alcohol Service Policy Acknowledgment"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Tracking key (optional)</label><select class="hd-sel" id="hdPK"><option value="">—</option><option value="alcohol_ack">Alcohol acknowledgment (used by “Who hasn\'t signed”)</option><option value="handbook_ack">Handbook acknowledgment</option></select></div></div>' +
      '<div class="hd-f"><label class="hd-lbl">Upload a PDF</label><input type="file" accept="application/pdf" id="hdFile"><div class="hd-hint">…or type the text below and we\'ll make the PDF.</div></div>' +
      '<div class="hd-f"><textarea class="hd-ta" id="hdBodyT" placeholder="Document text"></textarea></div>' +
      '<label style="font-size:13px;"><input type="checkbox" id="hdG" checked> Minors also need a parent/guardian signature</label><br><br>' +
      '<button class="hd-btn" id="hdCreate">Save document</button><div class="hd-hint">Saved documents can\'t be edited; that keeps the signed version provable. Upload a new document to change it.</div></div>' : '') +
      '<table class="hd-table"><thead><tr><th>Document</th><th>Type</th><th>Signed</th><th>Fingerprint</th><th>Added</th></tr></thead><tbody>' +
      DOCS.map(function (d) { return '<tr><td>' + esc(d.title) + (d.policy_key ? ' <span class="hd-tag">' + esc(d.policy_key) + '</span>' : '') + '</td><td><span class="hd-kind ' + d.kind + '">' + KIND[d.kind] + '</span></td><td>' + d.signed + ' / ' + d.assigned + '</td><td style="font-family:monospace;font-size:11px;">' + esc(d.sha256.slice(0, 12)) + '…</td><td>' + ct(d.created_at) + '</td></tr>'; }).join('') + '</tbody></table>';
    if (!META.is_admin) return;
    $('hdCreate').onclick = function () {
      var b = this, f = $('hdFile').files[0];
      var payload = { kind: $('hdK').value, title: $('hdT').value, policy_key: $('hdPK').value || null, guardian_for_minors: $('hdG').checked };
      function go() { b.disabled = true; api('document_create', payload).then(function (r) { b.disabled = false; toast(r.error || 'Saved.', !!r.error); if (!r.error) open('docs'); }); }
      if (f) { var rd = new FileReader(); rd.onload = function () { payload.pdf_base64 = String(rd.result).split(',')[1]; payload.filename = f.name; go(); }; rd.readAsDataURL(f); }
      else { payload.body_text = $('hdBodyT').value; go(); }
    };
  }

  /* ================= personnel files ================= */
  function vPeople() {
    var el = $('hdView');
    el.innerHTML = '<div class="hd-grid" style="grid-template-columns:260px 1fr;align-items:start;"><div class="hd-card" style="padding:10px;"><input class="hd-in" id="hdPQ" placeholder="Search staff" style="margin-bottom:8px;"><div id="hdPL"></div>' +
      (META.is_admin ? '<button class="hd-btn sec sm" id="hdNew" style="margin-top:8px;">+ Add / edit person</button> <button class="hd-btn sec sm" id="hdImp" style="margin-top:8px;">Import roster</button>' : '') + '</div><div id="hdPF"><div class="hd-hint">Pick someone to see their file.</div></div></div>';
    function list() {
      var q = $('hdPQ').value.toLowerCase();
      $('hdPL').innerHTML = EMPS.filter(function (e) { return !q || e.full_name.toLowerCase().indexOf(q) >= 0; }).map(function (e) {
        return '<div class="hd-pp" data-id="' + e.id + '" style="padding:7px 6px;border-radius:6px;cursor:pointer;font-size:13.5px;">' + esc(e.full_name) + (e.minor ? ' <span class="hd-tag minor">Minor</span>' : '') + (!e.active ? ' <span class="hd-tag">Inactive</span>' : '') + '</div>';
      }).join('');
      Array.prototype.forEach.call($('hdPL').querySelectorAll('.hd-pp'), function (d) { d.onclick = function () { file(d.dataset.id); }; });
    }
    $('hdPQ').oninput = list; list();
    if ($('hdImp')) $('hdImp').onclick = function () { api('employees_import').then(function (r) { toast(r.error || ('Added ' + r.added + ' people.'), !!r.error); open('people'); }); };
    if ($('hdNew')) $('hdNew').onclick = function () { editEmp({}); };
  }
  function file(id) {
    api('personnel_file', { employee_id: id }).then(function (r) {
      if (r.error) { toast(r.error, true); return; }
      var e = r.employee;
      $('hdPF').innerHTML = '<div class="hd-card"><h3>Personnel file</h3><div style="font-size:20px;font-weight:700;">' + esc(e.full_name) + '</div>' +
        '<div class="hd-sub">' + esc(e.department) + (e.position ? ' · ' + esc(e.position) : '') + (e.email ? ' · ' + esc(e.email) : ' · no email on file') +
        (e.minor ? ' · <span class="hd-tag minor">Minor</span>' + (META.is_admin ? ' guardian: ' + esc(e.guardian_name || '—') + ' &lt;' + esc(e.guardian_email || 'missing') + '&gt;' : '') : '') + '</div>' +
        (META.is_admin ? '<button class="hd-btn sec sm" id="hdEdit">Edit details</button>' : '') + '</div>' +
        '<table class="hd-table"><thead><tr><th>Document</th><th>Status</th><th>Sent</th><th>Completed</th><th></th></tr></thead><tbody>' +
        (r.documents.map(function (d) {
          return '<tr class="click" data-id="' + d.id + '"><td><span class="hd-kind ' + d.kind + '">' + KIND[d.kind] + '</span><br>' + esc(d.title) + ' <span class="hd-hint">v' + d.version + ' · ' + esc(d.ref_no) + '</span></td><td>' + pill(d.status) +
            '</td><td>' + ct(d.created_at) + '</td><td>' + ct(d.completed_at) + '</td><td>' + (d.final_pdf_sha256 ? '📄' : '') + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="hd-hint">No documents yet.</td></tr>') + '</tbody></table>' +
        (r.legacy_writeups && r.legacy_writeups.length ? '<div class="hd-card" style="margin-top:14px;"><h3>Older write-ups (Write-Ups tab)</h3>' + r.legacy_writeups.map(function (w) { return '<div>' + esc(w.ref_no) + ' · ' + esc(w.level) + ' · ' + esc(w.status) + '</div>'; }).join('') + '</div>' : '');
      Array.prototype.forEach.call($('hdPF').querySelectorAll('tr.click'), function (tr) { tr.onclick = function () { detail(tr.dataset.id); }; });
      if ($('hdEdit')) $('hdEdit').onclick = function () { editEmp(Object.assign({}, EMPS.find(function (x) { return x.id === id; }) || {}, e)); };
    });
  }
  function editEmp(e) {
    var m = modal('<h4>' + (e.id ? 'Edit ' + esc(e.full_name) : 'Add a person') + '</h4><div class="hd-grid">' +
      '<div class="hd-f"><label class="hd-lbl">Full legal name</label><input class="hd-in" id="eN" value="' + esc(e.full_name || '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Email</label><input class="hd-in" id="eE" value="' + esc(e.email || '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Phone last 4</label><input class="hd-in" id="eP" maxlength="4" placeholder="' + (e.has_phone4 ? 'on file (enter to replace)' : '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Date of birth</label><input type="date" class="hd-in" id="eD" value="' + esc(e.dob || '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Department</label><select class="hd-sel" id="eDp">' + ['FOH', 'BOH', 'Bar', 'Events', 'Management', 'Other'].map(function (d) { return '<option' + (e.department === d ? ' selected' : '') + '>' + d + '</option>'; }).join('') + '</select></div>' +
      '<div class="hd-f"><label class="hd-lbl">Position</label><input class="hd-in" id="eJ" value="' + esc(e.position || '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Parent/guardian name (minors)</label><input class="hd-in" id="eGN" value="' + esc(e.guardian_name || '') + '"></div>' +
      '<div class="hd-f"><label class="hd-lbl">Parent/guardian email</label><input class="hd-in" id="eGE" value="' + esc(e.guardian_email || '') + '"></div></div>' +
      '<label style="font-size:13px;"><input type="checkbox" id="eA"' + (e.active === false ? '' : ' checked') + '> Active</label><br><br><button class="hd-btn" id="eGo">Save</button>');
    m.querySelector('#eGo').onclick = function () {
      var v = function (k) { return m.querySelector('#' + k).value; };
      var payload = { id: e.id, full_name: v('eN'), email: v('eE'), dob: v('eD'), department: v('eDp'), position: v('eJ'), guardian_name: v('eGN'), guardian_email: v('eGE'), active: m.querySelector('#eA').checked };
      if (v('eP')) payload.phone_last4 = v('eP');
      api('employee_save', { employee: payload }).then(function (r) { toast(r.error || 'Saved.', !!r.error); if (!r.error) { m.remove(); open('people'); } });
    };
  }

  /* ================= unsigned ================= */
  function vUnsigned() {
    var el = $('hdView');
    var opts = DOCS.filter(function (d) { return d.kind !== 'discipline'; });
    var def = (opts.find(function (d) { return d.policy_key === 'alcohol_ack'; }) || opts[0] || {}).id;
    el.innerHTML = '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;"><select class="hd-sel" id="hdU" style="max-width:420px;">' +
      opts.map(function (d) { return '<option value="' + d.id + '"' + (d.id === def ? ' selected' : '') + '>' + esc(d.title) + '</option>'; }).join('') + '</select>' +
      '<button class="hd-btn sec" id="hdUsend">Send to everyone not yet sent</button></div><div id="hdUL">Loading…</div>';
    function load() {
      if (!$('hdU').value) { $('hdUL').innerHTML = '<div class="hd-hint">No policy or training documents yet.</div>'; return; }
      api('unsigned', { document_id: $('hdU').value }).then(function (r) {
        if (r.error) { $('hdUL').innerHTML = '<div class="hd-callout">' + esc(r.error) + '</div>'; return; }
        var rows = r.rows || [];
        $('hdUL').innerHTML = '<div class="hd-callout' + (rows.length ? '' : ' ok') + '"><b>' + rows.length + '</b> active ' + (rows.length === 1 ? 'person has' : 'people have') + ' not signed <b>' + esc(r.document.title) + '</b>.</div>' +
          (rows.length ? '<table class="hd-table"><thead><tr><th>Employee</th><th>Dept</th><th>Status</th><th>Sent</th><th>Last emailed</th><th></th></tr></thead><tbody>' +
            rows.map(function (x) {
              return '<tr><td>' + esc(x.full_name) + (x.email ? '' : ' <span class="hd-tag warn">No email</span>') + '</td><td>' + esc(x.department) + '</td><td>' + pill(x.status) + '</td><td>' + ct(x.sent_at) + '</td><td>' + ct(x.last_emailed_at) + '</td><td>' +
                (x.assignment_id ? '<button class="hd-btn sec sm" data-open="' + x.assignment_id + '">Open</button>' : '') + '</td></tr>';
            }).join('') + '</tbody></table>' : '');
        Array.prototype.forEach.call($('hdUL').querySelectorAll('[data-open]'), function (b) { b.onclick = function () { detail(b.dataset.open); }; });
      });
    }
    $('hdU').onchange = load;
    $('hdUsend').onclick = function () {
      if (!confirm('Send this document to every active person who has not been sent it yet?')) return;
      api('assign', { document_id: $('hdU').value, all_active: true }).then(function (r) { toast(r.error || ('Sent to ' + r.assigned.length + '.'), !!r.error); load(); });
    };
    load();
  }

  /* ---------- boot ---------- */
  window.HrDocsUI = { open: open };
  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._hd) {
      window.switchTab = function (name) { var out = orig.apply(this, arguments); if (name === TAB) open(); return out; };
      window.switchTab._hd = true;
      Object.keys(orig).forEach(function (k) { if (k !== '_hd') window.switchTab[k] = orig[k]; });
    }
    var item = document.querySelector('.sb-nav-item[data-tab="' + TAB + '"]');
    if (item && !item._hdBound) { item._hdBound = true; item.addEventListener('click', function () { window.switchTab(TAB); }); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 700); });
  else setTimeout(boot, 700);
})();
