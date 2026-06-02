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

  // ===== Wire up =====
  function init() {
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
