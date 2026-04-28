/**
 * The Quarry — GA4 Conversion Event Tracking
 *
 * Loaded after the gtag.js bootstrap on every public page. Listens for clicks
 * site-wide and fires named events to GA4 for the things we care about as
 * conversions:
 *
 *   reservation_click       — anyone clicking through to /quarry-private-events
 *   event_ticket_click      — anyone clicking through to /quarry-events
 *   wine_club_click         — anyone clicking through to /quarry-wineclub
 *   wine_club_signup_click  — anyone hitting "Start Your Membership" on wineclub page
 *   menu_click              — anyone clicking through to /quarry-menu
 *   golf_click              — anyone clicking through to /quarry-golf
 *   phone_click             — any tel: link click
 *   email_click             — any mailto: link click
 *   outbound_click          — any click going off thequarrystl.com
 *
 * After events appear in GA4 (Reports → Engagement → Events), mark the ones
 * you care about as "Key Events" in Admin → Key events. That's the GA4 v4
 * equivalent of the old "Conversions" toggle. One click per event. Done.
 *
 * SAFETY: This script is a no-op if window.gtag isn't defined. It also
 * de-duplicates events fired within 500ms (prevents double-counting from
 * delegated handlers).
 */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var lastFiredAt = {};  // event_name -> timestamp
    function fire(name, params) {
        if (typeof window.gtag !== 'function') return;
        // De-dupe within 500ms (prevents double-fire on link with click + auxclick handlers)
        var now = Date.now();
        if (lastFiredAt[name] && now - lastFiredAt[name] < 500) return;
        lastFiredAt[name] = now;
        try { window.gtag('event', name, params || {}); } catch (_) {}
    }

    function getCleanText(el) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    }

    function pathOf(href) {
        try { return new URL(href, window.location.href).pathname.toLowerCase(); }
        catch (_) { return ''; }
    }

    function isInternalDomain(href) {
        try {
            var u = new URL(href, window.location.href);
            return /(^|\.)thequarrystl\.com$/i.test(u.hostname);
        } catch (_) { return true; }
    }

    document.addEventListener('click', function (e) {
        // Walk up the DOM in case the user clicked an icon inside an <a>
        var link = e.target && e.target.closest ? e.target.closest('a, button[data-href]') : null;
        if (!link) return;

        var href = link.getAttribute('href') || link.getAttribute('data-href') || '';
        if (!href) return;

        var currentPath = (window.location.pathname || '').toLowerCase();
        var hrefLower = href.toLowerCase();
        var targetPath = pathOf(href);
        var label = getCleanText(link);

        // ── Phone clicks ─────────────────────────────────────────────
        if (hrefLower.indexOf('tel:') === 0) {
            fire('phone_click', { phone_number: href.replace(/^tel:/i, ''), source_page: currentPath });
            return;
        }

        // ── Email clicks ─────────────────────────────────────────────
        if (hrefLower.indexOf('mailto:') === 0) {
            fire('email_click', { email_address: href.replace(/^mailto:/i, '').split('?')[0], source_page: currentPath });
            return;
        }

        // ── Wine club signup button (only when ON the wineclub page) ─
        // Match "Start Your Membership", "Become a Member", "Sign Up", etc.
        if (currentPath.indexOf('quarry-wineclub') !== -1) {
            var lc = label.toLowerCase();
            if (/start.*member|become.*member|join.*rock.*vine|sign.*up/.test(lc)) {
                fire('wine_club_signup_click', { button_text: label });
                return;
            }
        }

        // ── Internal CTA navigations (don't double-fire on same-page anchors) ─
        if (targetPath && targetPath !== currentPath && isInternalDomain(href)) {
            if (targetPath.indexOf('/quarry-private-events') !== -1) {
                fire('reservation_click', { link_text: label, source_page: currentPath, link_url: href });
                return;
            }
            if (targetPath.indexOf('/quarry-events') !== -1 || targetPath.indexOf('/quarry-event-detail') !== -1) {
                fire('event_ticket_click', { link_text: label, source_page: currentPath, link_url: href });
                return;
            }
            if (targetPath.indexOf('/quarry-wineclub') !== -1) {
                fire('wine_club_click', { link_text: label, source_page: currentPath, link_url: href });
                return;
            }
            if (targetPath.indexOf('/quarry-menu') !== -1 || targetPath.indexOf('/quarry-drinks') !== -1) {
                fire('menu_click', { link_text: label, source_page: currentPath, link_url: href });
                return;
            }
            if (targetPath.indexOf('/quarry-golf') !== -1) {
                fire('golf_click', { link_text: label, source_page: currentPath, link_url: href });
                return;
            }
        }

        // ── Outbound clicks (other domains) ─────────────────────────
        if (/^https?:\/\//i.test(href) && !isInternalDomain(href)) {
            try {
                var dest = new URL(href);
                fire('outbound_click', { link_domain: dest.hostname, link_url: href, link_text: label, source_page: currentPath });
            } catch (_) {}
        }
    }, true);

    // Form submissions: try to detect the contact / private events / signup forms
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || form.tagName !== 'FORM') return;
        var action = (form.action || '').toLowerCase();
        var name = (form.getAttribute('name') || form.id || '').toLowerCase();
        var path = (window.location.pathname || '').toLowerCase();

        // Wine club membership signup
        if (path.indexOf('quarry-wineclub') !== -1 || /wineclub|member/.test(name)) {
            fire('wine_club_signup_submit', { form_name: name || 'wineclub-form', source_page: path });
            return;
        }
        // Private events form
        if (path.indexOf('quarry-private-events') !== -1 || /private|event|wedding|inquiry/.test(name)) {
            fire('private_event_inquiry_submit', { form_name: name || 'private-events-form', source_page: path });
            return;
        }
        // Generic contact / mailing list
        if (/contact|subscribe|signup|newsletter/.test(name + ' ' + action)) {
            fire('contact_form_submit', { form_name: name || 'contact-form', source_page: path });
            return;
        }
    }, true);
})();
