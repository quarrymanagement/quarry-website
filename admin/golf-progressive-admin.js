/* =========================================================================
   Golf Progressive Jackpot — admin panel
   Self-injects a "Golf Jackpot" tab into /admin. Reads and controls the
   progressive via the golf-progressive-admin edge function, gated by the same
   admin secret the rest of the panel uses (localStorage 'quarryAdminPushSecret',
   sent as x-admin-secret). Nothing here holds money logic — the edge function
   and its SECURITY DEFINER SQL functions do. This file is display + actions only.
   ========================================================================== */
(function () {
  "use strict";

  var FUNC_URL = "https://nkulhtalltbieicvmmad.supabase.co/functions/v1/golf-progressive-admin";

  function secret() {
    try { return localStorage.getItem("quarryAdminPushSecret") || ""; } catch (e) { return ""; }
  }

  function call(op, extra) {
    return fetch(FUNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-secret": secret() },
      body: JSON.stringify(Object.assign({ op: op }, extra || {}))
    }).then(function (r) { return r.json(); });
  }

  function money(n) {
    var v = Number(n) || 0;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function chicagoToday() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  }

  /* ---- inject the sidebar item + empty panel ---- */
  function inject() {
    if (document.getElementById("golfProgressiveTab")) return;

    var golfNav = document.querySelector('.sb-nav-item[data-tab="golf"]');
    var nav = document.createElement("div");
    nav.className = "sb-nav-item";
    nav.setAttribute("data-tab", "golfProgressive");
    nav.innerHTML = '<span class="sb-ic">🏆</span><span class="sb-lbl">Golf Jackpot</span>';
    if (golfNav && golfNav.parentNode) golfNav.parentNode.insertBefore(nav, golfNav.nextSibling);
    else {
      var anyNav = document.querySelector(".sb-nav-item");
      if (anyNav && anyNav.parentNode) anyNav.parentNode.appendChild(nav);
    }
    nav.addEventListener("click", function () {
      if (typeof window.switchTab === "function") window.switchTab("golfProgressive");
      loadState();
    });

    var panel = document.createElement("div");
    panel.id = "golfProgressiveTab";
    panel.className = "tab-content";
    panel.innerHTML = shell();
    var anyTab = document.querySelector(".tab-content");
    if (anyTab && anyTab.parentNode) anyTab.parentNode.appendChild(panel);
    else document.body.appendChild(panel);

    panel.querySelector("#gpRefresh").addEventListener("click", loadState);
    panel.querySelector("#gpSync").addEventListener("click", function () {
      var b = panel.querySelector("#gpSync"); b.disabled = true; b.textContent = "Syncing…";
      call("sync").then(function () { b.disabled = false; b.textContent = "Sync now"; loadState(); })
        .catch(function () { b.disabled = false; b.textContent = "Sync now"; });
    });
    panel.querySelector("#gpRecordBtn").addEventListener("click", openWinModal);
    panel.querySelector("#gpAdjustBtn").addEventListener("click", openAdjust);
    panel.querySelector("#gpExportBtn").addEventListener("click", doExport);
  }

  function shell() {
    return ''
      + '<div style="max-width:1000px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:1.25rem;">'
      +   '<h1 style="font-family:var(--font-serif);font-size:1.6rem;color:var(--text-primary);margin:0;">Hole-In-One Progressive Jackpot</h1>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      +     '<button id="gpRefresh" class="nav-btn">Refresh</button>'
      +     '<button id="gpSync" class="nav-btn">Sync now</button>'
      +     '<button id="gpExportBtn" class="nav-btn">Weekly export</button>'
      +   '</div>'
      + '</div>'
      + '<div id="gpBody"><p style="color:var(--text-muted);">Loading…</p></div>'
      + '</div>';
  }

  function card(label, value, accent) {
    return '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1rem 1.25rem;box-shadow:var(--shadow-sm);">'
      + '<div style="font-size:0.7rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.4rem;">' + esc(label) + '</div>'
      + '<div style="font-size:1.5rem;font-weight:700;color:' + (accent || "var(--text-primary)") + ';">' + value + '</div>'
      + '</div>';
  }

  var lastState = null;

  function loadState() {
    var body = document.getElementById("gpBody");
    if (!body) return;
    if (!secret()) {
      body.innerHTML = '<div style="background:var(--yellow-dim);border:1px solid var(--border-medium);border-radius:var(--radius-md);padding:1rem;color:var(--text-secondary);">Enter the admin password on the dashboard first — this panel uses the same login.</div>';
      return;
    }
    body.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
    call("state").then(function (res) {
      if (!res || !res.ok) {
        body.innerHTML = '<div style="background:var(--red-dim);border:1px solid var(--red);border-radius:var(--radius-md);padding:1rem;color:var(--red);">Could not load jackpot: ' + esc(res && res.error) + '</div>';
        return;
      }
      lastState = res.state;
      render(res.state);
    }).catch(function (e) {
      body.innerHTML = '<div style="background:var(--red-dim);border:1px solid var(--red);border-radius:var(--radius-md);padding:1rem;color:var(--red);">Network error: ' + esc(e.message) + '</div>';
    });
  }

  function sumRange(byDay, fromDate) {
    var total = 0;
    (byDay || []).forEach(function (d) {
      if (!fromDate || d.business_date >= fromDate) total += Number(d.amount) || 0;
    });
    return total;
  }

  function render(st) {
    var cur = st.current || { jackpot: 1000, buckets_since_reset: 0 };
    var byDay = st.contribution_by_day || [];
    var today = chicagoToday();
    var weekAgo = new Date(Date.now() - 6 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    var monthStart = today.slice(0, 8) + "01";

    var resetDate = "";
    try { if (cur.last_reset_at) resetDate = new Date(cur.last_reset_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }); } catch (e) {}

    var h = '';
    // Hero jackpot
    h += '<div style="background:linear-gradient(180deg,#241609,#1a1a1a);border:1px solid var(--border-accent);border-radius:var(--radius-lg);padding:1.75rem 2rem;text-align:center;margin-bottom:1.25rem;">'
      + '<div style="font-size:0.7rem;letter-spacing:0.25em;text-transform:uppercase;color:#C4956A;margin-bottom:0.5rem;">Current Jackpot</div>'
      + '<div style="font-family:var(--font-serif);font-size:3.4rem;font-weight:700;color:#D4AF6A;line-height:1;">' + money(cur.jackpot) + '</div>'
      + '<div style="font-size:0.75rem;color:rgba(245,240,232,0.65);margin-top:0.6rem;">' + (Number(cur.buckets_since_reset) || 0) + ' buckets since reset' + (resetDate ? ' &middot; growing since ' + esc(resetDate) : '') + '</div>'
      + '<button id="gpRecordBtn" style="margin-top:1.1rem;background:#B8933A;color:#2C1A0E;border:0;border-radius:var(--radius-sm);padding:0.7rem 1.5rem;font-weight:700;font-size:0.8rem;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;">Record Hole-In-One</button>'
      + '</div>';

    // Stat cards
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:1.25rem;">'
      + card("Added today", money(sumRange(byDay.filter(function (d) { return d.business_date === today; }), null)))
      + card("This week", money(sumRange(byDay, weekAgo)), "var(--green)")
      + card("This month", money(sumRange(byDay, monthStart)), "var(--gold)")
      + card("Seed / reset", money((st.config && st.config.seed_amount) || 1000))
      + '</div>';

    // Actions row
    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1.5rem;">'
      + '<button id="gpAdjustBtn" class="nav-btn">Manual adjustment</button>'
      + '</div>';

    // Recent ledger
    h += '<h3 style="font-size:0.95rem;color:var(--text-primary);margin:0 0 0.6rem;">Recent activity</h3>';
    h += ledgerTable(st.recent_ledger || []);

    // Win history
    h += '<h3 style="font-size:0.95rem;color:var(--text-primary);margin:1.5rem 0 0.6rem;">Win history</h3>';
    h += winTable(st.wins || []);

    var body = document.getElementById("gpBody");
    body.innerHTML = h;
    body.querySelector("#gpRecordBtn").addEventListener("click", openWinModal);
    body.querySelector("#gpAdjustBtn").addEventListener("click", openAdjust);
  }

  function ledgerTable(rows) {
    if (!rows.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">No contributions yet.</p>';
    var h = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.8rem;">'
      + '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);">'
      + '<th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Type</th><th style="padding:6px 8px;">Source</th><th style="padding:6px 8px;text-align:right;">Buckets</th><th style="padding:6px 8px;text-align:right;">Amount</th><th style="padding:6px 8px;">Note</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var amt = Number(r.amount) || 0;
      var col = r.entry_type === "reversal" || amt < 0 ? "var(--red)" : (r.entry_type === "reset" ? "var(--text-muted)" : "var(--green)");
      h += '<tr style="border-bottom:1px solid var(--border-subtle);">'
        + '<td style="padding:6px 8px;">' + esc(r.business_date) + '</td>'
        + '<td style="padding:6px 8px;">' + esc(r.entry_type) + '</td>'
        + '<td style="padding:6px 8px;">' + esc(r.source) + '</td>'
        + '<td style="padding:6px 8px;text-align:right;">' + (Number(r.bucket_count) || 0) + '</td>'
        + '<td style="padding:6px 8px;text-align:right;color:' + col + ';">' + money(amt) + '</td>'
        + '<td style="padding:6px 8px;color:var(--text-secondary);">' + esc(r.note) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  function winTable(rows) {
    if (!rows.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">No wins recorded.</p>';
    var h = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.8rem;">'
      + '<thead><tr style="text-align:left;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);">'
      + '<th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Winner</th><th style="padding:6px 8px;">Bay</th><th style="padding:6px 8px;text-align:right;">Payout</th><th style="padding:6px 8px;">Verified by</th><th style="padding:6px 8px;">Paid</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr style="border-bottom:1px solid var(--border-subtle);">'
        + '<td style="padding:6px 8px;">' + esc(r.business_date) + '</td>'
        + '<td style="padding:6px 8px;">' + esc(r.winner_name || "—") + '</td>'
        + '<td style="padding:6px 8px;">' + esc(r.bay == null ? "—" : r.bay) + '</td>'
        + '<td style="padding:6px 8px;text-align:right;font-weight:700;">' + money(r.payout_amount) + '</td>'
        + '<td style="padding:6px 8px;">' + esc(r.verified_by || "—") + '</td>'
        + '<td style="padding:6px 8px;">' + (r.paid_at ? "Yes" : '<span style="color:var(--yellow);">Unpaid</span>') + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* ---- overlay helper ---- */
  function overlay(inner) {
    var o = document.createElement("div");
    o.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:100000;padding:1rem;";
    o.innerHTML = '<div style="background:var(--bg-card);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);max-width:460px;width:100%;padding:1.5rem;max-height:90vh;overflow:auto;">' + inner + '</div>';
    o.addEventListener("click", function (e) { if (e.target === o) o.remove(); });
    document.body.appendChild(o);
    return o;
  }
  function field(id, label, type, val) {
    return '<label style="display:block;margin-bottom:0.75rem;">'
      + '<span style="display:block;font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.25rem;">' + esc(label) + '</span>'
      + '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(val || "") + '" style="width:100%;padding:0.55rem 0.7rem;border:1px solid var(--border-medium);border-radius:var(--radius-sm);font-size:0.9rem;box-sizing:border-box;"/>'
      + '</label>';
  }

  /* ---- Record Hole-In-One (guarded) ---- */
  function openWinModal() {
    var payout = lastState && lastState.current ? Number(lastState.current.jackpot) : 0;
    var nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    var o = overlay(''
      + '<h2 style="font-family:var(--font-serif);margin:0 0 0.35rem;color:var(--text-primary);">Record a hole-in-one</h2>'
      + '<div style="background:#241609;border:1px solid var(--border-accent);border-radius:var(--radius-md);padding:0.9rem 1rem;text-align:center;margin:0.75rem 0 1rem;">'
      +   '<div style="font-size:0.7rem;letter-spacing:0.15em;text-transform:uppercase;color:#C4956A;">Payout to winner</div>'
      +   '<div style="font-family:var(--font-serif);font-size:2.2rem;font-weight:700;color:#D4AF6A;">' + money(payout) + '</div>'
      +   '<div style="font-size:0.7rem;color:rgba(245,240,232,0.6);margin-top:0.3rem;">This resets the jackpot to ' + money((lastState && lastState.config && lastState.config.seed_amount) || 1000) + '.</div>'
      + '</div>'
      + field("gpWinName", "Winner name (required)", "text", "")
      + field("gpWinContact", "Winner contact (phone / email)", "text", "")
      + field("gpWinBay", "Bay", "number", "")
      + field("gpWinMgr", "Verifying manager (required)", "text", "")
      + field("gpWinWitness", "Witness", "text", "")
      + field("gpWinVideo", "Video URL", "text", "")
      + field("gpWinWhen", "When", "datetime-local", nowLocal)
      + '<div id="gpWinErr" style="color:var(--red);font-size:0.8rem;min-height:1.1em;margin-bottom:0.5rem;"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      +   '<button id="gpWinCancel" class="nav-btn">Cancel</button>'
      +   '<button id="gpWinConfirm" style="background:var(--red);color:#fff;border:0;border-radius:var(--radius-sm);padding:0.6rem 1.2rem;font-weight:700;cursor:pointer;opacity:0.5;" disabled>Confirm payout</button>'
      + '</div>');

    var name = o.querySelector("#gpWinName"), mgr = o.querySelector("#gpWinMgr");
    var confirm = o.querySelector("#gpWinConfirm");
    function gate() {
      var ok = name.value.trim() && mgr.value.trim();
      confirm.disabled = !ok; confirm.style.opacity = ok ? "1" : "0.5";
    }
    name.addEventListener("input", gate); mgr.addEventListener("input", gate);
    o.querySelector("#gpWinCancel").addEventListener("click", function () { o.remove(); });
    confirm.addEventListener("click", function () {
      confirm.disabled = true; confirm.textContent = "Recording…";
      var whenVal = o.querySelector("#gpWinWhen").value;
      call("hole_in_one", {
        winner_name: name.value.trim(),
        winner_contact: o.querySelector("#gpWinContact").value.trim(),
        bay: o.querySelector("#gpWinBay").value || null,
        verified_by: mgr.value.trim(),
        witness: o.querySelector("#gpWinWitness").value.trim(),
        video_url: o.querySelector("#gpWinVideo").value.trim(),
        occurred_at: whenVal ? new Date(whenVal).toISOString() : null
      }).then(function (res) {
        if (res && res.ok && res.result && res.result.ok) {
          o.remove();
          alert("Recorded. Payout $" + Number(res.result.payout_amount).toLocaleString("en-US", { minimumFractionDigits: 2 }) + ". Jackpot reset to " + money(res.result.new_jackpot) + ".");
          loadState();
        } else {
          o.querySelector("#gpWinErr").textContent = (res && (res.error || (res.result && res.result.error))) || "Failed.";
          confirm.disabled = false; confirm.textContent = "Confirm payout";
        }
      }).catch(function (e) {
        o.querySelector("#gpWinErr").textContent = e.message;
        confirm.disabled = false; confirm.textContent = "Confirm payout";
      });
    });
  }

  /* ---- Manual adjustment ---- */
  function openAdjust() {
    var o = overlay(''
      + '<h2 style="font-family:var(--font-serif);margin:0 0 0.75rem;color:var(--text-primary);">Manual adjustment</h2>'
      + '<p style="font-size:0.8rem;color:var(--text-secondary);margin:0 0 0.75rem;">Adds a correcting row to the ledger. Use a positive amount to add, negative to subtract. A note is required.</p>'
      + field("gpAdjAmount", "Amount (e.g. -5 or 25)", "number", "")
      + field("gpAdjNote", "Reason (required)", "text", "")
      + '<div id="gpAdjErr" style="color:var(--red);font-size:0.8rem;min-height:1.1em;margin-bottom:0.5rem;"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;">'
      +   '<button id="gpAdjCancel" class="nav-btn">Cancel</button>'
      +   '<button id="gpAdjSave" class="nav-btn" style="border-color:var(--gold);color:var(--gold);">Save adjustment</button>'
      + '</div>');
    o.querySelector("#gpAdjCancel").addEventListener("click", function () { o.remove(); });
    o.querySelector("#gpAdjSave").addEventListener("click", function () {
      var amt = o.querySelector("#gpAdjAmount").value, note = o.querySelector("#gpAdjNote").value.trim();
      if (!amt || isNaN(Number(amt))) { o.querySelector("#gpAdjErr").textContent = "Enter a number."; return; }
      if (!note) { o.querySelector("#gpAdjErr").textContent = "A reason is required."; return; }
      call("adjust", { amount: Number(amt), note: note }).then(function (res) {
        if (res && res.ok) { o.remove(); loadState(); }
        else o.querySelector("#gpAdjErr").textContent = (res && res.error) || "Failed.";
      });
    });
  }

  /* ---- Weekly export ---- */
  function doExport() {
    var end = chicagoToday();
    var start = new Date(Date.now() - 90 * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    call("export", { start: start, end: end }).then(function (res) {
      if (!res || !res.ok) { alert("Export failed: " + (res && res.error)); return; }
      var weeks = (res.result && res.result.weeks) || [];
      var payouts = (res.result && res.result.payouts) || [];
      var csv = "week_start,contributions,buckets\n";
      weeks.forEach(function (w) { csv += w.week_start + "," + w.contributions + "," + w.buckets + "\n"; });
      csv += "\npayout_date,payout_amount,winner,paid_at,method\n";
      payouts.forEach(function (p) { csv += p.business_date + "," + p.payout_amount + "," + (p.winner_name || "") + "," + (p.paid_at || "") + "," + (p.paid_method || "") + "\n"; });
      var blob = new Blob([csv], { type: "text/csv" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "golf-progressive-" + start + "_to_" + end + ".csv";
      a.click();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
  else inject();
})();
