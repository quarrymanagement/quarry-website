/* =========================================================================
   Site Notice Banner — admin panel
   Self-injects a "Notices" tab into /admin so the hours/event banner can be
   posted, edited, and removed without a code change. Reads and writes through
   the site-notices-admin edge function, gated by the same admin secret the
   rest of the panel uses (localStorage 'quarryAdminPushSecret', sent as
   x-admin-secret). The public banner (notice.js) reads the same table with the
   anon key. This file is display + actions only.
   ========================================================================== */
(function () {
  "use strict";

  var FUNC_URL = "https://nkulhtalltbieicvmmad.supabase.co/functions/v1/site-notices-admin";

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

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  /* Preview: allow only <b> from the message, escape the rest — mirrors notice.js. */
  function bodyHtml(s) {
    return esc(s).replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
  }
  function chicagoToday() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  }
  function niceDate(d) {
    if (!d) return "";
    try {
      return new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
    } catch (e) { return d; }
  }

  var editId = null; // null = creating, otherwise editing this notice id

  /* ---- inject the sidebar item + empty panel ---- */
  function inject() {
    if (document.getElementById("noticesTab")) return;

    var nav = document.createElement("div");
    nav.className = "sb-nav-item";
    nav.setAttribute("data-tab", "notices");
    nav.innerHTML = '<span class="sb-ic">📣</span><span class="sb-lbl">Notices</span>';
    var anchor = document.querySelector('.sb-nav-item[data-tab="golfProgressive"]') ||
                 document.querySelector('.sb-nav-item[data-tab="golf"]');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(nav, anchor.nextSibling);
    else {
      var anyNav = document.querySelector(".sb-nav-item");
      if (anyNav && anyNav.parentNode) anyNav.parentNode.appendChild(nav);
    }
    nav.addEventListener("click", function () {
      if (typeof window.switchTab === "function") window.switchTab("notices");
      load();
    });

    var panel = document.createElement("div");
    panel.id = "noticesTab";
    panel.className = "tab-content";
    panel.innerHTML = shell();
    var anyTab = document.querySelector(".tab-content");
    if (anyTab && anyTab.parentNode) anyTab.parentNode.appendChild(panel);
    else document.body.appendChild(panel);

    // Only #ntRefresh exists in the shell; the form (with #ntSave etc.) is
    // injected lazily in load() once the admin is authenticated.
    panel.querySelector("#ntRefresh").addEventListener("click", load);
  }

  function shell() {
    return ''
      + '<div style="max-width:1000px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:0.5rem;">'
      +   '<h1 style="font-family:var(--font-serif);font-size:1.6rem;color:var(--text-primary);margin:0;">Site Notice Banner</h1>'
      +   '<button id="ntRefresh" class="nav-btn">Refresh</button>'
      + '</div>'
      + '<p style="color:var(--text-muted);margin:0 0 1.25rem;font-size:0.9rem;line-height:1.5;">'
      +   'Posts a banner across the top of every page — hours changes, private events, holiday hours. '
      +   'Visitors can dismiss it for the day. A notice removes itself after its end date, so you don’t have to come back.'
      + '</p>'
      + '<div id="ntGate"></div>'
      + '<div id="ntFormWrap"></div>'
      + '<div id="ntList"><p style="color:var(--text-muted);">Loading…</p></div>'
      + '</div>';
  }

  function formHtml() {
    return ''
      + '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1.25rem 1.4rem;box-shadow:var(--shadow-sm);margin-bottom:1.5rem;">'
      + '<div id="ntFormTitle" style="font-size:0.72rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:1rem;">Add a notice</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1rem;">'
      +   '<label style="flex:1 1 180px;min-width:160px;">'
      +     '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.3rem;">Label <span style="color:var(--text-muted);">(optional)</span></span>'
      +     '<input id="ntLabel" type="text" maxlength="40" placeholder="Sat Aug 1" style="width:100%;box-sizing:border-box;padding:0.55rem 0.7rem;background:var(--bg-input,#1c1c1c);border:1px solid var(--border-medium);border-radius:var(--radius-sm,6px);color:var(--text-primary);font-size:0.9rem;">'
      +   '</label>'
      +   '<label style="flex:3 1 320px;min-width:240px;">'
      +     '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.3rem;">Message &nbsp;<span style="color:var(--text-muted);">wrap words in &lt;b&gt;…&lt;/b&gt; to make them gold</span></span>'
      +     '<input id="ntMsg" type="text" maxlength="400" placeholder="Opening at <b>12 PM</b> due to a private event." style="width:100%;box-sizing:border-box;padding:0.55rem 0.7rem;background:var(--bg-input,#1c1c1c);border:1px solid var(--border-medium);border-radius:var(--radius-sm,6px);color:var(--text-primary);font-size:0.9rem;">'
      +   '</label>'
      + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;margin-top:1rem;">'
      +   '<label style="flex:0 1 170px;min-width:150px;">'
      +     '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.3rem;">Starts showing</span>'
      +     '<input id="ntFrom" type="date" style="width:100%;box-sizing:border-box;padding:0.5rem 0.6rem;background:var(--bg-input,#1c1c1c);border:1px solid var(--border-medium);border-radius:var(--radius-sm,6px);color:var(--text-primary);font-size:0.9rem;">'
      +   '</label>'
      +   '<label style="flex:0 1 170px;min-width:150px;">'
      +     '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.3rem;">Last day shown</span>'
      +     '<input id="ntTo" type="date" style="width:100%;box-sizing:border-box;padding:0.5rem 0.6rem;background:var(--bg-input,#1c1c1c);border:1px solid var(--border-medium);border-radius:var(--radius-sm,6px);color:var(--text-primary);font-size:0.9rem;">'
      +   '</label>'
      +   '<label style="display:flex;align-items:center;gap:0.5rem;flex:0 0 auto;padding-bottom:0.55rem;color:var(--text-secondary);font-size:0.9rem;cursor:pointer;">'
      +     '<input id="ntActive" type="checkbox" checked style="width:16px;height:16px;"> Live'
      +   '</label>'
      + '</div>'
      + '<div id="ntPreviewWrap" style="margin-top:1.1rem;"></div>'
      + '<div style="display:flex;gap:10px;margin-top:1.2rem;">'
      +   '<button id="ntSave" class="nav-btn" style="background:var(--accent,#B8933A);color:#1a1a1a;font-weight:600;">Add notice</button>'
      +   '<button id="ntClear" class="nav-btn">Clear</button>'
      + '</div>'
      + '</div>';
  }

  function renderPreview() {
    var wrap = document.getElementById("ntPreviewWrap");
    if (!wrap) return;
    var msg = (document.getElementById("ntMsg") || {}).value || "";
    var lbl = (document.getElementById("ntLabel") || {}).value || "";
    if (!msg.trim()) { wrap.innerHTML = ""; return; }
    wrap.innerHTML =
      '<div style="font-size:0.66rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:0.4rem;">Preview</div>'
      + '<div style="background:#2C1A0E;border:1px solid rgba(188,149,106,0.5);border-radius:6px;padding:0.7rem 1rem;display:flex;gap:1rem;align-items:baseline;">'
      +   (lbl ? '<span style="font-size:0.6rem;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;color:#C4956A;flex-shrink:0;">' + esc(lbl) + '</span>' : '')
      +   '<span style="font-size:0.85rem;color:#F5F0E8;">' + bodyHtml(msg) + '</span>'
      + '</div>';
    var bs = wrap.querySelectorAll("b");
    for (var i = 0; i < bs.length; i++) { bs[i].style.color = "#D4AF6A"; bs[i].style.fontWeight = "600"; }
  }

  function resetForm() {
    editId = null;
    var f = document.getElementById("ntFormWrap");
    if (!f) return;
    f.querySelector("#ntFormTitle").textContent = "Add a notice";
    f.querySelector("#ntLabel").value = "";
    f.querySelector("#ntMsg").value = "";
    f.querySelector("#ntFrom").value = "";
    f.querySelector("#ntTo").value = "";
    f.querySelector("#ntActive").checked = true;
    f.querySelector("#ntSave").textContent = "Add notice";
    renderPreview();
  }

  function fillForm(n) {
    editId = n.id;
    var f = document.getElementById("ntFormWrap");
    f.querySelector("#ntFormTitle").textContent = "Editing notice";
    f.querySelector("#ntLabel").value = n.day_label || "";
    f.querySelector("#ntMsg").value = n.message || "";
    f.querySelector("#ntFrom").value = n.from_date || "";
    f.querySelector("#ntTo").value = n.to_date || "";
    f.querySelector("#ntActive").checked = n.active !== false;
    f.querySelector("#ntSave").textContent = "Save changes";
    renderPreview();
    var w = document.getElementById("noticesTab");
    if (w && w.scrollIntoView) w.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function save() {
    var btn = document.getElementById("ntSave");
    var msg = document.getElementById("ntMsg").value.trim();
    if (!msg) { flash("Enter a message first.", true); return; }
    var payload = {
      day_label: document.getElementById("ntLabel").value.trim() || null,
      message: msg,
      from_date: document.getElementById("ntFrom").value || null,
      to_date: document.getElementById("ntTo").value || null,
      active: document.getElementById("ntActive").checked,
      sort_order: 0
    };
    btn.disabled = true; btn.textContent = "Saving…";
    var op = editId ? "update" : "create";
    if (editId) payload.id = editId;
    call(op, payload).then(function (res) {
      btn.disabled = false;
      btn.textContent = editId ? "Save changes" : "Add notice";
      if (!res || !res.ok) { flash("Could not save: " + (res && res.error), true); return; }
      resetForm();
      load();
      flash(op === "create" ? "Notice posted." : "Notice updated.", false);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = editId ? "Save changes" : "Add notice";
      flash("Network error: " + e.message, true);
    });
  }

  function del(id) {
    if (!window.confirm("Remove this notice?")) return;
    call("delete", { id: id }).then(function (res) {
      if (!res || !res.ok) { flash("Could not delete: " + (res && res.error), true); return; }
      if (editId === id) resetForm();
      load();
      flash("Notice removed.", false);
    }).catch(function (e) { flash("Network error: " + e.message, true); });
  }

  function toggleActive(n) {
    call("update", { id: n.id, active: !(n.active !== false) }).then(function (res) {
      if (!res || !res.ok) { flash("Could not update: " + (res && res.error), true); return; }
      load();
    }).catch(function (e) { flash("Network error: " + e.message, true); });
  }

  function flash(text, isErr) {
    var g = document.getElementById("ntGate");
    if (!g) return;
    g.innerHTML = '<div style="background:' + (isErr ? "var(--red-dim,#3a1414)" : "var(--green-dim,#14361f)")
      + ';border:1px solid ' + (isErr ? "var(--red,#c0504d)" : "var(--green,#4caf7d)")
      + ';border-radius:var(--radius-md);padding:0.7rem 1rem;color:var(--text-primary);margin-bottom:1rem;font-size:0.9rem;">' + esc(text) + '</div>';
    if (!isErr) setTimeout(function () { if (g) g.innerHTML = ""; }, 3500);
  }

  function statusOf(n, today) {
    if (n.active === false) return { label: "Off", color: "var(--text-muted)" };
    if (n.from_date && today < n.from_date) return { label: "Scheduled", color: "#C4956A" };
    if (n.to_date && today > n.to_date) return { label: "Expired", color: "var(--text-muted)" };
    return { label: "Live now", color: "#4caf7d" };
  }

  function render(notices) {
    var list = document.getElementById("ntList");
    if (!list) return;
    var today = chicagoToday();
    if (!notices || !notices.length) {
      list.innerHTML = '<div style="background:var(--bg-card);border:1px dashed var(--border-medium);border-radius:var(--radius-md);padding:1.4rem;text-align:center;color:var(--text-muted);">No notices yet. Add one above and it goes live on the site.</div>';
      return;
    }
    var rows = notices.map(function (n) {
      var st = statusOf(n, today);
      var range = "";
      if (n.from_date || n.to_date) {
        range = (n.from_date ? niceDate(n.from_date) : "now") + " – " + (n.to_date ? niceDate(n.to_date) : "ongoing");
      } else { range = "Always"; }
      return '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1rem 1.2rem;box-shadow:var(--shadow-sm);display:flex;flex-wrap:wrap;gap:12px;align-items:center;">'
        + '<div style="flex:1 1 320px;min-width:220px;">'
        +   (n.day_label ? '<span style="font-size:0.6rem;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#C4956A;margin-right:0.6rem;">' + esc(n.day_label) + '</span>' : '')
        +   '<span style="color:var(--text-primary);font-size:0.95rem;">' + bodyHtml(n.message) + '</span>'
        +   '<div style="margin-top:0.35rem;font-size:0.72rem;color:var(--text-muted);">' + esc(range) + '</div>'
        + '</div>'
        + '<span style="font-size:0.66rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:' + st.color + ';flex:0 0 auto;">● ' + st.label + '</span>'
        + '<div style="display:flex;gap:6px;flex:0 0 auto;">'
        +   '<button class="nav-btn nt-edit" data-id="' + n.id + '">Edit</button>'
        +   '<button class="nav-btn nt-toggle" data-id="' + n.id + '">' + (n.active === false ? "Turn on" : "Turn off") + '</button>'
        +   '<button class="nav-btn nt-del" data-id="' + n.id + '" style="color:var(--red,#c0504d);">Delete</button>'
        + '</div>'
        + '</div>';
    }).join('<div style="height:10px;"></div>');
    list.innerHTML = rows;

    var byId = {};
    notices.forEach(function (n) { byId[n.id] = n; });
    list.querySelectorAll(".nt-edit").forEach(function (b) {
      b.addEventListener("click", function () { fillForm(byId[b.getAttribute("data-id")]); });
    });
    list.querySelectorAll(".nt-toggle").forEach(function (b) {
      b.addEventListener("click", function () { toggleActive(byId[b.getAttribute("data-id")]); });
    });
    list.querySelectorAll(".nt-del").forEach(function (b) {
      b.addEventListener("click", function () { del(Number(b.getAttribute("data-id"))); });
    });
  }

  function load() {
    var gate = document.getElementById("ntGate");
    var formWrap = document.getElementById("ntFormWrap");
    var list = document.getElementById("ntList");
    if (!list) return;
    if (!secret()) {
      if (gate) gate.innerHTML = '<div style="background:var(--yellow-dim,#3a2f14);border:1px solid var(--border-medium);border-radius:var(--radius-md);padding:1rem;color:var(--text-secondary);margin-bottom:1rem;">Enter the admin password on the dashboard first — this panel uses the same login.</div>';
      if (formWrap) formWrap.innerHTML = "";
      list.innerHTML = "";
      return;
    }
    if (formWrap && !formWrap.innerHTML) {
      formWrap.innerHTML = formHtml();
      formWrap.querySelector("#ntSave").addEventListener("click", save);
      formWrap.querySelector("#ntClear").addEventListener("click", resetForm);
      formWrap.querySelector("#ntMsg").addEventListener("input", renderPreview);
      formWrap.querySelector("#ntLabel").addEventListener("input", renderPreview);
    }
    list.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
    call("list").then(function (res) {
      if (!res || !res.ok) {
        list.innerHTML = '<div style="background:var(--red-dim,#3a1414);border:1px solid var(--red,#c0504d);border-radius:var(--radius-md);padding:1rem;color:var(--red,#c0504d);">Could not load notices: ' + esc(res && res.error) + '</div>';
        return;
      }
      render(res.notices);
    }).catch(function (e) {
      list.innerHTML = '<div style="background:var(--red-dim,#3a1414);border:1px solid var(--red,#c0504d);border-radius:var(--radius-md);padding:1rem;color:var(--red,#c0504d);">Network error: ' + esc(e.message) + '</div>';
    });
  }

  function boot() {
    inject();
    // The shell's form/list live inside #noticesTab; wire the buttons that exist now.
    var fw = document.getElementById("ntFormWrap");
    if (fw && !fw.innerHTML) { /* form is injected lazily on load() once authed */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
