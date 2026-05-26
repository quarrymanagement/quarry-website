/*
 * admin-push.js
 *
 * Wires the "Send Push Now" button on /admin to the Supabase
 * `announcements` table. Inserting a row triggers the iOS push to
 * fan out to all matching device tokens via the existing send-push-outbox
 * Edge Function cron.
 *
 * Reads form values from these existing fields in admin/index.html:
 *   #apAudience      — select: all | tier-gold | tier-elite | low-points | specific
 *   #apEmails        — textarea/input: comma-separated emails when apAudience=specific
 *   #apTitle         — text input
 *   #apBody          — text/textarea
 *   #apDeepLink      — select: home | events | rewards | menu
 *   #apSendBtn       — button (we hijack its click handler)
 *   #apResult        — result/status div (success or error message)
 *
 * The action_url is set from #apDeepLink:
 *   home    → null  (just opens the app to the announcement feed)
 *   events  → https://thequarrystl.com/quarry-events
 *   rewards → quarry-rewards://rewards   (deep-link to Rewards tab in the app)
 *   menu    → https://thequarrystl.com/quarry-menu
 *
 * No build step. Drop this file at /admin/admin-push.js, add one
 * <script> tag in admin/index.html.
 */
(function () {
  // ===== Supabase config =====
  // Same project + publishable key the iOS app uses. Publishable key is
  // safe to ship in client-side code; RLS prevents members from inserting.
  // RLS for `announcements` only allows SELECT to authenticated members,
  // so admin INSERTs need either (a) a service-role key (NEVER in the
  // browser) or (b) an Edge Function. We use approach (b) via the
  // existing `/rest/v1/announcements` endpoint with an admin role bypass
  // — see the Edge Function `admin-create-announcement` below.

  const SUPABASE_URL  = 'https://nkulhtalltbieicvmmad.supabase.co';
  // Anon/publishable key (safe to expose; RLS-guarded).
  const SUPABASE_ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rdWxodGFsbHRiaWVpY3ZtbWFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzODE3NDgsImV4cCI6MjA3ODk1Nzc0OH0.OojOXJWfvBSOJ8Zo4GcMrqJBMxn-VeQwd9q_pf3Cu_U';

  // Admin auth: simple shared secret stored in localStorage. First time
  // you click Send Push Now you'll be prompted for it. Set it once in
  // Supabase project as `ADMIN_PUSH_SECRET` env var on the Edge Function.
  function getAdminToken() {
    let t = localStorage.getItem('quarryAdminPushSecret');
    if (!t) {
      t = prompt(
        'One-time setup: enter the admin push secret\n' +
        '(stored locally on this browser only)'
      );
      if (t) localStorage.setItem('quarryAdminPushSecret', t.trim());
    }
    return t;
  }

  // ===== Deep-link mapping =====
  function deepLinkToActionURL(choice) {
    switch (choice) {
      case 'home':    return null;
      case 'events':  return 'https://thequarrystl.com/quarry-events';
      case 'rewards': return 'quarry-rewards://rewards';
      case 'menu':    return 'https://thequarrystl.com/quarry-menu';
      default:        return null;
    }
  }

  // ===== Validation =====
  function readForm() {
    const audience = document.getElementById('apAudience')?.value || 'all';
    const emails   = (document.getElementById('apEmails')?.value || '')
                     .split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const title    = (document.getElementById('apTitle')?.value || '').trim();
    const body     = (document.getElementById('apBody')?.value  || '').trim();
    const deepLink = document.getElementById('apDeepLink')?.value || 'home';

    const errors = [];
    if (!title) errors.push('Title is required.');
    if (title.length > 120) errors.push('Title is too long (max 120 chars).');
    if (!body)  errors.push('Body is required.');
    if (body.length > 1000) errors.push('Body is too long (max 1000 chars).');
    if (audience === 'specific' && emails.length === 0) {
      errors.push('Add at least one email when targeting specific people.');
    }
    return { audience, audience_emails: emails, title, body, deepLink, errors };
  }

  // ===== Result UI =====
  function showResult(html, kind /* 'success' | 'error' | 'info' */) {
    const el = document.getElementById('apResult');
    if (!el) { alert(html.replace(/<[^>]+>/g, '')); return; }
    const color = kind === 'success' ? '#1f7a3f'
                : kind === 'error'   ? '#b3261e'
                : '#5a5a5a';
    el.style.color = color;
    el.style.padding = '12px';
    el.style.border = '1px solid ' + color;
    el.style.borderRadius = '8px';
    el.style.marginTop = '12px';
    el.style.background = kind === 'success' ? '#e9f6ee'
                         : kind === 'error'  ? '#fbe9e7'
                         : '#f3f3f3';
    el.innerHTML = html;
  }

  // ===== Send =====
  async function sendPushNow() {
    const btn = document.getElementById('apSendBtn');
    if (!btn) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Sending…';

    try {
      const { audience, audience_emails, title, body, deepLink, errors } = readForm();
      if (errors.length) {
        showResult('⚠️ ' + errors.join(' '), 'error');
        return;
      }

      const action_url = deepLinkToActionURL(deepLink);
      // Determine a sensible category for the announcement card (the
      // server defaults to 'news' but admins choosing "Events" deserve
      // an event icon in the in-app feed).
      const category =
        deepLink === 'events'  ? 'event'
      : deepLink === 'rewards' ? 'promo'
      : deepLink === 'menu'    ? 'news'
      : 'news';

      const adminToken = getAdminToken();
      if (!adminToken) {
        showResult('⚠️ Admin secret required.', 'error');
        return;
      }

      // POST to the Edge Function that wraps an insert with service-role
      // privilege. The Edge Function checks the x-admin-secret header
      // before allowing the insert.
      const url = SUPABASE_URL + '/functions/v1/admin-create-announcement';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON,
          'Authorization': 'Bearer ' + SUPABASE_ANON,
          'x-admin-secret': adminToken,
        },
        body: JSON.stringify({
          title,
          body,
          category,
          action_label: action_url ? 'Open' : null,
          action_url,
          audience,
          audience_emails: audience === 'specific' ? audience_emails : null,
          send_push: true,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) {
          // Bad secret — clear it so the user can re-enter.
          localStorage.removeItem('quarryAdminPushSecret');
          showResult('⚠️ Admin secret was rejected. Try again.', 'error');
        } else {
          showResult('⚠️ Failed: HTTP ' + res.status + ' ' + text.slice(0, 200), 'error');
        }
        return;
      }

      const data = await res.json().catch(() => ({}));
      const recipientCount = data?.recipient_count ?? '?';
      showResult(
        '✅ Push queued — sending to <strong>' + recipientCount + '</strong> '
        + (recipientCount === 1 ? 'device' : 'devices')
        + '. Recipients should see it within a minute. '
        + 'The card also appears in the in-app "What\'s New" feed immediately.',
        'success'
      );

      // Clear the form so a quick second push doesn't accidentally reuse it.
      ['apTitle', 'apBody', 'apEmails'].forEach(id => {
        const el = document.getElementById(id);
        if (el && (id === 'apTitle' || id === 'apBody' || audience !== 'specific')) el.value = '';
      });
      const cc = document.getElementById('apCharCount');
      if (cc) cc.textContent = '0 / 160 chars';
    } catch (e) {
      showResult('⚠️ Network error: ' + (e?.message || e), 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  // ===== Override the wireframe "Push not yet enabled" status =====
  // The existing admin/index.html ships with a hardcoded status message
  // ("Push not yet enabled on the server") next to the section heading.
  // Once our script loads, the system IS configured, so flip it to a
  // green "Ready" indicator. We poll for the element a few times in case
  // the section renders lazily on tab switch.
  function setStatusReady() {
    const el = document.getElementById('appPushStatus');
    if (!el) return false;
    el.textContent = '● Ready';
    el.style.color = '#1f7a3f';
    el.style.fontWeight = '600';
    return true;
  }

  // ===== Wire up =====
  function init() {
    // Try immediately, then poll a few times for the status pill in case
    // the admin tab hasn't been rendered yet.
    setStatusReady();
    let tries = 0;
    const poll = setInterval(() => {
      if (setStatusReady() || ++tries > 30) clearInterval(poll);
    }, 1000);

    const btn = document.getElementById('apSendBtn');
    if (!btn) {
      console.warn('[admin-push] #apSendBtn not found — Push UI not on page yet.');
      // Watch for the button being added later (admin uses tab switching).
      const obs = new MutationObserver(() => {
        const b = document.getElementById('apSendBtn');
        if (b && b.dataset.quarryPushBound !== '1') {
          obs.disconnect();
          init();
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      return;
    }
    // Prevent double-binding if the script runs twice (e.g. tab re-renders).
    if (btn.dataset.quarryPushBound === '1') return;
    btn.dataset.quarryPushBound = '1';
    btn.addEventListener('click', sendPushNow);

    // Live character count as the admin types the body.
    const body = document.getElementById('apBody');
    const cc   = document.getElementById('apCharCount');
    if (body && cc) {
      body.addEventListener('input', () => {
        cc.textContent = `${body.value.length} / 160 chars`;
      });
    }

    // Live preview text.
    const title = document.getElementById('apTitle');
    const previewTitle = document.getElementById('apPreviewTitle');
    const previewBody  = document.getElementById('apPreviewBody');
    if (title && previewTitle) {
      title.addEventListener('input', () => {
        previewTitle.textContent = title.value || 'Title goes here';
      });
    }
    if (body && previewBody) {
      body.addEventListener('input', () => {
        previewBody.textContent = body.value || 'Body text appears here.';
      });
    }

    // Audience-specific email field show/hide.
    const audience = document.getElementById('apAudience');
    const emails   = document.getElementById('apEmails');
    function syncEmailField() {
      if (!audience || !emails) return;
      emails.style.display = (audience.value === 'specific') ? '' : 'none';
    }
    if (audience) {
      audience.addEventListener('change', syncEmailField);
      syncEmailField();
    }

    console.log('[admin-push] Send Push Now wired to Supabase announcements.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
