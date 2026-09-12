/* =========================================================================
   Shift Checklists — admin panel
   Injects a "Checklists" tab into /admin. Four views:
     Tasks   — per-position task library: add, edit, reorder, retire
     Today   — live status of every board, plus the big-job staffing forecast
     Archive — any past date, exactly as the boards stood that night
     Staff   — roster, so initials are tap-to-pick on the iPads
   Writes straight to Supabase, same tables the iPads read. Changes reach
   the floor within a minute (boards re-poll every 60s).
   Docs: CHECKLIST-SYSTEM.md
   ========================================================================== */
(function () {
  "use strict";

  var SB  = "https://nkulhtalltbieicvmmad.supabase.co";
  var KEY = "sb_publishable_FQK59Bn8P2jV8yGL0nPi7w_jVHFMBSl";

  var ROLES = [
    { id: "bartender", label: "Bar" },
    { id: "server",    label: "Servers" },
    { id: "support",   label: "Host & Bus" },
    { id: "kitchen",   label: "Kitchen" },
    { id: "staff",     label: "Staff Board" }
  ];
  var SEGS = [["open","Opening"],["shift","During Shift"],["close","Closing"]];
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
  var DAYS = [[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]];
  var OPEN_DAYS = [0,3,4,5,6];

  var TASKS = [], DUE = [], STAFF = [];
  var view = "tasks", role = "bartender", editId = null, archiveDate = null;

  /* ------------------------------------------------ helpers */
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                        .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function h(){ return { apikey:KEY, Authorization:"Bearer "+KEY, "Content-Type":"application/json" }; }
  function api(path, opts){
    return fetch(SB + "/rest/v1/" + path, Object.assign({ headers:h() }, opts||{}))
      .then(function(r){
        if(!r.ok) return r.text().then(function(t){ throw new Error(t || r.status); });
        return r.text().then(function(t){ return t ? JSON.parse(t) : null; });
      });
  }
  function today(){ return new Date().toLocaleDateString("en-CA",{ timeZone:"America/Chicago" }); }
  function niceDate(d){
    try { return new Date(d+"T12:00:00").toLocaleDateString("en-US",
      { weekday:"long", month:"long", day:"numeric" }); } catch(e){ return d; }
  }
  function hourName(x){ return (x%12===0?12:x%12) + (x<12?"am":"pm"); }
  function cadenceLabel(t){
    if (t.recurrence === "hourly") return "Every hour, " + hourName(t.hour_start) + "–" + hourName(t.hour_end);
    for (var i=0;i<CADENCES.length;i++) if (CADENCES[i].days === t.interval_days) return CADENCES[i].label;
    return "Every " + t.interval_days + " days";
  }
  function cadenceKey(days){
    for (var i=0;i<CADENCES.length;i++) if (CADENCES[i].days===days) return CADENCES[i].cadence;
    return days<=1?"daily":days<=7?"weekly":days<=14?"biweekly":days<=31?"monthly":"quarterly";
  }
  function daysLabel(a){
    if (!a || a.length >= OPEN_DAYS.length) return "Any open day";
    return DAYS.filter(function(d){ return a.indexOf(d[0])>-1; })
               .map(function(d){ return d[1]; }).join(", ") + " only";
  }
  function roleLabel(r){ for(var i=0;i<ROLES.length;i++) if(ROLES[i].id===r) return ROLES[i].label; return r; }
  function dueOf(id){ for(var i=0;i<DUE.length;i++) if(DUE[i].task_id===id) return DUE[i]; return {}; }

  /* ------------------------------------------------ styles */
  function styles(){
    if (document.getElementById("ckStyles")) return;
    var st = document.createElement("style");
    st.id = "ckStyles";
    st.textContent = [
      '#checklistsTab,#checklistsTab *{box-sizing:border-box}',
      '#checklistsTab{max-width:100%;overflow-x:hidden}',
      '#checklistsTab .ck-wrap{max-width:1080px}',
      /* .nav-btn here is a fixed 36x36 icon button — never inherit it */
      '#checklistsTab .ck-btn{background:var(--bg-card,#fff);color:var(--text-primary,#1c1f26);',
      ' border:1px solid var(--border-medium,#cdd1d8);border-radius:8px;width:auto;height:auto;',
      ' padding:.5rem .85rem;font:600 .82rem/1.2 inherit;cursor:pointer;white-space:nowrap;',
      ' display:inline-flex;align-items:center;gap:6px;transition:all .12s}',
      '#checklistsTab .ck-btn:hover{border-color:#B8933A;color:#B8933A}',
      '#checklistsTab .ck-btn.on{background:#B8933A;border-color:#B8933A;color:#1a1a1a}',
      '#checklistsTab .ck-btn.on:hover{color:#1a1a1a}',
      '#checklistsTab .ck-btn.sm{padding:.35rem .55rem;font-size:.75rem}',
      '#checklistsTab .ck-btn.danger:hover{border-color:#c0504d;color:#c0504d}',
      '#checklistsTab .ck-in{width:100%;padding:.55rem .7rem;background:var(--bg-card,#fff);',
      ' border:1px solid var(--border-medium,#cdd1d8);border-radius:8px;',
      ' color:var(--text-primary,#1c1f26);font:.9rem inherit}',
      '#checklistsTab .ck-in:focus{outline:none;border-color:#B8933A}',
      '#checklistsTab .ck-lbl{display:block;font-size:.72rem;color:var(--text-secondary,#5b6270);margin-bottom:.3rem}',
      '#checklistsTab .ck-card{background:var(--bg-card,#fff);border:1px solid var(--border-subtle,#e6e8ec);',
      ' border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:.55rem}',
      '#checklistsTab .ck-row{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}',
      '#checklistsTab .ck-h{font:700 .7rem/1 inherit;letter-spacing:.16em;text-transform:uppercase;',
      ' color:#B8933A;margin:1.6rem 0 .7rem}',
      '#checklistsTab .ck-meta{font-size:.72rem;color:var(--text-secondary,#5b6270);margin-top:.4rem}',
      '#checklistsTab .ck-off{opacity:.45}',
      '#checklistsTab .ck-tag{font-size:.68rem;font-weight:700;padding:.15rem .45rem;border-radius:5px;margin-left:.4rem}',
      '#checklistsTab .ck-due{background:#fdf3dd;color:#8a6d1f}',
      '#checklistsTab .ck-late{background:#fbe4e2;color:#a33b34}',
      '#checklistsTab .ck-ok{background:#e3f5e6;color:#2b6b33}',
      '#checklistsTab table{width:100%;border-collapse:collapse;font-size:.85rem}',
      '#checklistsTab th{text-align:left;font:700 .66rem/1 inherit;letter-spacing:.11em;',
      ' text-transform:uppercase;color:var(--text-secondary,#5b6270);padding:.5rem .6rem .5rem 0}',
      '#checklistsTab td{padding:.6rem .6rem .6rem 0;border-top:1px solid var(--border-subtle,#e6e8ec);vertical-align:top}',
      '#checklistsTab td.n{text-align:right;white-space:nowrap;font-weight:600}',
      '#checklistsTab .ck-hr{display:inline-block;min-width:30px;text-align:center;padding:.2rem 0;',
      ' margin:0 2px 3px 0;border-radius:5px;font-size:.66rem;font-weight:700;background:#eef0f3;color:#9aa1ad}',
      '#checklistsTab .ck-hr.ok{background:#cfead4;color:#2b6b33}',
      '#checklistsTab .ck-hr.miss{background:#f6d5d2;color:#a33b34}'
    ].join("\n");
    document.head.appendChild(st);
  }

  /* ------------------------------------------------ inject */
  function inject(){
    if (document.getElementById("checklistsTab")) return;
    styles();
    var nav = document.createElement("div");
    nav.className = "sb-nav-item";
    nav.setAttribute("data-tab","checklists");
    nav.innerHTML = '<span class="sb-ic">✅</span><span class="sb-lbl">Checklists</span>';
    var a = document.querySelector('.sb-nav-item[data-tab="notices"]') ||
            document.querySelector('.sb-nav-item[data-tab="golfProgressive"]') ||
            document.querySelector('.sb-nav-item');
    if (a && a.parentNode) a.parentNode.insertBefore(nav, a.nextSibling);
    nav.addEventListener("click", function(){
      if (typeof window.switchTab === "function") window.switchTab("checklists");
      load();
    });

    var p = document.createElement("div");
    p.id = "checklistsTab"; p.className = "tab-content";
    p.innerHTML = '<div class="ck-wrap">'
      + '<h1 style="font-family:var(--font-serif);font-size:1.55rem;margin:0 0 .3rem;">Shift Checklists</h1>'
      + '<p style="color:var(--text-secondary,#5b6270);font-size:.86rem;margin:0 0 1.1rem;max-width:640px;">'
      +   'Changes here reach the iPads within a minute. The Staff Board is the shared list every position sees.</p>'
      + '<div id="ckViews" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:1.3rem;"></div>'
      + '<div id="ckMsg"></div><div id="ckBody"></div></div>';
    var any = document.querySelector(".tab-content");
    if (any && any.parentNode) any.parentNode.appendChild(p); else document.body.appendChild(p);

    p.addEventListener("click", onClick);
    p.addEventListener("change", onChange);
  }

  /* ------------------------------------------------ chrome */
  function renderViews(){
    var v = [["tasks","Tasks"],["day","Today"],["archive","Archive"],["staff","Staff"]];
    document.getElementById("ckViews").innerHTML = v.map(function(x){
      return '<button class="ck-btn ck-view'+(view===x[0]?" on":"")+'" data-view="'+x[0]+'">'+x[1]+'</button>';
    }).join("") + '<span style="flex:1"></span><button class="ck-btn" id="ckRefresh">Refresh</button>';
  }
  function msg(text, err){
    var m = document.getElementById("ckMsg");
    if (!m) return;
    m.innerHTML = '<div style="background:'+(err?"#fbe4e2":"#e3f5e6")+';border:1px solid '
      +(err?"#e0a8a2":"#a8d7b0")+';border-radius:10px;padding:.7rem 1rem;margin-bottom:1rem;'
      +'font-size:.86rem;color:'+(err?"#a33b34":"#2b6b33")+';">'+esc(text)+'</div>';
    if (!err) setTimeout(function(){ if(m) m.innerHTML=""; }, 3500);
  }

  /* ------------------------------------------------ TASKS view */
  function renderTasks(){
    var mine = TASKS.filter(function(t){ return t.role===role; });
    var body = document.getElementById("ckBody");

    var chips = ROLES.map(function(r){
      var n = TASKS.filter(function(t){ return t.role===r.id && t.active; }).length;
      return '<button class="ck-btn ck-role'+(r.id===role?" on":"")+'" data-role="'+r.id+'">'
           + esc(r.label) + ' <span style="opacity:.65;font-weight:500">'+n+'</span></button>';
    }).join("");

    var t = editId ? mine.filter(function(x){ return x.id===editId; })[0] : null;
    var days = t && t.days_of_week ? t.days_of_week : OPEN_DAYS;
    var hourly = t ? t.recurrence==="hourly" : false;

    var form = '<div class="ck-card" style="padding:1.3rem 1.4rem;margin-bottom:1.6rem;">'
      + '<div style="font:700 .7rem/1 inherit;letter-spacing:.14em;text-transform:uppercase;color:var(--text-secondary,#5b6270);margin-bottom:1rem;">'
      +   (t ? "Editing — " + esc(roleLabel(role)) : "Add a task to " + esc(roleLabel(role))) + '</div>'
      + '<div class="ck-row">'
      +   '<label style="flex:2 1 300px"><span class="ck-lbl">What needs doing</span>'
      +     '<input id="ckTitle" class="ck-in" maxlength="120" placeholder="Clean the beer coolers" value="'+esc(t?t.title:"")+'"></label>'
      +   '<label style="flex:1 1 160px"><span class="ck-lbl">Area <span style="opacity:.6">optional</span></span>'
      +     '<input id="ckArea" class="ck-in" maxlength="40" placeholder="Lower Patio" value="'+esc(t&&t.area?t.area:"")+'"></label>'
      + '</div>'
      + '<div style="margin-top:.9rem"><span class="ck-lbl">How it should be done '
      +   '<span style="opacity:.6">shows under the task on the iPad</span></span>'
      +   '<input id="ckDetail" class="ck-in" maxlength="300" placeholder="Pull everything out, wash the interior, wipe the gaskets." value="'+esc(t&&t.detail?t.detail:"")+'"></div>'
      + '<div class="ck-row" style="margin-top:.9rem">'
      +   '<label style="flex:1 1 170px"><span class="ck-lbl">When in the shift</span><select id="ckSeg" class="ck-in">'
      +     SEGS.map(function(s){ return '<option value="'+s[0]+'"'+(t&&t.segment===s[0]?" selected":"")+'>'+s[1]+'</option>'; }).join("")
      +   '</select></label>'
      +   '<label style="flex:1 1 180px"><span class="ck-lbl">How often</span><select id="ckCad" class="ck-in">'
      +     CADENCES.map(function(c){ return '<option value="'+c.days+'"'+(!hourly&&t&&t.interval_days===c.days?" selected":"")+'>'+c.label+'</option>'; }).join("")
      +     '<option value="hourly"'+(hourly?" selected":"")+'>Every hour</option>'
      +   '</select></label>'
      +   '<label style="flex:0 1 140px"><span class="ck-lbl">Roughly how long</span>'
      +     '<input id="ckMins" class="ck-in" type="number" min="1" max="600" placeholder="minutes" value="'+(t&&t.est_minutes?t.est_minutes:"")+'"></label>'
      + '</div>'
      + '<div id="ckHourWrap" class="ck-row" style="margin-top:.9rem;'+(hourly?"":"display:none")+'">'
      +   '<label style="flex:0 1 150px"><span class="ck-lbl">First round at</span><select id="ckHs" class="ck-in">'+hourOpts(t?t.hour_start:11)+'</select></label>'
      +   '<label style="flex:0 1 150px"><span class="ck-lbl">Last round at</span><select id="ckHe" class="ck-in">'+hourOpts(t?t.hour_end:21)+'</select></label>'
      +   '<div style="flex:1 1 240px;font-size:.75rem;color:var(--text-secondary,#5b6270);align-self:flex-end;padding-bottom:.4rem;">'
      +     'Resets at the top of every hour. Staff get the full 60 minutes to finish it.</div>'
      + '</div>'
      + '<div style="margin-top:1rem;'+(hourly?"display:none":"")+'" id="ckDayWrap">'
      +   '<span class="ck-lbl">Which days can it be done? <span style="opacity:.6">leave all on unless it must land on one day</span></span>'
      +   '<div id="ckDays">' + DAYS.map(function(d){
             var on = days.indexOf(d[0])>-1;
             return '<button type="button" class="ck-btn ck-day'+(on?" on":"")+'" data-d="'+d[0]+'" style="margin-right:6px">'+d[1]+'</button>';
           }).join("") + '</div>'
      + '</div>'
      + '<label style="display:flex;align-items:center;gap:.55rem;margin-top:1rem;font-size:.86rem;cursor:pointer;">'
      +   '<input type="checkbox" id="ckBig"'+(t&&t.is_big_job?" checked":"")+' style="width:16px;height:16px"> '
      +   'Big job — include it in the staffing forecast</label>'
      + '<div style="display:flex;gap:8px;margin-top:1.2rem">'
      +   '<button class="ck-btn on" id="ckSave">'+(t?"Save changes":"Add task")+'</button>'
      +   '<button class="ck-btn" id="ckCancel">'+(t?"Cancel":"Clear")+'</button></div>'
      + '</div>';

    var list = "";
    SEGS.forEach(function(s){
      var items = mine.filter(function(x){ return x.segment===s[0]; })
                      .sort(function(a,b){ return (a.sort_order-b.sort_order) || a.title.localeCompare(b.title); });
      if (!items.length) return;
      list += '<div class="ck-h">'+s[1]+'</div>' + items.map(taskRow).join("");
    });
    if (!list) list = '<div class="ck-card" style="text-align:center;color:var(--text-secondary,#5b6270)">Nothing on this board yet.</div>';

    body.innerHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:1.3rem">'+chips+'</div>' + form + list;
  }
  function hourOpts(sel){
    var o = "";
    for (var i=6;i<=23;i++) o += '<option value="'+i+'"'+(i===sel?" selected":"")+'>'+hourName(i)+'</option>';
    return o;
  }
  function taskRow(t){
    var d = dueOf(t.id), off = !t.active, tag = "";
    if (!off){
      if (d.status==="done")         tag = '<span class="ck-tag ck-ok">done today</span>';
      else if (d.status==="overdue") tag = '<span class="ck-tag ck-late">overdue</span>';
      else if (d.status==="due")     tag = '<span class="ck-tag ck-due">due today</span>';
    }
    return '<div class="ck-card'+(off?" ck-off":"")+'" style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">'
      + '<div style="flex:1 1 320px;min-width:220px">'
      +   '<div style="font-weight:600;font-size:.92rem">'+esc(t.title)+tag
      +     (off?' <span style="font-size:.72rem;opacity:.7">(off)</span>':'')+'</div>'
      +   (t.detail?'<div style="font-size:.78rem;color:var(--text-secondary,#5b6270);margin-top:.25rem">'+esc(t.detail)+'</div>':'')
      +   '<div class="ck-meta">'+esc(cadenceLabel(t))
      +     (t.recurrence!=="hourly" ? ' · ' + esc(daysLabel(t.days_of_week)) : '')
      +     (t.area?' · '+esc(t.area):'') + (t.est_minutes?' · ~'+t.est_minutes+' min':'')
      +     (t.is_big_job?' · big job':'') + '</div>'
      + '</div>'
      + '<div style="display:flex;gap:5px">'
      +   '<button class="ck-btn sm ck-up" data-id="'+t.id+'">↑</button>'
      +   '<button class="ck-btn sm ck-down" data-id="'+t.id+'">↓</button>'
      +   '<button class="ck-btn sm ck-edit" data-id="'+t.id+'">Edit</button>'
      +   '<button class="ck-btn sm '+(off?"":"danger ")+'ck-toggle" data-id="'+t.id+'">'+(off?"Turn on":"Turn off")+'</button>'
      + '</div></div>';
  }

  /* ------------------------------------------------ DAY / ARCHIVE view */
  function renderDay(isArchive){
    var body = document.getElementById("ckBody");
    var date = isArchive ? (archiveDate || today()) : today();
    var head = "";
    if (isArchive){
      head = '<div class="ck-card ck-row" style="margin-bottom:1.4rem">'
        + '<label style="flex:0 1 210px"><span class="ck-lbl">Show the boards as they stood on</span>'
        + '<input type="date" id="ckDate" class="ck-in" value="'+date+'" max="'+today()+'"></label>'
        + '<div style="flex:1 1 260px;font-size:.8rem;color:var(--text-secondary,#5b6270);align-self:flex-end;padding-bottom:.5rem">'
        + 'Every sign-off is kept against its own date. Boards reset overnight; nothing is overwritten.</div></div>'
        + '<div class="ck-h" style="margin-top:0">'+esc(niceDate(date))+'</div>';
    }

    var rows = DUE.filter(function(d){ return d.status!=="upcoming"; });
    if (!rows.length){
      body.innerHTML = head + '<div class="ck-card" style="text-align:center;color:var(--text-secondary,#5b6270)">Nothing was scheduled that day.</div>';
      return;
    }

    // per-board summary
    var sum = '<table><thead><tr><th>Board</th><th class="n">Done</th><th class="n">Open</th><th class="n">Missed</th></tr></thead><tbody>';
    ROLES.forEach(function(r){
      var l = rows.filter(function(d){ return d.role===r.id; });
      if (!l.length) return;
      sum += '<tr><td>'+r.label+'</td>'
        + '<td class="n" style="color:#2b6b33">'+l.filter(function(d){return d.status==="done"||d.status==="na";}).length+'</td>'
        + '<td class="n">'+l.filter(function(d){return d.status==="due";}).length+'</td>'
        + '<td class="n" style="color:#a33b34">'+l.filter(function(d){return d.status==="overdue";}).length+'</td></tr>';
    });
    sum += '</tbody></table>';

    // hourly coverage
    var hourly = DUE.filter(function(d){ return d.recurrence==="hourly"; });
    var hrs = "";
    if (hourly.length){
      hrs = '<div class="ck-h">Hourly rounds</div>' + hourly.map(function(d){
        var strip = "";
        for (var x=d.hour_start; x<=d.hour_end; x++){
          var covered = (d.hoursDone||[]).indexOf(x) > -1;
          var past = d.current_slot==null || x < d.current_slot;
          strip += '<span class="ck-hr'+(covered?" ok":(past?" miss":""))+'">'+hourName(x).replace("m","")+'</span>';
        }
        return '<div class="ck-card"><div style="font-weight:600;font-size:.92rem">'+esc(d.title)
          + ' <span style="font-weight:400;color:var(--text-secondary,#5b6270);font-size:.8rem">— '
          + d.hours_covered + ' of ' + d.hours_expected + ' hours covered</span></div>'
          + '<div style="margin-top:.6rem">'+strip+'</div></div>';
      }).join("");
    }

    // what got missed
    var missed = rows.filter(function(d){ return d.status==="overdue" || d.status==="due"; });
    var miss = '<div class="ck-h">Not signed off ('+missed.length+')</div>';
    miss += missed.length
      ? '<table><thead><tr><th>Task</th><th>Board</th><th class="n">Status</th></tr></thead><tbody>'
        + missed.map(function(d){
            return '<tr><td>'+esc(d.title)+(d.area?'<br><span style="color:#9aa1ad;font-size:.72rem">'+esc(d.area)+'</span>':'')+'</td>'
              + '<td>'+esc(roleLabel(d.role))+'</td>'
              + '<td class="n" style="color:'+(d.status==="overdue"?"#a33b34":"#8a6d1f")+'">'
              + (d.status==="overdue"?"missed":"open")+'</td></tr>';
          }).join("") + '</tbody></table>'
      : '<div class="ck-card" style="text-align:center;color:#2b6b33">Everything was signed off.</div>';

    // signed off
    var done = rows.filter(function(d){ return d.status==="done"||d.status==="na"; });
    var sig = '<div class="ck-h">Signed off ('+done.length+')</div>'
      + (done.length ? '<table><tbody>' + done.map(function(d){
          return '<tr><td>'+esc(d.title)+'</td><td>'+esc(roleLabel(d.role))+'</td>'
               + '<td class="n">'+esc(d.done_by||"")+'</td></tr>'; }).join("") + '</tbody></table>'
        : '<div class="ck-card" style="text-align:center;color:var(--text-secondary,#5b6270)">Nothing signed off.</div>');

    var fc = "";
    if (!isArchive){
      var big = TASKS.filter(function(t){ return t.is_big_job && t.active; })
                     .map(function(t){ var d = dueOf(t.id); return { t:t, d:d }; })
                     .sort(function(a,b){ return (a.d.days_until_due||0)-(b.d.days_until_due||0); });
      var buckets = [
        ["Due now", function(x){ return (x.d.days_until_due||0) <= 0; }],
        ["Next 7 days", function(x){ return x.d.days_until_due>0 && x.d.days_until_due<=7; }],
        ["8 to 30 days", function(x){ return x.d.days_until_due>7 && x.d.days_until_due<=30; }],
        ["Beyond 30 days", function(x){ return x.d.days_until_due>30; }]
      ];
      fc = '<div class="ck-h">Big-job staffing forecast</div>';
      buckets.forEach(function(b){
        var r2 = big.filter(b[1]); if (!r2.length) return;
        var hrs2 = (r2.reduce(function(s,x){ return s + (x.t.est_minutes||0); },0)/60).toFixed(1);
        fc += '<div class="ck-card"><div style="font-weight:600;font-size:.88rem;margin-bottom:.5rem">'
          + b[0] + ' <span style="font-weight:400;color:var(--text-secondary,#5b6270)">— '+hrs2+' labor hours</span></div>'
          + '<table><tbody>' + r2.map(function(x){
              return '<tr><td>'+esc(x.t.title)+(x.t.area?'<br><span style="color:#9aa1ad;font-size:.72rem">'+esc(x.t.area)+'</span>':'')+'</td>'
                + '<td>'+esc(roleLabel(x.t.role))+'</td>'
                + '<td class="n">'+(x.d.status==="overdue"?"late":(x.d.days_until_due<=0?"now":"in "+x.d.days_until_due+"d"))+'</td></tr>';
            }).join("") + '</tbody></table></div>';
      });
    }

    body.innerHTML = head + '<div class="ck-card">'+sum+'</div>' + hrs + miss + sig + fc;
  }

  /* ------------------------------------------------ STAFF view */
  function renderStaff(){
    document.getElementById("ckBody").innerHTML =
      '<div class="ck-card" style="padding:1.3rem 1.4rem;margin-bottom:1.4rem">'
      + '<div style="font:700 .7rem/1 inherit;letter-spacing:.14em;text-transform:uppercase;color:var(--text-secondary,#5b6270);margin-bottom:1rem">Add someone</div>'
      + '<div class="ck-row">'
      +   '<label style="flex:2 1 220px"><span class="ck-lbl">Name</span><input id="sName" class="ck-in" placeholder="Jane Doe"></label>'
      +   '<label style="flex:0 1 120px"><span class="ck-lbl">Initials</span><input id="sInit" class="ck-in" maxlength="4" placeholder="JD"></label>'
      +   '<label style="flex:1 1 180px"><span class="ck-lbl">Position</span><select id="sRole" class="ck-in">'
      +     ROLES.map(function(r){ return '<option value="'+r.id+'">'+r.label+'</option>'; }).join("")
      +     '<option value="manager">Manager</option></select></label>'
      + '</div>'
      + '<div style="margin-top:1rem"><button class="ck-btn on" id="ckAddStaff">Add to roster</button></div></div>'
      + (STAFF.length
          ? '<table><thead><tr><th>Initials</th><th>Name</th><th>Position</th><th></th></tr></thead><tbody>'
            + STAFF.map(function(s){
                return '<tr><td style="font-weight:700">'+esc(s.initials)+'</td><td>'+esc(s.name)+'</td>'
                  + '<td>'+esc(roleLabel(s.role||""))+'</td>'
                  + '<td class="n"><button class="ck-btn sm danger ck-delstaff" data-id="'+s.id+'">Remove</button></td></tr>';
              }).join("") + '</tbody></table>'
          : '<div class="ck-card" style="text-align:center;color:var(--text-secondary,#5b6270)">No roster yet — staff type their own initials on the iPad.</div>');
  }

  /* ------------------------------------------------ actions */
  function save(){
    var btn = document.getElementById("ckSave");
    var title = document.getElementById("ckTitle").value.trim();
    if (!title) return msg("Give the task a name first.", true);

    var cad = document.getElementById("ckCad").value;
    var hourly = cad === "hourly";
    var picked = [];
    document.querySelectorAll("#ckDays .ck-day.on").forEach(function(b){ picked.push(Number(b.getAttribute("data-d"))); });
    if (!hourly && !picked.length) return msg("Pick at least one day it can be done.", true);

    var mins = parseInt(document.getElementById("ckMins").value, 10);
    var body = {
      role: role, title: title,
      detail: document.getElementById("ckDetail").value.trim() || null,
      segment: document.getElementById("ckSeg").value,
      area: document.getElementById("ckArea").value.trim() || null,
      est_minutes: isNaN(mins) ? null : mins,
      is_big_job: document.getElementById("ckBig").checked,
      recurrence: hourly ? "hourly" : "interval",
      active: true
    };
    if (hourly){
      body.interval_days = 1; body.cadence = "daily";
      body.days_of_week = OPEN_DAYS;
      body.hour_start = Number(document.getElementById("ckHs").value);
      body.hour_end   = Number(document.getElementById("ckHe").value);
      if (body.hour_end < body.hour_start) return msg("The last round can't be before the first.", true);
    } else {
      body.interval_days = Number(cad);
      body.cadence = cadenceKey(Number(cad));
      body.days_of_week = picked;
    }

    btn.disabled = true; btn.textContent = "Saving…";
    var req = editId
      ? api("checklist_tasks?id=eq."+editId, { method:"PATCH", body: JSON.stringify(body) })
      : api("checklist_tasks", { method:"POST", body: JSON.stringify(body) });
    req.then(function(){
      editId = null;
      msg('"'+title+'" saved. It reaches the iPads within a minute.');
      load();
    }).catch(function(e){
      btn.disabled = false; btn.textContent = editId ? "Save changes" : "Add task";
      msg("Could not save: " + e.message, true);
    });
  }

  function toggle(id){
    var t = TASKS.filter(function(x){ return x.id===id; })[0]; if (!t) return;
    api("checklist_tasks?id=eq."+id, { method:"PATCH", body: JSON.stringify({ active: !t.active }) })
      .then(function(){ msg(t.active ? "Turned off — it drops off the iPads." : "Back on the board."); load(); })
      .catch(function(e){ msg("Could not update: "+e.message, true); });
  }

  function move(id, dir){
    var t = TASKS.filter(function(x){ return x.id===id; })[0]; if (!t) return;
    var peers = TASKS.filter(function(x){ return x.role===t.role && x.segment===t.segment; })
                     .sort(function(a,b){ return (a.sort_order-b.sort_order) || a.title.localeCompare(b.title); });
    var i = peers.findIndex(function(x){ return x.id===id; }), j = i + dir;
    if (i<0 || j<0 || j>=peers.length) return;
    var o = peers[j], a = t.sort_order, b = o.sort_order;
    if (a === b) b = a + dir;
    Promise.all([
      api("checklist_tasks?id=eq."+t.id, { method:"PATCH", body: JSON.stringify({ sort_order: b }) }),
      api("checklist_tasks?id=eq."+o.id, { method:"PATCH", body: JSON.stringify({ sort_order: a }) })
    ]).then(load).catch(function(e){ msg("Could not reorder: "+e.message, true); });
  }

  /* ------------------------------------------------ events */
  function onClick(e){
    var el;
    if ((el = e.target.closest(".ck-view"))){ view = el.getAttribute("data-view"); editId = null; render(); return; }
    if ((el = e.target.closest(".ck-role"))){ role = el.getAttribute("data-role"); editId = null; render(); return; }
    if ((el = e.target.closest(".ck-day"))){ el.classList.toggle("on"); return; }
    if ((el = e.target.closest(".ck-edit"))){
      editId = el.getAttribute("data-id"); renderTasks();
      document.getElementById("checklistsTab").scrollIntoView({ behavior:"smooth", block:"start" }); return;
    }
    if ((el = e.target.closest(".ck-toggle"))) return toggle(el.getAttribute("data-id"));
    if ((el = e.target.closest(".ck-up")))    return move(el.getAttribute("data-id"), -1);
    if ((el = e.target.closest(".ck-down")))  return move(el.getAttribute("data-id"), 1);
    if ((el = e.target.closest(".ck-delstaff"))){
      if (!window.confirm("Remove from the roster?")) return;
      api("checklist_staff?id=eq."+el.getAttribute("data-id"), { method:"DELETE" })
        .then(function(){ msg("Removed."); load(); })
        .catch(function(err){ msg("Could not remove: "+err.message, true); });
      return;
    }
    if (e.target.id === "ckSave")    return save();
    if (e.target.id === "ckCancel")  { editId = null; renderTasks(); return; }
    if (e.target.id === "ckRefresh") return load();
    if (e.target.id === "ckAddStaff"){
      var n = document.getElementById("sName").value.trim(),
          i2 = document.getElementById("sInit").value.trim().toUpperCase(),
          r = document.getElementById("sRole").value;
      if (!n || !i2) return msg("Name and initials are both required.", true);
      api("checklist_staff", { method:"POST", body: JSON.stringify({ name:n, initials:i2, role:r }) })
        .then(function(){ msg("Added "+i2+"."); load(); })
        .catch(function(err){ msg("Could not add: "+err.message, true); });
    }
  }
  function onChange(e){
    if (e.target.id === "ckCad"){
      var hourly = e.target.value === "hourly";
      document.getElementById("ckHourWrap").style.display = hourly ? "flex" : "none";
      document.getElementById("ckDayWrap").style.display  = hourly ? "none" : "";
    }
    if (e.target.id === "ckDate"){ archiveDate = e.target.value; load(); }
  }

  /* ------------------------------------------------ load */
  function render(){
    renderViews();
    if (view === "tasks")        renderTasks();
    else if (view === "day")     renderDay(false);
    else if (view === "archive") renderDay(true);
    else                         renderStaff();
  }

  function load(){
    var body = document.getElementById("ckBody");
    if (!body) return;
    var date = view === "archive" ? (archiveDate || today()) : null;
    body.innerHTML = '<p style="color:var(--text-secondary,#5b6270)">Loading…</p>';
    Promise.all([
      api("checklist_tasks?select=*&order=role,segment,sort_order"),
      api("rpc/checklist_due", { method:"POST", body: JSON.stringify({ p_date: date }) }),
      api("checklist_staff?select=*&order=name"),
      api("checklist_logs?select=task_id,slot&slot=not.is.null&business_date=eq." + (date || today()))
    ]).then(function(res){
      TASKS = res[0] || []; DUE = res[1] || []; STAFF = res[2] || [];
      var slots = res[3] || [];
      DUE.forEach(function(d){
        if (d.recurrence === "hourly")
          d.hoursDone = slots.filter(function(s){ return s.task_id===d.task_id; }).map(function(s){ return s.slot; });
      });
      render();
    }).catch(function(e){
      body.innerHTML = '<div style="background:#fbe4e2;border:1px solid #e0a8a2;border-radius:10px;padding:1rem;color:#a33b34">'
        + 'Could not load: ' + esc(e.message) + '</div>';
    });
  }

  function boot(){ inject(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
