/* ============================================================================
 * The Quarry STL — Admin "Contracts" (e-signature) module
 * Self-injecting: adds a sidebar nav item + #contractsTab panel, wraps switchTab.
 * Deployed as /admin/esign.js and loaded with <script src="./esign.js"></script>.
 * Backend: Supabase edge function `esign` (project nkulhtalltbieicvmmad).
 * ==========================================================================*/
(function () {
  'use strict';

  const FN_BASE = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/esign';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdWxodGFsbHRiaWVpY3ZtbWFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMTU0NzksImV4cCI6MjA4OTY5MTQ3OX0.CqNu8CaZle-v5Sw5P7YAFk5HV8aAkqBdXPIvVqPBves'; // Supabase publishable anon key

  const S = {
    pdfBase64: null, pageCount: 0, pdfDoc: null,
    recipients: [{ name: '', email: '' }],
    fields: [], armed: null, activeRecip: 0, scale: 1,
  };
  const uid = () => 'f' + Math.random().toString(36).slice(2, 9);

  function adminToken() { return localStorage.getItem('quarryAdminToken') || ''; }
  async function api(action, extra = {}) {
    const r = await fetch(FN_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': ANON_KEY, 'Authorization': 'Bearer ' + ANON_KEY,
        'x-admin-token': adminToken(),
      },
      body: JSON.stringify({ action, ...extra }),
    });
    return r.json();
  }

  /* ---------- inject styles ---------- */
  function injectStyles() {
    if (document.getElementById('esignStyles')) return;
    const css = `
    #contractsTab .es-head{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;}
    #contractsTab h2{margin:0;color:#6b2020;}
    .es-btn{background:#6b2020;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;cursor:pointer;font-size:14px;}
    .es-btn.sec{background:#eee;color:#444;}
    .es-btn.danger{background:#b3261e;}
    .es-btn:disabled{opacity:.5;cursor:not-allowed;}
    .es-card{background:#fff;border:1px solid #e4ddd4;border-radius:12px;padding:16px 18px;margin-bottom:14px;}
    .es-table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e4ddd4;}
    .es-table th,.es-table td{text-align:left;padding:11px 14px;border-bottom:1px solid #f0eae2;font-size:14px;}
    .es-table th{background:#f6f2ee;color:#6b2020;font-size:12px;text-transform:uppercase;letter-spacing:.4px;}
    .es-pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;}
    .es-pill.draft{background:#eee;color:#666;} .es-pill.sent{background:#fff3cd;color:#8a6d00;}
    .es-pill.completed{background:#d7efd9;color:#1f6b26;} .es-pill.voided{background:#f7d9d9;color:#a12626;}
    .es-input{width:100%;padding:9px 11px;border:1px solid #d9cfc2;border-radius:8px;font-size:14px;box-sizing:border-box;}
    .es-recip-row{display:flex;gap:8px;margin-bottom:8px;align-items:center;}
    .es-palette{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;}
    .es-tool{border:1px solid #d9cfc2;background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:13px;user-select:none;}
    .es-tool.on{background:#6b2020;color:#fff;border-color:#6b2020;}
    .es-pagewrap{position:relative;margin:0 auto 14px;width:fit-content;box-shadow:0 2px 12px rgba(0,0,0,.12);}
    .es-pagewrap canvas{display:block;}
    .es-ov{position:absolute;inset:0;cursor:crosshair;}
    .es-fld{position:absolute;border:2px solid #6b2020;background:rgba(107,32,32,.08);border-radius:3px;font-size:10px;color:#6b2020;display:flex;align-items:center;justify-content:center;cursor:move;overflow:visible;}
    .es-fld .lbl{pointer-events:none;font-weight:700;text-transform:uppercase;font-size:9px;}
    .es-fld .rz{position:absolute;right:-5px;bottom:-5px;width:12px;height:12px;background:#6b2020;border-radius:2px;cursor:nwse-resize;}
    .es-fld .del{position:absolute;top:-9px;right:-9px;width:18px;height:18px;background:#b3261e;color:#fff;border-radius:50%;font-size:12px;line-height:18px;text-align:center;cursor:pointer;}
    .es-fld .rc{position:absolute;left:0;bottom:-16px;font-size:8px;background:#6b2020;color:#fff;padding:0 4px;border-radius:3px;white-space:nowrap;}
    .es-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center;z-index:9999;padding:20px;}
    .es-modal.on{display:flex;}
    .es-modal .box{background:#fff;border-radius:14px;max-width:640px;width:100%;max-height:88vh;overflow:auto;padding:22px;}
    .es-audit{font-family:monospace;font-size:12px;background:#faf7f3;border-radius:8px;padding:12px;max-height:280px;overflow:auto;}
    .es-audit div{padding:3px 0;border-bottom:1px solid #efe8df;}`;
    const st = document.createElement('style'); st.id = 'esignStyles'; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- inject nav + panel ---------- */
  function injectDom() {
    // nav
    const nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="contracts"]')) {
      const sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Legal';
      const grp = document.createElement('div'); grp.className = 'sb-nav-group';
      const item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = 'contracts';
      item.innerHTML = '<span class="sb-ic">✒️</span><span class="sb-lbl">Contracts</span>';
      item.addEventListener('click', () => window.switchTab && window.switchTab('contracts'));
      grp.appendChild(item); nav.appendChild(sec); nav.appendChild(grp);
    }
    // panel
    if (!document.getElementById('contractsTab')) {
      const any = document.querySelector('.tab-content');
      if (any) {
        const div = document.createElement('div'); div.id = 'contractsTab'; div.className = 'tab-content';
        div.innerHTML = '<div class="es-head"><h2>✒️ Contracts &amp; E-Signatures</h2></div><div id="esBody"></div>';
        any.parentNode.appendChild(div);
      }
    }
  }

  /* ---------- ensure pdf.js ---------- */
  function ensurePdfJs() {
    return new Promise((res) => {
      if (window.pdfjsLib) return res();
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(); };
      document.head.appendChild(s);
    });
  }

  /* ================= DASHBOARD ================= */
  async function showDashboard() {
    const body = document.getElementById('esBody');
    body.innerHTML = '<div class="es-head" style="justify-content:space-between;"><p style="color:#777;margin:0;">Upload a PDF, place signature &amp; text fields, and send it out for legally-tracked signatures.</p><button class="es-btn" id="esNewBtn">+ New contract</button></div><div id="esList"><p style="color:#999;">Loading…</p></div>';
    document.getElementById('esNewBtn').onclick = showBuilder;
    const res = await api('admin_list');
    const list = document.getElementById('esList');
    if (res.error) { list.innerHTML = '<div class="es-card" style="color:#a12626;">Could not load: ' + res.error + '</div>'; return; }
    const docs = res.documents || [];
    if (!docs.length) { list.innerHTML = '<div class="es-card" style="color:#999;">No contracts yet. Click “New contract” to begin.</div>'; return; }
    let h = '<table class="es-table"><thead><tr><th>Document</th><th>Status</th><th>Signers</th><th>Created</th><th></th></tr></thead><tbody>';
    docs.forEach(d => {
      const signed = (d.recipients || []).filter(r => r.status === 'signed').length;
      const tot = (d.recipients || []).length;
      h += `<tr><td><strong>${esc(d.title)}</strong></td>`
        + `<td><span class="es-pill ${d.status}">${d.status}</span></td>`
        + `<td>${signed}/${tot} signed</td>`
        + `<td>${new Date(d.created_at).toLocaleDateString()}</td>`
        + `<td style="text-align:right;white-space:nowrap;">`
        + `<button class="es-btn sec" style="padding:6px 10px;" onclick="EsignUI.openDoc('${d.id}')">Open</button></td></tr>`;
    });
    h += '</tbody></table>';
    list.innerHTML = h;
  }

  async function openDoc(id) {
    const res = await api('admin_get', { id });
    if (res.error) { alert(res.error); return; }
    const d = res.document, recs = res.recipients || [], audit = res.audit || [];
    let h = `<button class="es-btn sec" style="margin-bottom:12px;" onclick="EsignUI.dash()">← Back</button>`;
    h += `<div class="es-card"><div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center;">`
      + `<div><h3 style="margin:0;color:#6b2020;">${esc(d.title)}</h3><span class="es-pill ${d.status}">${d.status}</span></div><div>`;
    if (d.status === 'draft') h += `<button class="es-btn" onclick="EsignUI.send('${d.id}')">Send for signature</button> `;
    if (d.status === 'completed' || d.status === 'sent') h += `<button class="es-btn sec" onclick="EsignUI.download('${d.id}')">Download PDF</button> `;
    if (d.status !== 'voided' && d.status !== 'completed') h += `<button class="es-btn danger" onclick="EsignUI.voidDoc('${d.id}')">Void</button>`;
    h += `</div></div></div>`;
    h += `<div class="es-card"><h4 style="margin-top:0;">Signers</h4><table class="es-table"><thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Signed</th><th>IP</th><th></th></tr></thead><tbody>`;
    recs.forEach(r => {
      h += `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td><span class="es-pill ${r.status === 'signed' ? 'completed' : 'sent'}">${r.status}</span></td>`
        + `<td>${r.signed_at ? new Date(r.signed_at).toLocaleString() : '—'}</td><td>${r.signer_ip || '—'}</td>`
        + `<td>${(d.status === 'sent' && r.status !== 'signed') ? `<button class="es-btn sec" style="padding:5px 9px;" onclick="EsignUI.remind('${r.id}')">Remind</button>` : ''}</td></tr>`;
    });
    h += `</tbody></table></div>`;
    h += `<div class="es-card"><h4 style="margin-top:0;">Audit trail</h4><div class="es-audit">`;
    audit.forEach(a => {
      const who = recs.find(r => r.id === a.recipient_id)?.email || 'admin';
      h += `<div>${new Date(a.created_at).toLocaleString()} · <b>${a.event.toUpperCase()}</b> · ${who} · IP ${a.ip || '—'}</div>`;
    });
    h += `</div></div>`;
    document.getElementById('esBody').innerHTML = h;
  }

  async function send(id) {
    if (!confirm('Send this contract to all signers now?')) return;
    const res = await api('admin_send', { id });
    if (res.error) return alert(res.error);
    alert('Sent! Signers have been emailed their private links.');
    openDoc(id);
  }
  async function download(id) {
    const res = await api('admin_download', { id });
    if (res.error) return alert(res.error);
    window.open(res.url, '_blank');
  }
  async function remind(rid) { const res = await api('admin_remind', { recipient_id: rid }); alert(res.error || 'Reminder sent.'); }
  async function voidDoc(id) { const reason = prompt('Reason for voiding (optional):'); if (reason === null) return; const res = await api('admin_void', { id, reason }); if (res.error) return alert(res.error); openDoc(id); }

  /* ================= BUILDER ================= */
  async function showBuilder() {
    Object.assign(S, { pdfBase64: null, pageCount: 0, pdfDoc: null, recipients: [{ name: '', email: '' }], fields: [], armed: null, activeRecip: 0 });
    const body = document.getElementById('esBody');
    body.innerHTML =
      `<button class="es-btn sec" style="margin-bottom:12px;" onclick="EsignUI.dash()">← Back</button>
       <div class="es-card">
         <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
           <div><label style="font-size:13px;font-weight:600;">Contract title</label><input id="esTitle" class="es-input" placeholder="e.g. Turf Installation Agreement — Smith"></div>
           <div><label style="font-size:13px;font-weight:600;">Upload PDF</label><input id="esFile" type="file" accept="application/pdf" class="es-input"></div>
         </div>
         <div style="margin-top:10px;"><label style="font-size:13px;font-weight:600;">Message to signer (optional)</label><textarea id="esMsg" class="es-input" rows="2" placeholder="Please review and sign the attached agreement."></textarea></div>
       </div>
       <div class="es-card">
         <h4 style="margin-top:0;">Signers</h4>
         <div id="esRecips"></div>
         <button class="es-btn sec" style="padding:6px 12px;" onclick="EsignUI.addRecip()">+ Add signer</button>
       </div>
       <div class="es-card" id="esFieldCard" style="display:none;">
         <h4 style="margin-top:0;">Place fields</h4>
         <div style="font-size:13px;color:#777;">Pick a field type, then <b>drag a box</b> on the page. Fields apply to the selected signer.</div>
         <div style="margin:8px 0;font-size:13px;">Fields for signer: <select id="esActiveRecip" class="es-input" style="width:auto;display:inline-block;" onchange="EsignUI.setActive(this.value)"></select></div>
         <div class="es-palette" id="esPalette"></div>
         <div id="esPages"></div>
       </div>
       <div class="es-card" style="display:flex;gap:10px;justify-content:flex-end;">
         <button class="es-btn sec" id="esSaveDraft" disabled onclick="EsignUI.save(false)">Save draft</button>
         <button class="es-btn" id="esSaveSend" disabled onclick="EsignUI.save(true)">Save &amp; Send</button>
       </div>`;
    renderRecips();
    renderPalette();
    document.getElementById('esFile').onchange = onFile;
  }

  const FIELD_TYPES = [
    ['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date'],
    ['text', 'Text'], ['name', 'Name'], ['email', 'Email'], ['checkbox', 'Checkbox'],
  ];
  const DEFAULT_SIZE = { signature: [0.22, 0.05], initials: [0.08, 0.045], date: [0.14, 0.03], text: [0.2, 0.03], name: [0.2, 0.03], email: [0.2, 0.03], checkbox: [0.03, 0.03] };

  function renderPalette() {
    const p = document.getElementById('esPalette'); if (!p) return;
    p.innerHTML = FIELD_TYPES.map(([t, l]) => `<div class="es-tool" data-t="${t}">${l}</div>`).join('');
    p.querySelectorAll('.es-tool').forEach(el => el.onclick = () => {
      S.armed = S.armed === el.dataset.t ? null : el.dataset.t;
      p.querySelectorAll('.es-tool').forEach(x => x.classList.toggle('on', x.dataset.t === S.armed));
    });
  }
  function renderRecips() {
    const c = document.getElementById('esRecips'); if (!c) return;
    c.innerHTML = S.recipients.map((r, i) =>
      `<div class="es-recip-row"><input class="es-input" placeholder="Full name" value="${esc(r.name)}" oninput="EsignUI.recip(${i},'name',this.value)">`
      + `<input class="es-input" placeholder="email@example.com" value="${esc(r.email)}" oninput="EsignUI.recip(${i},'email',this.value)">`
      + (S.recipients.length > 1 ? `<button class="es-btn danger" style="padding:6px 10px;" onclick="EsignUI.delRecip(${i})">✕</button>` : '') + `</div>`).join('');
    const sel = document.getElementById('esActiveRecip');
    if (sel) sel.innerHTML = S.recipients.map((r, i) => `<option value="${i}" ${i == S.activeRecip ? 'selected' : ''}>${esc(r.name || ('Signer ' + (i + 1)))}</option>`).join('');
    validate();
  }

  async function onFile(e) {
    const file = e.target.files[0]; if (!file) return;
    if (file.type !== 'application/pdf') { alert('Please choose a PDF.'); return; }
    const buf = await file.arrayBuffer();
    S.pdfBase64 = 'data:application/pdf;base64,' + btoa(String.fromCharCode(...new Uint8Array(buf)));
    S._fname = file.name;
    await ensurePdfJs();
    S.pdfDoc = await window.pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    S.pageCount = S.pdfDoc.numPages;
    document.getElementById('esFieldCard').style.display = '';
    await renderPages();
    validate();
  }

  async function renderPages() {
    const pagesEl = document.getElementById('esPages'); pagesEl.innerHTML = '';
    const W = Math.min(pagesEl.clientWidth || 780, 780);
    for (let p = 1; p <= S.pageCount; p++) {
      const page = await S.pdfDoc.getPage(p);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = W / vp0.width;
      const vp = page.getViewport({ scale });
      const pw = document.createElement('div'); pw.className = 'es-pagewrap'; pw.style.width = vp.width + 'px';
      const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height; pw.appendChild(cv);
      const ov = document.createElement('div'); ov.className = 'es-ov'; ov.dataset.page = p; pw.appendChild(ov);
      pagesEl.appendChild(pw);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      bindOverlay(ov);
    }
    drawFields();
  }

  function bindOverlay(ov) {
    let startX, startY, ghost;
    ov.addEventListener('mousedown', (e) => {
      if (!S.armed || e.target !== ov) return;
      const r = ov.getBoundingClientRect(); startX = e.clientX - r.left; startY = e.clientY - r.top;
      ghost = document.createElement('div'); ghost.className = 'es-fld'; ghost.style.left = startX + 'px'; ghost.style.top = startY + 'px'; ov.appendChild(ghost);
      const mv = (ev) => { const w = (ev.clientX - r.left) - startX, h = (ev.clientY - r.top) - startY; ghost.style.width = Math.abs(w) + 'px'; ghost.style.height = Math.abs(h) + 'px'; ghost.style.left = Math.min(startX, ev.clientX - r.left) + 'px'; ghost.style.top = Math.min(startY, ev.clientY - r.top) + 'px'; };
      const up = (ev) => {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        const rect = ov.getBoundingClientRect();
        let x = parseFloat(ghost.style.left) / rect.width, y = parseFloat(ghost.style.top) / rect.height;
        let w = (parseFloat(ghost.style.width) || 0) / rect.width, h = (parseFloat(ghost.style.height) || 0) / rect.height;
        ghost.remove();
        if (w < 0.02 || h < 0.012) { const ds = DEFAULT_SIZE[S.armed]; w = ds[0]; h = ds[1]; } // click = default size
        S.fields.push({ id: uid(), type: S.armed, page: +ov.dataset.page, x, y, w, h, recipient_index: S.activeRecip, font_size: 12 });
        S.armed = null; renderPalette(); drawFields(); validate();
      };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function drawFields() {
    document.querySelectorAll('.es-ov').forEach(ov => {
      ov.querySelectorAll('.es-fld').forEach(n => n.remove());
      const page = +ov.dataset.page; const rect = ov.getBoundingClientRect();
      S.fields.filter(f => f.page === page).forEach(f => {
        const el = document.createElement('div'); el.className = 'es-fld';
        el.style.left = (f.x * 100) + '%'; el.style.top = (f.y * 100) + '%';
        el.style.width = (f.w * 100) + '%'; el.style.height = (f.h * 100) + '%';
        el.innerHTML = `<span class="lbl">${f.type}</span><span class="del" title="Delete">✕</span><span class="rz"></span><span class="rc">${esc(S.recipients[f.recipient_index]?.name || ('Signer ' + (f.recipient_index + 1)))}</span>`;
        el.querySelector('.del').onclick = (e) => { e.stopPropagation(); S.fields = S.fields.filter(x => x.id !== f.id); drawFields(); validate(); };
        // drag move
        el.addEventListener('mousedown', (e) => {
          if (e.target.classList.contains('rz') || e.target.classList.contains('del')) return;
          e.stopPropagation(); const or = ov.getBoundingClientRect();
          const ox = e.clientX - (f.x * or.width), oy = e.clientY - (f.y * or.height);
          const mv = (ev) => { f.x = Math.max(0, Math.min(1 - f.w, (ev.clientX - ox) / or.width)); f.y = Math.max(0, Math.min(1 - f.h, (ev.clientY - oy) / or.height)); el.style.left = (f.x * 100) + '%'; el.style.top = (f.y * 100) + '%'; };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        // resize
        el.querySelector('.rz').addEventListener('mousedown', (e) => {
          e.stopPropagation(); const or = ov.getBoundingClientRect();
          const mv = (ev) => { f.w = Math.max(0.02, Math.min(1 - f.x, (ev.clientX - or.left - f.x * or.width) / or.width)); f.h = Math.max(0.012, Math.min(1 - f.y, (ev.clientY - or.top - f.y * or.height) / or.height)); el.style.width = (f.w * 100) + '%'; el.style.height = (f.h * 100) + '%'; };
          const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
        });
        ov.appendChild(el);
      });
    });
  }

  function validate() {
    const okRecips = S.recipients.every(r => r.name.trim() && /.+@.+\..+/.test(r.email));
    const title = (document.getElementById('esTitle')?.value || '').trim();
    const ok = okRecips && S.pdfBase64 && S.fields.length > 0 && title;
    const a = document.getElementById('esSaveDraft'), b = document.getElementById('esSaveSend');
    if (a) a.disabled = !(S.pdfBase64 && title);
    if (b) b.disabled = !ok;
  }

  async function save(sendNow) {
    const title = document.getElementById('esTitle').value.trim();
    const message = document.getElementById('esMsg').value.trim();
    const btns = document.querySelectorAll('#esSaveDraft,#esSaveSend'); btns.forEach(b => b.disabled = true);
    const res = await api('admin_create', {
      title, message, filename: S._fname, page_count: S.pageCount,
      pdf_base64: S.pdfBase64, recipients: S.recipients,
      fields: S.fields.map(f => ({ type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, recipient_index: f.recipient_index, font_size: f.font_size, required: true })),
    });
    if (res.error) { alert('Error: ' + res.error); btns.forEach(b => b.disabled = false); return; }
    if (sendNow) { const s = await api('admin_send', { id: res.id }); if (s.error) { alert('Saved as draft, but send failed: ' + s.error); } else { alert('Sent! Signers have been emailed their private signing links.'); } }
    else alert('Draft saved.');
    dash();
  }

  function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* public API */
  window.EsignUI = {
    onTabSwitch() { showDashboard(); },
    dash: showDashboard, openDoc, send, download, remind, voidDoc,
    addRecip() { S.recipients.push({ name: '', email: '' }); renderRecips(); },
    delRecip(i) { S.recipients.splice(i, 1); if (S.activeRecip >= S.recipients.length) S.activeRecip = 0; S.fields = S.fields.filter(f => f.recipient_index !== i).map(f => { if (f.recipient_index > i) f.recipient_index--; return f; }); renderRecips(); drawFields(); },
    recip(i, k, v) { S.recipients[i][k] = v; if (k === 'name') { renderRecips(); drawFields(); } validate(); },
    setActive(v) { S.activeRecip = +v; },
  };

  /* ---------- boot ---------- */
  function boot() {
    injectStyles(); injectDom();
    // wrap switchTab so opening the tab loads the dashboard
    const orig = window.switchTab;
    if (typeof orig === 'function' && !orig._esign) {
      window.switchTab = function (name) { orig.apply(this, arguments); if (name === 'contracts' && window.EsignUI) window.EsignUI.onTabSwitch(); };
      window.switchTab._esign = true;
    }
    // re-attach nav click (in case injected after setupNavigation)
    const item = document.querySelector('.sb-nav-item[data-tab="contracts"]');
    if (item && !item._bound) { item._bound = true; item.addEventListener('click', () => window.switchTab('contracts')); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 400));
  else setTimeout(boot, 400);
})();
