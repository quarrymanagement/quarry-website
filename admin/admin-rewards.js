/*
 * admin-rewards.js
 *
 * Powers the "Manage Rewards" panel on /admin. Lets staff add new
 * rewards, edit point costs and titles, toggle active status, and
 * delete rewards — all without an iOS app update. The iOS app reads
 * from the same Supabase `rewards` table on launch + pull-to-refresh.
 *
 * Talks to the `admin-manage-rewards` Edge Function with the same
 * x-admin-secret used by admin-push.js (key: quarryAdminPushSecret
 * in localStorage).
 *
 * Required DOM in admin/index.html (added by this file's HTML block):
 *   #arList         — container where reward cards render
 *   #arRefreshBtn   — refresh button
 *   #arAddBtn       — open the "Add new reward" form
 *   #arEditor       — the form (hidden by default)
 *   #arEditorTitle  — h3 inside the editor ("Add new reward" / "Edit reward")
 *   #arFieldTitle, #arFieldDesc, #arFieldPoints, #arFieldValue,
 *   #arFieldTier, #arFieldOrder, #arFieldActive
 *   #arSaveBtn, #arCancelBtn
 *   #arStatus       — status / error pill
 *
 * No build step. Add one <script> tag in admin/index.html.
 */
(function () {
  const SUPABASE_URL  = 'https://nkulhtalltbieicvmmad.supabase.co';
  const SUPABASE_ANON =
    'sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl';
  const FN_URL = SUPABASE_URL + '/functions/v1/admin-manage-rewards';

  // ===== Admin auth (shared with admin-push.js) =====
  function getAdminToken() {
    let t = localStorage.getItem('quarryAdminPushSecret');
    if (!t) {
      t = prompt(
        'One-time setup: enter the admin secret\n' +
        '(stored locally on this browser only)'
      );
      if (t) localStorage.setItem('quarryAdminPushSecret', t.trim());
    }
    return t;
  }

  // ===== API =====
  async function api(opPayload) {
    const token = getAdminToken();
    if (!token) throw new Error('Admin secret required');

    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'apikey':         SUPABASE_ANON,
        'Authorization':  'Bearer ' + SUPABASE_ANON,
        'x-admin-secret': token,
      },
      body: JSON.stringify(opPayload),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem('quarryAdminPushSecret');
        throw new Error('Admin secret rejected. Refresh and try again.');
      }
      const txt = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 200));
    }
    return await res.json();
  }

  // ===== Status helper =====
  function setStatus(html, kind /* 'success' | 'error' | 'info' | '' */) {
    const el = document.getElementById('arStatus');
    if (!el) return;
    if (!html) { el.textContent = ''; el.style.display = 'none'; return; }
    const color = kind === 'success' ? '#1f7a3f'
                : kind === 'error'   ? '#b3261e'
                : '#5a5a5a';
    el.style.color = color;
    el.style.padding = '10px 14px';
    el.style.border = '1px solid ' + color;
    el.style.borderRadius = '8px';
    el.style.marginTop = '12px';
    el.style.background = kind === 'success' ? '#e9f6ee'
                         : kind === 'error'  ? '#fbe9e7'
                         : '#f3f3f3';
    el.style.display = 'block';
    el.innerHTML = html;
  }

  // ===== List + render =====
  async function loadList() {
    const list = document.getElementById('arList');
    if (!list) return;
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#888">Loading rewards…</div>';
    try {
      const data = await api({ op: 'list' });
      renderList(data.rewards || []);
    } catch (e) {
      list.innerHTML = '';
      setStatus('⚠️ ' + (e?.message || e), 'error');
    }
  }

  function renderList(rewards) {
    const list = document.getElementById('arList');
    if (!list) return;
    if (!rewards.length) {
      list.innerHTML =
        '<div style="padding:20px;text-align:center;color:#888;border:1px dashed #ccc;border-radius:8px">' +
        'No rewards yet. Click <strong>Add new reward</strong> to create one.' +
        '</div>';
      return;
    }
    list.innerHTML = '';
    rewards.forEach((r) => list.appendChild(buildCard(r)));
  }

  function buildCard(r) {
    const card = document.createElement('div');
    card.style.cssText =
      'border:1px solid #ddd;border-radius:8px;padding:14px;margin-bottom:10px;' +
      'background:' + (r.active ? '#fff' : '#fafafa') + ';' +
      'opacity:' + (r.active ? '1' : '0.7') + ';';

    const safe = (s) => (s == null ? '' : String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:11px;color:#888;letter-spacing:1px;margin-bottom:2px">' +
            (r.points_cost.toLocaleString()) + ' PTS' +
            (r.approx_value ? ' &nbsp;·&nbsp; ' + safe(r.approx_value) : '') +
            ' &nbsp;·&nbsp; tier: ' + safe(r.min_tier || 'standard') +
            ' &nbsp;·&nbsp; order: ' + r.display_order +
          '</div>' +
          '<div style="font-size:16px;font-weight:600;color:#222">' + safe(r.title) + '</div>' +
          (r.description
            ? '<div style="font-size:13px;color:#555;margin-top:4px">' + safe(r.description) + '</div>'
            : '') +
          (!r.active
            ? '<div style="font-size:11px;color:#b3261e;margin-top:6px;font-weight:600">⏸ HIDDEN FROM APP</div>'
            : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">' +
          '<button data-edit="' + r.id + '" style="font-size:12px;padding:4px 10px;cursor:pointer">Edit</button>' +
          '<button data-toggle="' + r.id + '" data-active="' + (r.active ? '1' : '0') + '" ' +
            'style="font-size:12px;padding:4px 10px;cursor:pointer">' +
            (r.active ? 'Hide' : 'Show') +
          '</button>' +
          '<button data-delete="' + r.id + '" ' +
            'style="font-size:12px;padding:4px 10px;cursor:pointer;color:#b3261e">Delete</button>' +
        '</div>' +
      '</div>';

    card.querySelector('[data-edit]').addEventListener('click', () => openEditor(r));
    card.querySelector('[data-toggle]').addEventListener('click', () => toggleActive(r));
    card.querySelector('[data-delete]').addEventListener('click', () => deleteReward(r));
    return card;
  }

  // ===== Editor =====
  let editingId = null;

  function openEditor(reward /* or null for new */) {
    editingId = reward ? reward.id : null;
    document.getElementById('arEditorTitle').textContent =
      reward ? 'Edit reward' : 'Add new reward';
    document.getElementById('arFieldTitle').value  = reward?.title || '';
    document.getElementById('arFieldDesc').value   = reward?.description || '';
    document.getElementById('arFieldPoints').value = reward?.points_cost ?? '';
    document.getElementById('arFieldValue').value  = reward?.approx_value || '';
    document.getElementById('arFieldTier').value   = reward?.min_tier || 'standard';
    document.getElementById('arFieldOrder').value  = reward?.display_order ?? nextOrder();
    document.getElementById('arFieldActive').checked = reward ? !!reward.active : true;
    document.getElementById('arEditor').style.display = '';
    document.getElementById('arEditor').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setStatus('', '');
  }

  function closeEditor() {
    editingId = null;
    document.getElementById('arEditor').style.display = 'none';
  }

  function nextOrder() {
    // Default new reward to end of the ladder.
    const orders = Array.from(document.querySelectorAll('#arList [data-edit]'))
      .map(b => parseInt(b.closest('div').textContent.match(/order:\s*(\d+)/)?.[1] || '0', 10));
    return (orders.length ? Math.max(...orders) : 0) + 10;
  }

  async function saveEditor() {
    const title  = document.getElementById('arFieldTitle').value.trim();
    const desc   = document.getElementById('arFieldDesc').value.trim();
    const points = parseInt(document.getElementById('arFieldPoints').value, 10);
    const value  = document.getElementById('arFieldValue').value.trim();
    const tier   = document.getElementById('arFieldTier').value;
    const order  = parseInt(document.getElementById('arFieldOrder').value, 10);
    const active = document.getElementById('arFieldActive').checked;

    if (!title) { setStatus('⚠️ Title is required.', 'error'); return; }
    if (!Number.isFinite(points) || points < 0) {
      setStatus('⚠️ Points must be a non-negative number.', 'error'); return;
    }

    const payload = {
      op: editingId ? 'update' : 'create',
      title,
      description: desc || null,
      points_cost: points,
      approx_value: value || null,
      min_tier: tier,
      display_order: Number.isFinite(order) ? order : 0,
      active,
    };
    if (editingId) payload.id = editingId;

    const btn = document.getElementById('arSaveBtn');
    btn.disabled = true;
    btn.textContent = editingId ? 'Saving…' : 'Adding…';
    try {
      await api(payload);
      setStatus(
        '✅ Reward ' + (editingId ? 'updated' : 'added') + '. Changes are live in the app immediately.',
        'success'
      );
      closeEditor();
      await loadList();
    } catch (e) {
      setStatus('⚠️ Save failed: ' + (e?.message || e), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = editingId ? 'Save changes' : 'Add reward';
    }
  }

  async function toggleActive(r) {
    try {
      await api({ op: 'update', id: r.id, active: !r.active });
      setStatus(
        '✅ "' + r.title + '" is now ' + (!r.active ? 'visible' : 'hidden') + ' in the app.',
        'success'
      );
      await loadList();
    } catch (e) {
      setStatus('⚠️ ' + (e?.message || e), 'error');
    }
  }

  async function deleteReward(r) {
    if (!confirm(
      'Delete "' + r.title + '"?\n\n' +
      'This is permanent. Members who already redeemed this reward keep their history, ' +
      'but no one will be able to redeem it again.\n\n' +
      '(Tip: if you only want to stop showing it, use "Hide" instead.)'
    )) return;
    try {
      await api({ op: 'delete', id: r.id });
      setStatus('✅ Deleted "' + r.title + '".', 'success');
      await loadList();
    } catch (e) {
      setStatus('⚠️ ' + (e?.message || e), 'error');
    }
  }

  // ===== Self-inject the section HTML if not already present =====
  // Lets us drop a single <script> tag into admin/index.html and have
  // the full Manage Rewards panel appear automatically. If the HTML
  // section is already present (e.g. someone hand-placed it elsewhere),
  // we use the existing one.
  function ensureSection() {
    if (document.getElementById('arSection')) return;

    // Find a sensible mount point — prefer the existing Push Notifications
    // section so Manage Rewards sits next to its sibling admin panel.
    // Fall back to <main>, then <body>.
    function findMount() {
      const allH2 = Array.from(document.querySelectorAll('h2, h3'));
      const pushHeading = allH2.find(h => /push notifications/i.test(h.textContent || ''));
      if (pushHeading) {
        const card = pushHeading.closest('section, .card, .panel, div');
        if (card) return { node: card, place: 'after' };
      }
      return { node: document.querySelector('main') || document.body, place: 'append' };
    }

    const mount = findMount();
    const wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<section id="arSection" style="background:#fff;border:1px solid #ddd;border-radius:10px;padding:20px;margin:20px auto;max-width:900px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px">' +
          '<h2 style="margin:0;font-size:20px;color:#222">⭐ iOS App Rewards</h2>' +
          '<div style="display:flex;gap:8px">' +
            '<button id="arRefreshBtn" type="button" style="padding:6px 14px;font-size:13px;cursor:pointer;border:1px solid #c8a14a;background:#fff;border-radius:6px">↻ Refresh</button>' +
            '<button id="arAddBtn" type="button" style="padding:6px 14px;font-size:13px;cursor:pointer;border:none;background:#c8a14a;color:#fff;border-radius:6px;font-weight:600">+ Add new reward</button>' +
          '</div>' +
        '</div>' +
        '<p style="margin:0 0 16px 0;color:#666;font-size:13px;line-height:1.5">' +
          'These are the rewards members can redeem in the iOS app\'s Rewards tab. ' +
          '<strong>Changes are live in the app within seconds</strong> — no resubmit, no update needed. ' +
          'To temporarily hide a reward without losing it, use <em>Hide</em> instead of <em>Delete</em>.' +
        '</p>' +
        '<div id="arStatus" style="display:none"></div>' +
        '<div id="arEditor" style="display:none;border:1px solid #c8a14a;border-radius:8px;padding:16px;margin:12px 0;background:#fdf9ef">' +
          '<h3 id="arEditorTitle" style="margin:0 0 12px 0;font-size:16px;color:#222">Add new reward</h3>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
            '<label style="grid-column:1/-1;font-size:12px;color:#555">Title <span style="color:#b3261e">*</span>' +
              '<input id="arFieldTitle" type="text" maxlength="120" placeholder="e.g. Free appetizer" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px">' +
            '</label>' +
            '<label style="grid-column:1/-1;font-size:12px;color:#555">Description (shown under the title)' +
              '<input id="arFieldDesc" type="text" maxlength="500" placeholder="e.g. Any starter from the kitchen menu." style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px">' +
            '</label>' +
            '<label style="font-size:12px;color:#555">Points cost <span style="color:#b3261e">*</span>' +
              '<input id="arFieldPoints" type="number" min="0" max="1000000" step="50" placeholder="1500" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px">' +
            '</label>' +
            '<label style="font-size:12px;color:#555">Approx. value (optional)' +
              '<input id="arFieldValue" type="text" maxlength="50" placeholder="e.g. ≈ $15" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px">' +
            '</label>' +
            '<label style="font-size:12px;color:#555">Minimum tier' +
              '<select id="arFieldTier" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px;background:#fff">' +
                '<option value="standard">Standard (everyone)</option>' +
                '<option value="silver">Silver+</option>' +
                '<option value="gold">Gold+</option>' +
                '<option value="elite">Elite only</option>' +
              '</select>' +
            '</label>' +
            '<label style="font-size:12px;color:#555">Display order' +
              '<input id="arFieldOrder" type="number" min="0" max="10000" step="10" placeholder="e.g. 10, 20, 30…" style="width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px;font-size:14px">' +
              '<span style="font-size:11px;color:#888">Lower = shown first. Use 10, 20, 30… for easy reordering.</span>' +
            '</label>' +
            '<label style="grid-column:1/-1;font-size:13px;color:#333;display:flex;align-items:center;gap:8px;margin-top:4px">' +
              '<input id="arFieldActive" type="checkbox" checked style="width:18px;height:18px">' +
              'Active — show this reward in the app' +
            '</label>' +
          '</div>' +
          '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">' +
            '<button id="arCancelBtn" type="button" style="padding:8px 16px;font-size:13px;cursor:pointer;border:1px solid #ccc;background:#fff;border-radius:6px">Cancel</button>' +
            '<button id="arSaveBtn" type="button" style="padding:8px 16px;font-size:13px;cursor:pointer;border:none;background:#c8a14a;color:#fff;border-radius:6px;font-weight:600">Save</button>' +
          '</div>' +
        '</div>' +
        '<div id="arList" style="margin-top:8px"></div>' +
      '</section>';

    const section = wrapper.firstElementChild;
    if (mount.place === 'after') {
      mount.node.parentNode.insertBefore(section, mount.node.nextSibling);
    } else {
      mount.node.appendChild(section);
    }
  }

  // ===== Wire up =====
  function init() {
    ensureSection();
    const list = document.getElementById('arList');
    if (!list) {
      // Section not rendered yet — try again shortly.
      const obs = new MutationObserver(() => {
        if (document.getElementById('arList')) { obs.disconnect(); init(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    if (list.dataset.quarryRewardsBound === '1') return;
    list.dataset.quarryRewardsBound = '1';

    document.getElementById('arRefreshBtn').addEventListener('click', loadList);
    document.getElementById('arAddBtn').addEventListener('click', () => openEditor(null));
    document.getElementById('arSaveBtn').addEventListener('click', saveEditor);
    document.getElementById('arCancelBtn').addEventListener('click', closeEditor);

    loadList();
    console.log('[admin-rewards] Manage Rewards panel ready.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
