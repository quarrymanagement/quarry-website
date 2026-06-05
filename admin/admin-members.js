/*
 * admin-members.js
 *
 * Powers the "Members" panel on /admin. Lets staff search the member list,
 * open a member detail page (contact, points balance, full audit log of
 * receipts / redemptions / point events / admin actions), edit profile
 * fields, manually credit or debit points (with reason), and disable /
 * re-enable accounts.
 *
 * Talks to the `admin-manage-members` Edge Function with the same
 * x-admin-secret used by admin-push.js + admin-rewards.js (key:
 * `quarryAdminPushSecret` in localStorage; falls back to `quarry2026`).
 *
 * Required DOM (injected by admin-members-section.html):
 *   #amSearchInput, #amSearchBtn, #amRefreshBtn
 *   #amList          — table body
 *   #amStatus        — status / error pill
 *   #amDetail        — slide-in detail panel (hidden by default)
 *   #amDetailBody    — body of detail panel (populated on click)
 *   #amDetailClose   — close button
 *
 * No build step. Add one <script src="admin-members.js"></script> in
 * admin/index.html after the existing admin-rewards.js include.
 */
(function () {
  const SUPABASE_URL  = 'https://nkulhtalltbieicvmmad.supabase.co';
  const FN_URL = SUPABASE_URL + '/functions/v1/admin-manage-members';

  function getSecret() {
    return localStorage.getItem('quarryAdminPushSecret') || 'quarry2026';
  }

  // --- helpers --------------------------------------------------------------

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'style') e.setAttribute('style', attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  function fmtDate(s) {
    if (!s) return '—';
    try {
      const d = new Date(s);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return s; }
  }
  function fmtDateTime(s) {
    if (!s) return '—';
    try {
      const d = new Date(s);
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return s; }
  }
  function fmtPts(n) {
    if (n == null) return '—';
    const sign = n > 0 ? '+' : '';
    return sign + n.toLocaleString();
  }

  function setStatus(text, isError) {
    const s = document.getElementById('amStatus');
    if (!s) return;
    s.textContent = text || '';
    s.style.color = isError ? '#b91c1c' : '#6b7280';
  }

  async function call(method, action, body, query) {
    const url = new URL(FN_URL);
    url.searchParams.set('action', action);
    if (query) {
      for (const k in query) {
        if (query[k] !== undefined && query[k] !== null && query[k] !== '') {
          url.searchParams.set(k, String(query[k]));
        }
      }
    }
    const opts = {
      method,
      headers: {
        'x-admin-secret': getSecret(),
      },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify({ action, ...body });
    }
    const r = await fetch(url.toString(), opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // --- list view ------------------------------------------------------------

  let lastSearch = '';

  async function refreshList() {
    setStatus('Loading…');
    try {
      const data = await call('GET', 'list', null, { q: lastSearch, limit: 100 });
      renderList(data.rows || []);
      setStatus(`${data.count ?? (data.rows || []).length} member${(data.count === 1) ? '' : 's'}`);
    } catch (e) {
      setStatus('Error: ' + e.message, true);
    }
  }

  function renderList(rows) {
    const tbody = document.getElementById('amList');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.appendChild(el('tr', null, [
        el('td', { colspan: '6', style: 'padding:18px; text-align:center; color:#6b7280;' }, 'No members found.')
      ]));
      return;
    }
    for (const m of rows) {
      const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || '(no name)';
      const status = m.disabled
        ? el('span', { style: 'background:#fee2e2; color:#991b1b; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600;' }, 'DISABLED')
        : el('span', { style: 'color:#16a34a; font-size:12px;' }, 'Active');
      const row = el('tr', {
        style: 'cursor:pointer; border-bottom:1px solid #f3f4f6;',
        onclick: () => openDetail(m.id),
      }, [
        el('td', { style: 'padding:10px 12px; font-weight:600;' }, name),
        el('td', { style: 'padding:10px 12px; color:#374151;' }, m.email || ''),
        el('td', { style: 'padding:10px 12px; color:#374151;' }, m.phone || '—'),
        el('td', { style: 'padding:10px 12px; text-align:right; font-variant-numeric:tabular-nums;' }, (m.balance || 0).toLocaleString() + ' pts'),
        el('td', { style: 'padding:10px 12px; color:#6b7280; font-size:13px;' }, fmtDate(m.created_at)),
        el('td', { style: 'padding:10px 12px;' }, status),
      ]);
      row.addEventListener('mouseenter', () => { row.style.background = '#fafaf7'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      tbody.appendChild(row);
    }
  }

  // --- detail view ----------------------------------------------------------

  function actionLabel(k) {
    return ({
      receipt: 'Receipt scan',
      welcome_bonus: 'Welcome bonus',
      birthday_bonus: 'Birthday',
      email_opt_in: 'Email opt-in',
      reservation_honored: 'Reservation honored',
      wine_tasting_rsvp: 'Wine tasting RSVP',
      referral_signup: 'Friend signed up',
      review_posted: 'Public review',
      private_party_booked: 'Private party booked',
      redemption: 'Redemption',
      manual_credit: 'Manual credit',
      manual_debit: 'Manual debit',
      referrer_credit: 'Referral credit',
      visit_rating_bonus: 'Visit rating',
    })[k] || k;
  }

  async function openDetail(id) {
    const panel = document.getElementById('amDetail');
    const body = document.getElementById('amDetailBody');
    if (!panel || !body) return;
    panel.style.display = 'block';
    body.innerHTML = '';
    body.appendChild(el('div', { style: 'padding:24px; color:#6b7280;' }, 'Loading member…'));

    try {
      const d = await call('GET', 'get', null, { id });
      renderDetail(body, d);
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { style: 'padding:24px; color:#b91c1c;' }, 'Error: ' + e.message));
    }
  }

  function closeDetail() {
    const panel = document.getElementById('amDetail');
    if (panel) panel.style.display = 'none';
  }

  function renderDetail(body, d) {
    body.innerHTML = '';
    const m = d.member || {};
    const fullName = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || '(no name)';

    // Header
    body.appendChild(el('div', { style: 'padding:20px 24px 8px;' }, [
      el('div', { style: 'display:flex; justify-content:space-between; align-items:flex-start; gap:12px;' }, [
        el('div', null, [
          el('div', { style: 'font-family:Georgia,serif; font-size:22px; font-weight:600;' }, fullName),
          el('div', { style: 'color:#6b7280; font-size:13px; margin-top:2px;' }, m.email || ''),
        ]),
        el('div', null, [
          el('div', { style: 'font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:1px; text-align:right;' }, 'Balance'),
          el('div', { style: 'font-family:Georgia,serif; font-size:24px; font-weight:600; color:#b8933a; text-align:right;' }, (m.balance || 0).toLocaleString() + ' pts'),
        ]),
      ]),
      m.disabled_at ? el('div', { style: 'background:#fee2e2; color:#991b1b; padding:8px 12px; border-radius:6px; margin-top:12px; font-size:13px;' },
        'Account disabled ' + fmtDateTime(m.disabled_at) + (m.disabled_reason ? (' — ' + m.disabled_reason) : '')) : null,
    ]));

    // Contact + meta grid
    function row(label, value) {
      return el('div', { style: 'display:flex; padding:6px 0; font-size:13px;' }, [
        el('div', { style: 'width:140px; color:#6b7280;' }, label),
        el('div', { style: 'flex:1;' }, value || '—'),
      ]);
    }
    body.appendChild(el('div', { style: 'padding:8px 24px 16px;' }, [
      row('Phone', m.phone),
      row('Birthday', m.birthday || '—'),
      row('Referral code', m.referral_code),
      row('Referred by', m.referred_by_code),
      row('Email opt-in', m.email_opted_in ? 'Yes' : 'No'),
      row('Has password', m.has_set_password ? 'Yes' : 'Not yet (OTP only)'),
      row('Qualifying receipts', String(m.qualifying_receipt_count ?? 0)),
      row('Signed up', fmtDateTime(m.created_at)),
      row('Last activity', fmtDateTime(m.last_event_at)),
    ]));

    // Quick actions
    const qa = el('div', { style: 'padding:8px 24px 16px; display:flex; gap:8px; flex-wrap:wrap;' });
    qa.appendChild(actionButton('Credit pts', () => promptCredit(m, 'credit')));
    qa.appendChild(actionButton('Debit pts',  () => promptCredit(m, 'debit')));
    qa.appendChild(actionButton('Edit profile', () => promptEdit(m)));
    if (m.disabled_at) {
      qa.appendChild(actionButton('Re-enable account', () => doEnable(m), '#16a34a'));
    } else {
      qa.appendChild(actionButton('Disable account', () => promptDisable(m), '#b91c1c'));
    }
    body.appendChild(qa);

    // Tabs: Activity / Receipts / Redemptions / Admin log
    const tabBar = el('div', { style: 'display:flex; gap:0; border-bottom:1px solid #e5e7eb; margin:0 24px;' });
    const tabContent = el('div', { style: 'padding:12px 24px 24px;' });
    const tabs = [
      ['Activity', () => renderEvents(tabContent, d.events)],
      ['Receipts (' + (d.receipts || []).length + ')', () => renderReceipts(tabContent, d.receipts)],
      ['Redemptions (' + (d.redemptions || []).length + ')', () => renderRedemptions(tabContent, d.redemptions)],
      ['Admin log (' + (d.actions || []).length + ')', () => renderActions(tabContent, d.actions)],
    ];
    tabs.forEach(([label, render], i) => {
      const btn = el('button', {
        style: 'background:none; border:none; padding:10px 14px; cursor:pointer; font-size:13px; font-weight:600; color:#6b7280; border-bottom:2px solid transparent;',
      }, label);
      btn.addEventListener('click', () => {
        tabBar.querySelectorAll('button').forEach(b => {
          b.style.color = '#6b7280';
          b.style.borderBottomColor = 'transparent';
        });
        btn.style.color = '#b8933a';
        btn.style.borderBottomColor = '#b8933a';
        render();
      });
      tabBar.appendChild(btn);
      if (i === 0) setTimeout(() => btn.click(), 0);
    });
    body.appendChild(tabBar);
    body.appendChild(tabContent);
  }

  function actionButton(label, onClick, color) {
    return el('button', {
      style: 'background:#fff; border:1px solid ' + (color || '#b8933a') + '; color:' + (color || '#b8933a') + '; padding:8px 14px; border-radius:6px; cursor:pointer; font-size:13px; font-weight:600;',
      onclick: onClick,
    }, label);
  }

  function renderEvents(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.appendChild(el('div', { style: 'color:#6b7280; padding:12px 0;' }, 'No activity yet.'));
      return;
    }
    const t = el('table', { style: 'width:100%; border-collapse:collapse; font-size:13px;' });
    rows.forEach(e => {
      t.appendChild(el('tr', { style: 'border-bottom:1px solid #f3f4f6;' }, [
        el('td', { style: 'padding:8px 4px; color:#6b7280;' }, fmtDateTime(e.created_at)),
        el('td', { style: 'padding:8px 4px;' }, actionLabel(e.kind)),
        el('td', { style: 'padding:8px 4px; color:#6b7280; font-size:12px;' }, e.note || ''),
        el('td', { style: 'padding:8px 4px; text-align:right; font-variant-numeric:tabular-nums; font-weight:600; color:' + (e.points >= 0 ? '#16a34a' : '#b91c1c') + ';' }, fmtPts(e.points)),
      ]));
    });
    container.appendChild(t);
  }

  function renderReceipts(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.appendChild(el('div', { style: 'color:#6b7280; padding:12px 0;' }, 'No receipts submitted.'));
      return;
    }
    const t = el('table', { style: 'width:100%; border-collapse:collapse; font-size:13px;' });
    rows.forEach(r => {
      t.appendChild(el('tr', { style: 'border-bottom:1px solid #f3f4f6;' }, [
        el('td', { style: 'padding:8px 4px; color:#6b7280;' }, r.visit_date || fmtDate(r.created_at)),
        el('td', { style: 'padding:8px 4px;' }, r.check_number ? ('Check #' + r.check_number) : '—'),
        el('td', { style: 'padding:8px 4px; text-align:right; font-variant-numeric:tabular-nums;' }, '$' + Number(r.spend || 0).toFixed(2)),
      ]));
    });
    container.appendChild(t);
  }

  function renderRedemptions(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.appendChild(el('div', { style: 'color:#6b7280; padding:12px 0;' }, 'No redemptions yet.'));
      return;
    }
    const t = el('table', { style: 'width:100%; border-collapse:collapse; font-size:13px;' });
    rows.forEach(r => {
      t.appendChild(el('tr', { style: 'border-bottom:1px solid #f3f4f6;' }, [
        el('td', { style: 'padding:8px 4px; color:#6b7280;' }, fmtDateTime(r.redeemed_at)),
        el('td', { style: 'padding:8px 4px;' }, 'Reward #' + (r.reward_id || '')),
        el('td', { style: 'padding:8px 4px; text-align:right; font-variant-numeric:tabular-nums; color:#b91c1c; font-weight:600;' }, '-' + (r.points_spent || 0).toLocaleString() + ' pts'),
      ]));
    });
    container.appendChild(t);
  }

  function renderActions(container, rows) {
    container.innerHTML = '';
    if (!rows || !rows.length) {
      container.appendChild(el('div', { style: 'color:#6b7280; padding:12px 0;' }, 'No admin actions on this account.'));
      return;
    }
    const t = el('table', { style: 'width:100%; border-collapse:collapse; font-size:13px;' });
    rows.forEach(a => {
      t.appendChild(el('tr', { style: 'border-bottom:1px solid #f3f4f6;' }, [
        el('td', { style: 'padding:8px 4px; color:#6b7280;' }, fmtDateTime(a.performed_at)),
        el('td', { style: 'padding:8px 4px; font-weight:600;' }, a.action),
        el('td', { style: 'padding:8px 4px;' }, a.amount != null ? fmtPts(a.amount) + ' pts' : ''),
        el('td', { style: 'padding:8px 4px; color:#6b7280; font-size:12px;' }, a.reason || ''),
      ]));
    });
    container.appendChild(t);
  }

  // --- mutations ------------------------------------------------------------

  async function promptCredit(m, mode) {
    const amount = prompt(`${mode === 'credit' ? 'Credit' : 'Debit'} how many points?`, '100');
    if (!amount) return;
    const n = parseInt(amount, 10);
    if (!Number.isFinite(n) || n <= 0) { alert('Enter a positive whole number.'); return; }
    const reason = prompt('Reason / note (visible in audit log):', '') || '';
    try {
      await call('POST', mode, { memberId: m.id, amount: n, reason });
      setStatus('Saved.');
      openDetail(m.id);
      refreshList();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function promptEdit(m) {
    const first_name = prompt('First name:', m.first_name || '');
    if (first_name === null) return;
    const last_name = prompt('Last name:', m.last_name || '');
    if (last_name === null) return;
    const phone = prompt('Phone:', m.phone || '');
    if (phone === null) return;
    const birthday = prompt('Birthday (YYYY-MM-DD or blank):', m.birthday || '');
    if (birthday === null) return;
    const reason = prompt('Reason for change (logged):', '') || '';
    try {
      await call('POST', 'edit_profile', { memberId: m.id, first_name, last_name, phone, birthday, reason });
      setStatus('Profile updated.');
      openDetail(m.id);
      refreshList();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function promptDisable(m) {
    const reason = prompt('Reason for disabling this account (visible in audit log):', '');
    if (reason === null) return;
    if (!confirm('Disable ' + (m.email || 'this account') + '? They will be locked out of the iOS app.')) return;
    try {
      await call('POST', 'disable', { memberId: m.id, reason });
      setStatus('Account disabled.');
      openDetail(m.id);
      refreshList();
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function doEnable(m) {
    if (!confirm('Re-enable this account?')) return;
    try {
      await call('POST', 'enable', { memberId: m.id });
      setStatus('Account re-enabled.');
      openDetail(m.id);
      refreshList();
    } catch (e) { alert('Error: ' + e.message); }
  }

  // --- wire up --------------------------------------------------------------

  function init() {
    const searchInput = document.getElementById('amSearchInput');
    const searchBtn = document.getElementById('amSearchBtn');
    const refreshBtn = document.getElementById('amRefreshBtn');
    const closeBtn = document.getElementById('amDetailClose');

    if (!searchInput || !document.getElementById('amList')) return; // section not present on page

    searchBtn && searchBtn.addEventListener('click', () => {
      lastSearch = (searchInput.value || '').trim();
      refreshList();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { lastSearch = (searchInput.value || '').trim(); refreshList(); }
    });
    refreshBtn && refreshBtn.addEventListener('click', refreshList);
    closeBtn && closeBtn.addEventListener('click', closeDetail);

    refreshList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
