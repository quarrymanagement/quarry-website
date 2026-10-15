/* ============================================================================
 * The Quarry — Admin "Staff Logins" (OWNER ONLY)
 * Self-injecting: adds "Team › Staff Logins" to the sidebar. Not shown to
 * restricted logins (the sidebar allowlist hides it and nothing is injected
 * unless the signed-in role is owner).
 *
 * Lets the owner set / reset / remove the password of a restricted staff login
 * (e.g. Maya White — server lead: Training Tests + Checklists only). The
 * password is typed here once, sent over HTTPS to admin-staff-logins.js, and
 * stored salted/hashed. It can never be read back.
 * Loaded from admin/index.html with <script src="./staff-logins-admin.js"></script>.
 * ==========================================================================*/
(function () {
  'use strict';
  var FN = '/.netlify/functions/admin-staff-logins';
  var ACCESS = { server_lead: 'Training Tests (Invite + Submissions) and Checklists. Nothing else.' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isOwner() { return (localStorage.getItem('quarryAdminRole') || 'owner') === 'owner'; }
  function api(body) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': localStorage.getItem('quarryAdminToken') || '' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Bad response (' + r.status + ')' }; }); })
      .catch(function () { return { ok: false, error: 'Network error. Check your connection.' }; });
  }
  function when(iso) { return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }

  function injectStyles() {
    if ($('slStyles')) return;
    var css = '' +
      '.sl-panel{padding-bottom:60px;max-width:760px;}' +
      '.sl-panel h2{font-family:var(--font-serif);font-size:1.85rem;margin:0 0 4px;color:var(--text-primary);}' +
      '.sl-sub{color:var(--text-muted);font-size:13px;margin:0 0 18px;line-height:1.5;}' +
      '.sl-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:18px 20px;margin-bottom:14px;}' +
      '.sl-card h3{margin:0 0 4px;font-size:16px;color:var(--text-primary);}' +
      '.sl-access{font-size:12.5px;color:var(--text-muted);margin-bottom:12px;line-height:1.45;}' +
      '.sl-pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:3px 9px;border-radius:999px;margin-left:8px;vertical-align:middle;}' +
      '.sl-pill.on{background:rgba(22,163,74,.14);color:#15803d;} .sl-pill.off{background:rgba(100,116,139,.16);color:#64748b;}' +
      '.sl-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}' +
      '.sl-row input{flex:1;min-width:220px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-elevated,#fff);color:var(--text-primary);font-size:14px;}' +
      '.sl-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;}' +
      '.sl-btn:disabled{opacity:.45;cursor:not-allowed;} .sl-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;}' +
      '.sl-msg{font-size:13px;margin-top:10px;min-height:1.2em;} .sl-msg.ok{color:#15803d;} .sl-msg.bad{color:#b42318;}';
    var st = document.createElement('style'); st.id = 'slStyles'; st.textContent = css; document.head.appendChild(st);
  }

  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="stafflogins"]')) {
      var item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = 'stafflogins';
      item.innerHTML = '<span class="sb-ic">🔑</span><span class="sb-lbl">Staff Logins</span>';
      var anchor = nav.querySelector('[data-tab="ttsubs"]') || nav.querySelector('[data-tab="writeups"]');
      if (anchor && anchor.parentNode) { anchor.parentNode.appendChild(item); }
      else {
        var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
        var grp = document.createElement('div'); grp.className = 'sb-nav-group'; grp.appendChild(item);
        var sys = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /system/i.test(s.textContent); });
        if (sys) { nav.insertBefore(sec, sys); nav.insertBefore(grp, sys); } else { nav.appendChild(sec); nav.appendChild(grp); }
      }
    }
    var any = document.querySelector('.tab-content');
    if (!$('staffloginsTab') && any) {
      var div = document.createElement('div'); div.id = 'staffloginsTab'; div.className = 'tab-content sl-panel';
      div.innerHTML = '<h2>Staff Logins</h2><p class="sl-sub">Restricted logins for staff who should not have the main admin. ' +
        'You type the password here once. It is stored scrambled and cannot be read back by anyone. ' +
        'Resetting or removing a login signs that person out right away.</p><div id="slBody"><div class="sl-sub">Loading…</div></div>';
      any.parentNode.appendChild(div);
    }
  }

  function render() {
    var box = $('slBody'); if (!box) return;
    api({ action: 'status' }).then(function (r) {
      if (!r.ok) { box.innerHTML = '<div class="sl-msg bad">' + esc(r.error || 'Could not load.') + '</div>'; return; }
      box.innerHTML = (r.accounts || []).map(function (a) {
        return '<div class="sl-card" data-user="' + esc(a.username) + '">' +
          '<h3>' + esc(a.label) + '<span class="sl-pill ' + (a.set ? 'on' : 'off') + '">' + (a.set ? 'Login active' : 'No password yet') + '</span></h3>' +
          '<div class="sl-access">Can see: ' + esc(ACCESS[a.role] || '') + (a.updated ? ' Password last set ' + esc(when(a.updated)) + '.' : '') + '</div>' +
          '<div class="sl-row"><input type="password" autocomplete="new-password" placeholder="' + (a.set ? 'New password (8+ characters)' : 'Choose a password (8+ characters)') + '" class="sl-pw">' +
          '<button class="sl-btn sl-set">' + (a.set ? 'Reset password' : 'Set password') + '</button>' +
          (a.set ? '<button class="sl-btn danger sl-remove">Remove login</button>' : '') + '</div>' +
          '<div class="sl-msg"></div></div>';
      }).join('') || '<div class="sl-sub">No staff logins are set up.</div>';
    });
  }

  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('#staffloginsTab .sl-card'); if (!card) return;
    var user = card.getAttribute('data-user'), msg = card.querySelector('.sl-msg');
    function say(t, ok) { msg.textContent = t; msg.className = 'sl-msg ' + (ok ? 'ok' : 'bad'); }
    if (e.target.classList.contains('sl-set')) {
      var pw = card.querySelector('.sl-pw').value;
      if (pw.trim().length < 8) return say('Use at least 8 characters.', false);
      e.target.disabled = true; say('Saving…', true);
      api({ action: 'set', username: user, password: pw }).then(function (r) {
        e.target.disabled = false;
        if (!r.ok) return say(r.error || 'Could not save.', false);
        card.querySelector('.sl-pw').value = '';
        render();
      });
    }
    if (e.target.classList.contains('sl-remove')) {
      var b = e.target;
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1'; b.textContent = 'Click again to remove';
        setTimeout(function () { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Remove login'; } }, 4000);
        return;
      }
      b.disabled = true; say('Removing…', true);
      api({ action: 'remove', username: user }).then(function (r) {
        if (!r.ok) { b.disabled = false; return say(r.error || 'Could not remove.', false); }
        render();
      });
    }
  });

  function boot() {
    // Always inject: restricted roles never see it (sidebar allowlist hides it) and the
    // server only answers to the owner token.
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._sl) {
      window.switchTab = function (name) {
        var out = orig.apply(this, arguments);
        if (name === 'stafflogins') render();
        return out;
      };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._sl = true;
      if (orig._tt) window.switchTab._tt = true;
    }
    var item = document.querySelector('.sb-nav-item[data-tab="stafflogins"]');
    if (item && !item._slBound) { item._slBound = true; item.addEventListener('click', function () { window.switchTab('stafflogins'); }); }
  }
  // Boot after the Training Tests script (700 ms) so we can join its Team group.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1100); });
  else setTimeout(boot, 1100);
})();
