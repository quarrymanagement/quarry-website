/* ============================================================================
 * The Quarry — Admin "TV Screens"
 * Self-injecting: adds "Team › TV Screens" to the sidebar.
 * Choose which floor charts (1 to 3) each TV shows, then PUBLISH. Published changes go live on the
 * TVs within seconds and each changed TV reloads itself.
 *
 * Backend: Supabase edge function `floor-api` (admin_* actions; owner + server_lead logins only).
 * TV addresses: https://quarry-checklist.netlify.app/floor.html?tv=<name>
 * Loaded from admin/index.html with <script src="./floor-tv-admin.js"></script>.
 * ==========================================================================*/
(function () {
  'use strict';
  var FN = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/floor-api';
  var KEY = 'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';
  var BOARD = 'https://quarry-checklist.netlify.app/floor.html';
  var ST = null;   // { areas, tvs, sync }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(action, body) {
    return fetch(FN + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, 'x-admin-token': localStorage.getItem('quarryAdminToken') || '' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }).catch(function () { return { ok: false, status: r.status, data: {} }; }); })
      .catch(function () { return { ok: false, status: 0, data: {} }; });
  }
  function areaLabel(k) { var a = (ST.areas || []).filter(function (x) { return x.key === k; })[0]; return a ? a.label : k; }
  function eff(t) { return t.draft_areas || t.areas || []; }
  function pending(t) { return !!t.draft_areas; }

  function injectStyles() {
    if ($('ftvStyles')) return;
    var css = '' +
      '.ftv-panel{padding-bottom:60px;max-width:880px;}' +
      '.ftv-panel h2{font-family:var(--font-serif);font-size:1.85rem;margin:0 0 4px;color:var(--text-primary);}' +
      '.ftv-sub{color:var(--text-muted);font-size:13px;margin:0 0 16px;line-height:1.5;}' +
      '.ftv-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px;}' +
      '.ftv-pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:4px 10px;border-radius:999px;background:rgba(100,116,139,.16);color:#64748b;}' +
      '.ftv-pill.ok{background:rgba(22,163,74,.14);color:#15803d;} .ftv-pill.warn{background:rgba(217,119,6,.16);color:#b45309;}' +
      '.ftv-card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:12px;padding:16px 18px;margin-bottom:12px;}' +
      '.ftv-card.draft{border-color:#d97706;box-shadow:0 0 0 2px rgba(217,119,6,.15);}' +
      '.ftv-top{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px;}' +
      '.ftv-name{font-weight:700;font-size:16px;color:var(--text-primary);}' +
      '.ftv-chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;}' +
      '.ftv-chip{border:1px solid var(--border-subtle);background:var(--bg-elevated,#fff);color:var(--text-primary);border-radius:8px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;}' +
      '.ftv-chip.on{background:#2C1A0E;color:#fff;border-color:#2C1A0E;}' +
      '.ftv-live{font-size:12.5px;color:var(--text-muted);margin-top:6px;line-height:1.5;} .ftv-link{font-size:12px;color:var(--text-muted);word-break:break-all;margin-top:8px;}' +
      '.ftv-btn{background:#2C1A0E;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;}' +
      '.ftv-btn:disabled{opacity:.45;cursor:not-allowed;} .ftv-btn.gold{background:#B8933A;} .ftv-btn.sec{background:var(--bg-elevated,#fff);color:var(--text-primary);border:1px solid var(--border-subtle);}' +
      '.ftv-btn.danger{background:#fff;color:#b42318;border:1px solid #f1c4bf;} .ftv-btn.sm{padding:6px 11px;font-size:12px;}' +
      '.ftv-add{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;} .ftv-add input{flex:1;min-width:200px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-elevated,#fff);color:var(--text-primary);font-size:14px;}' +
      '.ftv-msg{font-size:13px;min-height:1.3em;margin:4px 0 12px;} .ftv-msg.ok{color:#15803d;} .ftv-msg.bad{color:#b42318;}';
    var st = document.createElement('style'); st.id = 'ftvStyles'; st.textContent = css; document.head.appendChild(st);
  }

  function injectDom() {
    var nav = document.querySelector('.sb-nav');
    if (nav && !nav.querySelector('[data-tab="floortv"]')) {
      var item = document.createElement('div'); item.className = 'sb-nav-item'; item.dataset.tab = 'floortv';
      item.innerHTML = '<span class="sb-ic">📺</span><span class="sb-lbl">TV Screens</span><span id="ftvBadge" class="sb-badge" style="display:none;">0</span>';
      var anchor = nav.querySelector('[data-tab="ttsubs"]') || nav.querySelector('[data-tab="writeups"]');
      if (anchor && anchor.parentNode) anchor.parentNode.appendChild(item);
      else {
        var sec = document.createElement('div'); sec.className = 'sb-nav-section'; sec.textContent = 'Team';
        var grp = document.createElement('div'); grp.className = 'sb-nav-group'; grp.appendChild(item);
        var sys = Array.prototype.find.call(nav.querySelectorAll('.sb-nav-section'), function (s) { return /system/i.test(s.textContent); });
        if (sys) { nav.insertBefore(sec, sys); nav.insertBefore(grp, sys); } else { nav.appendChild(sec); nav.appendChild(grp); }
      }
    }
    var any = document.querySelector('.tab-content');
    if (!$('floortvTab') && any) {
      var div = document.createElement('div'); div.id = 'floortvTab'; div.className = 'tab-content ftv-panel';
      div.innerHTML = '<h2>TV Screens</h2><p class="ftv-sub">Choose which floor charts each TV shows (1 to 3). Changes stay as a draft until you press ' +
        '<b>Publish</b>, then the TVs update and refresh themselves within seconds.</p><div id="ftvBody"><div class="ftv-sub">Loading…</div></div>';
      any.parentNode.appendChild(div);
    }
  }

  function say(msg, ok) { var m = $('ftvMsg'); if (m) { m.textContent = msg; m.className = 'ftv-msg ' + (ok ? 'ok' : 'bad'); } }
  function fail(r, fallback) {
    if (r.status === 401) say('Your session expired. Sign in to the admin again.', false);
    else say((r.data && r.data.error) || fallback || 'Something went wrong. Try again.', false);
  }

  function render(keepMsg) {
    var box = $('ftvBody'); if (!box || !ST) return;
    var nPending = (ST.tvs || []).filter(pending).length;
    var sync = ST.sync, syncOk = sync && sync.ok && sync.last_run && (Date.now() - new Date(sync.last_run).getTime() < 120000);
    var msgPrev = keepMsg && $('ftvMsg') ? { t: $('ftvMsg').textContent, c: $('ftvMsg').className } : null;
    var h = '<div class="ftv-bar">' +
      '<button class="ftv-btn gold" data-ftv="publish"' + (nPending ? '' : ' disabled') + '>Publish to TVs' + (nPending ? ' (' + nPending + ')' : '') + '</button>' +
      '<button class="ftv-btn sec" data-ftv="discard"' + (nPending ? '' : ' disabled') + '>Discard changes</button>' +
      '<button class="ftv-btn sec" data-ftv="refreshall">Refresh all TVs now</button>' +
      '<span class="ftv-pill ' + (syncOk ? 'ok' : 'warn') + '">' + (syncOk ? 'Live from Square' : 'Square feed: manual') + '</span></div><div id="ftvMsg" class="ftv-msg"></div>';
    (ST.tvs || []).forEach(function (t) {
      var chosen = eff(t);
      h += '<div class="ftv-card' + (pending(t) ? ' draft' : '') + '" data-tv="' + esc(t.tv) + '"><div class="ftv-top"><span class="ftv-name">' + esc(t.label) +
        (pending(t) ? ' <span class="ftv-pill warn">Unpublished changes</span>' : '') + '</span><span>' +
        '<button class="ftv-btn sm" data-ftv="pub1"' + (pending(t) ? '' : ' disabled') + '>Publish</button> ' +
        '<button class="ftv-btn sm sec" data-ftv="discard1"' + (pending(t) ? '' : ' disabled') + '>Discard</button> ' +
        '<button class="ftv-btn sm sec" data-ftv="refresh1">Refresh TV</button> ' +
        '<button class="ftv-btn sm danger" data-ftv="del">Remove</button></span></div>' +
        '<div class="ftv-chips">' + (ST.areas || []).map(function (a) {
          return '<button class="ftv-chip' + (chosen.indexOf(a.key) >= 0 ? ' on' : '') + '" data-ftv="area" data-k="' + esc(a.key) + '">' + esc(a.label) + '</button>';
        }).join('') + '</div>' +
        '<div class="ftv-live">On the TV now: ' + ((t.areas || []).length ? (t.areas || []).map(areaLabel).map(esc).join(' &middot; ') : '<i>nothing yet (not published)</i>') + '</div>' +
        '<div class="ftv-link">TV link: ' + esc(BOARD) + '?tv=' + esc(t.tv) + '</div></div>';
    });
    h += '<div class="ftv-card"><div class="ftv-name" style="margin-bottom:8px">Add a TV</div><div class="ftv-add"><input type="text" id="ftvNew" maxlength="30" placeholder="Name, e.g. Patio Runners">' +
      '<button class="ftv-btn" data-ftv="add">Add TV</button></div></div>';
    box.innerHTML = h;
    var badge = $('ftvBadge'); if (badge) { badge.textContent = nPending; badge.style.display = nPending ? '' : 'none'; }
    if (msgPrev && $('ftvMsg')) { $('ftvMsg').textContent = msgPrev.t; $('ftvMsg').className = msgPrev.c; }
  }

  function load(keepMsg) {
    return api('admin_state').then(function (r) {
      if (!r.ok) { var b = $('ftvBody'); if (b) b.innerHTML = '<div class="ftv-msg bad">' + esc(r.status === 401 ? 'Your session expired. Sign in to the admin again.' : 'Could not load TV settings.') + '</div>'; return; }
      ST = r.data; render(keepMsg);
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('#floortvTab [data-ftv]'); if (!el || el.disabled) return;
    var act = el.getAttribute('data-ftv'), card = el.closest('.ftv-card'), tv = card ? card.getAttribute('data-tv') : null;
    var t = tv ? (ST.tvs || []).filter(function (x) { return x.tv === tv; })[0] : null;
    function done(msg) { return function (r) { if (!r.ok) return fail(r); load(true).then(function () { say(msg, true); }); }; }

    if (act === 'area' && t) {
      var k = el.getAttribute('data-k'), cur = eff(t).slice(), i = cur.indexOf(k);
      if (i >= 0) { if (cur.length === 1) return say('Keep at least one chart on each TV.', false); cur.splice(i, 1); }
      else { cur.push(k); if (cur.length > 3) cur.shift(); }
      return api('admin_draft', { tv: tv, areas: cur }).then(done('Saved as a draft. Press Publish to put it on the TV.'));
    }
    if (act === 'publish') { el.disabled = true; return api('admin_publish', {}).then(done('Published. The TVs are updating.')); }
    if (act === 'pub1') { el.disabled = true; return api('admin_publish', { tv: tv }).then(done('Published. That TV is updating.')); }
    if (act === 'discard') return api('admin_discard', {}).then(done('Draft changes discarded.'));
    if (act === 'discard1') return api('admin_discard', { tv: tv }).then(done('Draft discarded.'));
    if (act === 'refreshall') return api('admin_refresh', {}).then(done('Refreshing every TV.'));
    if (act === 'refresh1') return api('admin_refresh', { tv: tv }).then(done('Refreshing that TV.'));
    if (act === 'del') {
      if (el.dataset.armed !== '1') { el.dataset.armed = '1'; el.textContent = 'Click again'; setTimeout(function () { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Remove'; } }, 3500); return; }
      return api('admin_delete_tv', { tv: tv }).then(done('TV removed.'));
    }
    if (act === 'add') {
      var nm = ($('ftvNew').value || '').trim(); if (!nm) return say('Give the TV a name first.', false);
      var key = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!key) return say('Use letters or numbers in the name.', false);
      return api('admin_draft', { tv: key, label: nm, areas: ['inside'] }).then(done('Added as a draft. Pick its charts, then Publish.'));
    }
  });

  function boot() {
    injectStyles(); injectDom();
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._ftv) {
      window.switchTab = function (name) {
        var out = orig.apply(this, arguments);
        if (name === 'floortv') load(false);
        return out;
      };
      Object.keys(orig).forEach(function (k) { window.switchTab[k] = orig[k]; });
      window.switchTab._ftv = true;
      if (orig._tt) window.switchTab._tt = true;
      if (orig._sl) window.switchTab._sl = true;
    }
    var item = document.querySelector('.sb-nav-item[data-tab="floortv"]');
    if (item && !item._ftvBound) { item._ftvBound = true; item.addEventListener('click', function () { window.switchTab('floortv'); }); }
    if (localStorage.getItem('quarryAdminToken')) api('admin_state').then(function (r) { if (r.ok) { ST = r.data; var n = (ST.tvs || []).filter(pending).length; var b = $('ftvBadge'); if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; } } });
  }
  // Boot after the Training Tests (700 ms) and Staff Logins (1100 ms) scripts so the Team group exists.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1500); });
  else setTimeout(boot, 1500);
})();
