/* =========================================================================
   Shift Checklists — admin panel
   Self-injects a "Checklists" tab into /admin so managers can add, edit,
   reorder and retire checklist tasks for each position without a code
   change. Writes straight to the checklist_tasks table in Supabase with
   the publishable key — the same table the iPads read — so a change here
   shows up on the floor within a minute (the boards re-poll every 60s).

   Companion: quarry-checklist.netlify.app (the iPad boards).
   Docs: CHECKLIST-SYSTEM.md
   ========================================================================== */
(function () {
  "use strict";

  var SB_URL = "https://nkulhtalltbieicvmmad.supabase.co";
  var SB_KEY = "sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl";

  var ROLES = [
    { id: "bartender", label: "Bar" },
    { id: "server",    label: "Servers" },
    { id: "support",   label: "Host & Bus" },
    { id: "kitchen",   label: "Kitchen" },
    { id: "staff",     label: "Staff Board" }
  ];
  var SEGMENTS = [
    { id: "open",  label: "Opening" },
    { id: "shift", label: "During Shift" },
    { id: "close", label: "Closing" }
  ];
  /* Friendly cadence names -> interval_days. This is the whole scheduling
     engine: "how many days before it comes due again". */
  var CADENCES = [
    { days: 1,  cadence: "daily",     label: "Every open day" },
    { days: 3,  cadence: "weekly",    label: "Twice a week" },
    { days: 7,  cadence: "weekly",    label: "Once a week" },
    { days: 10, cadence: "interval",  label: "3x per month" },
    { days: 14, cadence: "biweekly",  label: "Every 2 weeks" },
    { days: 30, cadence: "monthly",   label: "Once a month" },
    { days: 60, cadence: "monthly",   label: "Every 2 months" },
    { days: 90, cadence: "quarterly", label: "Every 3 months" }
  ];
  var DAYS = [
    { n: 3, label: "Wed" }, { n: 4, label: "Thu" }, { n: 5, label: "Fri" },
    { n: 6, label: "Sat" }, { n: 0, label: "Sun" }
  ];
  var OPEN_DAYS = [0, 3, 4, 5, 6];

  var TASKS = [], DUE = {}, role = "bartender", editId = null;

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function headers() {
    return { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" };
  }
  function api(path, opts) {
    return fetch(SB_URL + "/rest/v1/" + path, Object.assign({ headers: headers() }, opts || {}))
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); });
        return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
      });
  }
  function cadenceLabel(days) {
    for (var i = 0; i < CADENCES.length; i++) if (CADENCES[i].days === days) return CADENCES[i].label;
    return "Every " + days + " days";
  }
  function cadenceKey(days) {
    for (var i = 0; i < CADENCES.length; i++) if (CADENCES[i].days === days) return CADENCES[i].cadence;
    return days <= 1 ? "daily" : days <= 7 ? "weekly" : days <= 14 ? "biweekly"
         : days <= 31 ? "monthly" : "quarterly";
  }
  function daysLabel(arr) {
    if (!arr || !arr.length) return "Any open day";
    var sorted = arr.slice().sort();
    if (sorted.length === OPEN_DAYS.length) return "Any open day";
    return DAYS.filter(function (d) { return arr.indexOf(d.n) > -1; })
               .map(function (d) { return d.label; }).join(", ") + " only";
  }
  function roleLabel(id) {
    for (var i = 0; i < ROLES.length; i++) if (ROLES[i].id === id) return ROLES[i].label;
    return id;
  }

  /* ---------------- inject tab ---------------- */
  function styles() {
    if (document.getElementById("ckStyles")) return;
    var st = document.createElement("style");
    st.id = "ckStyles";
    st.textContent = [
      '#checklistsTab, #checklistsTab * { box-sizing:border-box; }',
      '#checklistsTab { max-width:100%; overflow-x:hidden; }',
      /* .nav-btn in this admin is a fixed 36x36 icon button — we need real
         text buttons, so scope our own and never inherit that width/height. */
      '#checklistsTab .ck-btn {',
      '  background:var(--bg-card,#fff); color:var(--text-primary,#1c1f26);',
      '  border:1px solid var(--border-medium,#cdd1d8); border-radius:var(--radius-sm,6px);',
      '  width:auto; height:auto; padding:0.5rem 0.85rem; font-size:0.85rem;',
      '  font-weight:600; font-family:inherit; line-height:1.2; cursor:pointer;',
      '  white-space:nowrap; display:inline-flex; align-items:center; gap:6px;',
      '}',
      '#checklistsTab .ck-btn:hover { border-color:var(--gold,#B8933A); color:var(--gold,#B8933A); }',
      '#checklistsTab .ck-btn[style*="background"]:hover { color:#1a1a1a; }',
      '#checklistsTab input, #checklistsTab select { max-width:100%; }',
      '#checklistsTab label { min-width:0; }'
    ].join("\n");
    document.head.appendChild(st);
  }

  function inject() {
    if (document.getElementById("checklistsTab")) return;
    styles();

    var nav = document.createElement("div");
    nav.className = "sb-nav-item";
    nav.setAttribute("data-tab", "checklists");
    nav.innerHTML = '<span class="sb-ic">✅</span><span class="sb-lbl">Checklists</span>';
    var anchor = document.querySelector('.sb-nav-item[data-tab="notices"]') ||
                 document.querySelector('.sb-nav-item[data-tab="golfProgressive"]');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(nav, anchor.nextSibling);
    else {
      var anyNav = document.querySelector(".sb-nav-item");
      if (anyNav && anyNav.parentNode) anyNav.parentNode.appendChild(nav);
    }
    nav.addEventListener("click", function () {
      if (typeof window.switchTab === "function") window.switchTab("checklists");
      load();
    });

    var panel = document.createElement("div");
    panel.id = "checklistsTab";
    panel.className = "tab-content";
    panel.innerHTML = shell();
    var anyTab = document.querySelector(".tab-content");
    if (anyTab && anyTab.parentNode) anyTab.parentNode.appendChild(panel);
    else document.body.appendChild(panel);

    panel.querySelector("#ckRefresh").addEventListener("click", load);
    panel.querySelector("#ckRoles").addEventListener("click", function (e) {
      var b = e.target.closest(".ck-role");
      if (!b) return;
      role = b.getAttribute("data-role");
      editId = null;
      renderRoles(); renderForm(); renderList();
    });
  }

  function shell() {
    return ''
      + '<div style="max-width:1100px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:0.5rem;">'
      +   '<h1 style="font-family:var(--font-serif);font-size:1.6rem;color:var(--text-primary);margin:0;">Shift Checklists</h1>'
      +   '<button id="ckRefresh" class="ck-btn">Refresh</button>'
      + '</div>'
      + '<p style="color:var(--text-muted);margin:0 0 1.25rem;font-size:0.9rem;line-height:1.5;">'
      +   'Anything added here shows up on the iPad for that position within a minute. '
      +   'The <b>Staff Board</b> is the shared list every position can see — put grounds and property work there. '
      +   'Cadence is the whole engine: pick how often it should come back and the board handles the rest.'
      + '</p>'
      + '<div id="ckGate"></div>'
      + '<div id="ckRoles" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:1.25rem;"></div>'
      + '<div id="ckForm"></div>'
      + '<div id="ckList"><p style="color:var(--text-muted);">Loading…</p></div>'
      + '</div>';
  }

  function renderRoles() {
    var el = document.getElementById("ckRoles");
    if (!el) return;
    el.innerHTML = ROLES.map(function (r) {
      var n = TASKS.filter(function (t) { return t.role === r.id && t.active; }).length;
      var on = r.id === role;
      return '<button class="ck-btn ck-role" data-role="' + r.id + '" style="'
        + (on ? 'background:var(--accent,#B8933A);color:#1a1a1a;font-weight:600;' : '')
        + '">' + esc(r.label) + ' <span style="opacity:0.7;">(' + n + ')</span></button>';
    }).join("");
  }

  /* ---------------- add / edit form ---------------- */
  function field(label, inner, flex) {
    return '<label style="flex:' + (flex || "1 1 200px") + ';min-width:150px;">'
      + '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.3rem;">' + label + '</span>'
      + inner + '</label>';
  }
  var INPUT = 'width:100%;box-sizing:border-box;padding:0.55rem 0.7rem;background:var(--bg-card,#fff);'
            + 'border:1px solid var(--border-medium,#cdd1d8);border-radius:var(--radius-sm,6px);'
            + 'color:var(--text-primary,#1c1f26);font-size:0.9rem;font-family:inherit;';

  function renderForm() {
    var wrap = document.getElementById("ckForm");
    if (!wrap) return;
    var t = editId ? TASKS.filter(function (x) { return x.id === editId; })[0] : null;
    var days = t && t.days_of_week ? t.days_of_week : OPEN_DAYS;

    wrap.innerHTML = ''
      + '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:1.25rem 1.4rem;box-shadow:var(--shadow-sm);margin-bottom:1.5rem;">'
      + '<div style="font-size:0.72rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-muted);margin-bottom:1rem;">'
      +   (t ? "Editing task — " + esc(roleLabel(role)) : "Add a task to " + esc(roleLabel(role))) + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1rem;">'
      +   field("What needs doing", '<input id="ckTitle" type="text" maxlength="120" placeholder="Clean the beer coolers" style="' + INPUT + '" value="' + esc(t ? t.title : "") + '">', "2 1 320px")
      +   field("Area <span style=\'color:var(--text-muted);\'>(optional)</span>", '<input id="ckArea" type="text" maxlength="40" placeholder="Lower Patio" style="' + INPUT + '" value="' + esc(t && t.area ? t.area : "") + '">', "1 1 170px")
      + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1rem;margin-top:1rem;">'
      +   field("How it should be done <span style=\'color:var(--text-muted);\'>(shows under the task on the iPad)</span>",
              '<input id="ckDetail" type="text" maxlength="300" placeholder="Pull everything out, wash the interior, wipe the gaskets." style="' + INPUT + '" value="' + esc(t && t.detail ? t.detail : "") + '">', "1 1 100%")
      + '</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:1rem;margin-top:1rem;">'
      +   field("When in the shift", '<select id="ckSeg" style="' + INPUT + '">'
              + SEGMENTS.map(function (s) {
                  return '<option value="' + s.id + '"' + (t && t.segment === s.id ? " selected" : "") + '>' + s.label + '</option>';
                }).join("") + '</select>', "1 1 180px")
      +   field("How often", '<select id="ckCad" style="' + INPUT + '">'
              + CADENCES.map(function (c) {
                  return '<option value="' + c.days + '"' + (t && t.interval_days === c.days ? " selected" : "") + '>' + c.label + '</option>';
                }).join("") + '</select>', "1 1 180px")
      +   field("Roughly how long", '<input id="ckMins" type="number" min="1" max="600" placeholder="minutes" style="' + INPUT + '" value="' + (t && t.est_minutes ? t.est_minutes : "") + '">', "0 1 150px")
      + '</div>'
      + '<div style="margin-top:1rem;">'
      +   '<span style="display:block;font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.45rem;">Which days can it be done? <span style="color:var(--text-muted);">leave all on unless it must land on one day</span></span>'
      +   '<div id="ckDays" style="display:flex;gap:8px;flex-wrap:wrap;">'
      +     DAYS.map(function (d) {
              var on = days.indexOf(d.n) > -1;
              return '<button type="button" class="ck-btn ck-day" data-d="' + d.n + '" data-on="' + (on ? 1 : 0) + '" style="'
                + (on ? 'background:var(--accent,#B8933A);color:#1a1a1a;font-weight:600;' : '') + '">' + d.label + '</button>';
            }).join("")
      +   '</div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:0.5rem;margin-top:1rem;color:var(--text-secondary);font-size:0.9rem;cursor:pointer;">'
      +   '<input id="ckBig" type="checkbox"' + (t && t.is_big_job ? " checked" : "") + ' style="width:16px;height:16px;"> '
      +   'Big job — show it in the staffing forecast so it can be scheduled'
      + '</label>'
      + '<div style="display:flex;gap:10px;margin-top:1.2rem;">'
      +   '<button id="ckSave" class="ck-btn" style="background:var(--accent,#B8933A);color:#1a1a1a;font-weight:600;">'
      +     (t ? "Save changes" : "Add task") + '</button>'
      +   '<button id="ckCancel" class="ck-btn">' + (t ? "Cancel" : "Clear") + '</button>'
      + '</div>'
      + '</div>';

    wrap.querySelector("#ckDays").addEventListener("click", function (e) {
      var b = e.target.closest(".ck-day");
      if (!b) return;
      var on = b.getAttribute("data-on") === "1";
      b.setAttribute("data-on", on ? "0" : "1");
      b.style.cssText = on ? "" : "background:var(--accent,#B8933A);color:#1a1a1a;font-weight:600;";
    });
    wrap.querySelector("#ckSave").addEventListener("click", save);
    wrap.querySelector("#ckCancel").addEventListener("click", function () {
      editId = null; renderForm();
    });
  }

  function save() {
    var btn = document.getElementById("ckSave");
    var title = document.getElementById("ckTitle").value.trim();
    if (!title) { flash("Give the task a name first.", true); return; }

    var picked = [];
    document.querySelectorAll("#ckDays .ck-day").forEach(function (b) {
      if (b.getAttribute("data-on") === "1") picked.push(Number(b.getAttribute("data-d")));
    });
    if (!picked.length) { flash("Pick at least one day it can be done.", true); return; }

    var days = Number(document.getElementById("ckCad").value);
    var mins = parseInt(document.getElementById("ckMins").value, 10);
    var body = {
      role: role,
      title: title,
      detail: document.getElementById("ckDetail").value.trim() || null,
      segment: document.getElementById("ckSeg").value,
      interval_days: days,
      cadence: cadenceKey(days),
      days_of_week: picked,
      area: document.getElementById("ckArea").value.trim() || null,
      est_minutes: isNaN(mins) ? null : mins,
      is_big_job: document.getElementById("ckBig").checked,
      active: true
    };

    btn.disabled = true;
    btn.textContent = "Saving…";

    var req = editId
      ? api("checklist_tasks?id=eq." + editId, { method: "PATCH", body: JSON.stringify(body) })
      : api("checklist_tasks", { method: "POST", body: JSON.stringify(body) });

    req.then(function () {
      editId = null;
      flash(body.title + " saved. It will show on the iPad within a minute.", false);
      load();
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = editId ? "Save changes" : "Add task";
      flash("Could not save: " + e.message, true);
    });
  }

  /* ---------------- list ---------------- */
  function renderList() {
    var el = document.getElementById("ckList");
    if (!el) return;
    var mine = TASKS.filter(function (t) { return t.role === role; });
    if (!mine.length) {
      el.innerHTML = '<div style="background:var(--bg-card);border:1px dashed var(--border-medium);border-radius:var(--radius-md);padding:1.4rem;text-align:center;color:var(--text-muted);">Nothing on this board yet. Add the first task above.</div>';
      return;
    }
    var html = "";
    SEGMENTS.forEach(function (seg) {
      var items = mine.filter(function (t) { return t.segment === seg.id; })
                      .sort(function (a, b) { return (a.sort_order - b.sort_order) || a.title.localeCompare(b.title); });
      if (!items.length) return;
      html += '<div style="font-size:0.72rem;letter-spacing:0.14em;text-transform:uppercase;color:var(--accent,#B8933A);margin:1.4rem 0 0.7rem;font-weight:600;">' + seg.label + '</div>';
      html += items.map(row).join('<div style="height:8px;"></div>');
    });
    el.innerHTML = html;

    el.querySelectorAll(".ck-edit").forEach(function (b) {
      b.addEventListener("click", function () {
        editId = b.getAttribute("data-id");
        renderForm();
        var p = document.getElementById("checklistsTab");
        if (p && p.scrollIntoView) p.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    el.querySelectorAll(".ck-toggle").forEach(function (b) {
      b.addEventListener("click", function () { toggle(b.getAttribute("data-id")); });
    });
    el.querySelectorAll(".ck-up,.ck-down").forEach(function (b) {
      b.addEventListener("click", function () {
        move(b.getAttribute("data-id"), b.classList.contains("ck-up") ? -1 : 1);
      });
    });
  }

  function row(t) {
    var d = DUE[t.id] || {};
    var off = !t.active;
    var when = "";
    if (d.status === "done") when = '<span style="color:#4caf7d;">Signed off today' + (d.done_by ? " by " + esc(d.done_by) : "") + '</span>';
    else if (d.status === "overdue") when = '<span style="color:#c0504d;">Overdue — missed ' + d.missed_days + ' shift' + (d.missed_days === 1 ? "" : "s") + '</span>';
    else if (d.status === "due") when = '<span style="color:var(--accent,#B8933A);">Due today</span>';
    else if (d.days_until_due != null && d.days_until_due < 999) when = '<span style="color:var(--text-muted);">Due in ' + d.days_until_due + ' day' + (d.days_until_due === 1 ? "" : "s") + '</span>';

    return '<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:0.95rem 1.2rem;box-shadow:var(--shadow-sm);display:flex;flex-wrap:wrap;gap:12px;align-items:center;' + (off ? "opacity:0.5;" : "") + '">'
      + '<div style="flex:1 1 340px;min-width:240px;">'
      +   '<div style="color:var(--text-primary);font-size:0.95rem;font-weight:500;">' + esc(t.title) + (off ? ' <span style="color:var(--text-muted);font-size:0.75rem;">(off)</span>' : '') + '</div>'
      +   (t.detail ? '<div style="color:var(--text-muted);font-size:0.8rem;margin-top:0.25rem;line-height:1.45;">' + esc(t.detail) + '</div>' : '')
      +   '<div style="margin-top:0.45rem;font-size:0.72rem;color:var(--text-secondary);display:flex;flex-wrap:wrap;gap:10px;">'
      +     '<span>' + esc(cadenceLabel(t.interval_days)) + '</span>'
      +     '<span style="color:var(--text-muted);">' + esc(daysLabel(t.days_of_week)) + '</span>'
      +     (t.area ? '<span style="color:var(--text-muted);">' + esc(t.area) + '</span>' : '')
      +     (t.est_minutes ? '<span style="color:var(--text-muted);">~' + t.est_minutes + ' min</span>' : '')
      +     (t.is_big_job ? '<span style="color:#C4956A;">Big job</span>' : '')
      +   '</div>'
      +   (when ? '<div style="margin-top:0.35rem;font-size:0.72rem;">' + when + '</div>' : '')
      + '</div>'
      + '<div style="display:flex;gap:6px;flex:0 0 auto;">'
      +   '<button class="ck-btn ck-up" data-id="' + t.id + '" title="Move up" style="padding:5px 9px;">↑</button>'
      +   '<button class="ck-btn ck-down" data-id="' + t.id + '" title="Move down" style="padding:5px 9px;">↓</button>'
      +   '<button class="ck-btn ck-edit" data-id="' + t.id + '">Edit</button>'
      +   '<button class="ck-btn ck-toggle" data-id="' + t.id + '"' + (off ? '' : ' style="color:var(--red,#c0504d);"') + '>'
      +     (off ? "Turn on" : "Turn off") + '</button>'
      + '</div>'
      + '</div>';
  }

  function toggle(id) {
    var t = TASKS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    api("checklist_tasks?id=eq." + id, { method: "PATCH", body: JSON.stringify({ active: !t.active }) })
      .then(function () {
        flash(t.active ? "Turned off — it will drop off the iPad." : "Back on the board.", false);
        load();
      })
      .catch(function (e) { flash("Could not update: " + e.message, true); });
  }

  /* Reorder within a segment by swapping sort_order with the neighbour. */
  function move(id, dir) {
    var t = TASKS.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var peers = TASKS.filter(function (x) { return x.role === t.role && x.segment === t.segment; })
                     .sort(function (a, b) { return (a.sort_order - b.sort_order) || a.title.localeCompare(b.title); });
    var i = peers.findIndex(function (x) { return x.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= peers.length) return;
    var other = peers[j];
    var a = t.sort_order, b = other.sort_order;
    if (a === b) { b = a + dir; }
    Promise.all([
      api("checklist_tasks?id=eq." + t.id,     { method: "PATCH", body: JSON.stringify({ sort_order: b }) }),
      api("checklist_tasks?id=eq." + other.id, { method: "PATCH", body: JSON.stringify({ sort_order: a }) })
    ]).then(load).catch(function (e) { flash("Could not reorder: " + e.message, true); });
  }

  function flash(text, isErr) {
    var g = document.getElementById("ckGate");
    if (!g) return;
    g.innerHTML = '<div style="background:' + (isErr ? "var(--red-dim,#3a1414)" : "var(--green-dim,#14361f)")
      + ';border:1px solid ' + (isErr ? "var(--red,#c0504d)" : "var(--green,#4caf7d)")
      + ';border-radius:var(--radius-md);padding:0.7rem 1rem;color:var(--text-primary);margin-bottom:1rem;font-size:0.9rem;">' + esc(text) + '</div>';
    if (!isErr) setTimeout(function () { if (g) g.innerHTML = ""; }, 3500);
  }

  /* ---------------- load ---------------- */
  function load() {
    var list = document.getElementById("ckList");
    if (!list) return;
    list.innerHTML = '<p style="color:var(--text-muted);">Loading…</p>';
    Promise.all([
      api("checklist_tasks?select=*&order=role,segment,sort_order"),
      api("rpc/checklist_due", { method: "POST", body: JSON.stringify({ p_date: null }) })
    ]).then(function (res) {
      TASKS = res[0] || [];
      DUE = {};
      (res[1] || []).forEach(function (d) { DUE[d.task_id] = d; });
      renderRoles();
      renderForm();
      renderList();
    }).catch(function (e) {
      list.innerHTML = '<div style="background:var(--red-dim,#3a1414);border:1px solid var(--red,#c0504d);border-radius:var(--radius-md);padding:1rem;color:var(--red,#c0504d);">Could not load checklists: ' + esc(e.message) + '</div>';
    });
  }

  function boot() { inject(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
