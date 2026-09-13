/* =========================================================================
   Nightly shift checklist report
   Runs after close every night, emails what got signed off and what did
   not, board by board, plus who Square says was clocked in during that
   business day so the misses have names attached.

   Scheduled from netlify.toml. Can also be fired by hand with
   ?key=<VENUE_AVAILABILITY_KEY>&date=YYYY-MM-DD for a re-send.

   Env used: SUPABASE_ANON_KEY, SENDGRID_API_KEY, SQUARE_ACCESS_TOKEN,
             CHECKLIST_REPORT_TO, VENUE_AVAILABILITY_KEY
   Labor lives in a SEPARATE Square account from the website's payments
   token — see squareCrew() below. SQUARE_LOCATION_ID is correct for
   payments and is deliberately not used here.
   ========================================================================== */
const SB = "https://nkulhtalltbieicvmmad.supabase.co";

const ROLES = {
  bartender: "Bar", server: "Servers", support: "Host & Bus",
  kitchen: "Kitchen", staff: "Staff Board"
};

const CSS = {
  ink: "#1A1A1A", cream: "#F5F0E8", gold: "#B8933A", goldLt: "#D4AF6A",
  green: "#2b6b33", red: "#a33b34", dim: "#6f7681", line: "#e6e8ec"
};

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Business day runs 4am to 4am — a 2:30am run reports the night that is
   just ending, not the handful of hours of the new calendar date. */
const chicagoDate = (d = new Date()) => {
  const chi = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  chi.setHours(chi.getHours() - 4);
  return chi.toLocaleDateString("en-CA");
};

const hourName = h => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? "a" : "p");

/* ---------------------------------------------------------------- data */
async function sb(path, body) {
  const key = process.env.SUPABASE_ANON_KEY;
  const res = await fetch(SB + "/rest/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error("supabase " + res.status + ": " + (await res.text()));
  return res.json();
}

/* Who was clocked in that business day, per Square.

   IMPORTANT — there are two Square accounts behind The Quarry:
     MLA1E0P3MZ0KC  the website/online payments account. This is what
                    SQUARE_ACCESS_TOKEN holds. Locations LSH424Z9E0S98
                    and LDFSE2ACXVT75. No team, no timecards.
     MLF3658E76VN9  the POS / payroll account. Location LV81798YKDGPS.
                    This is where staff and clock-ins actually live.

   The labor endpoints return 200 with an empty list when queried with a
   token for the wrong account, so a missing crew list looks exactly like
   "nobody worked". To keep the report honest we check the merchant the
   token belongs to and say which case we are in.

   Set SQUARE_LABOR_TOKEN to an access token for the POS/payroll account
   and the crew list starts working. Until then the report says so out
   loud rather than implying the building was empty. */
const nextDay = d => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate()+1); return x.toLocaleDateString('en-CA'); };
const LABOR_MERCHANT = "MLF3658E76VN9";

async function squareCrew(date) {
  const token = process.env.SQUARE_LABOR_TOKEN || process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return { crew: [], note: "Square not configured" };

  const headers = {
    Authorization: "Bearer " + token,
    "Square-Version": "2026-06-18",
    "Content-Type": "application/json"
  };

  try {
    // Which account is this token for? Wrong one = empty results, not an error.
    const meRes = await fetch("https://connect.squareup.com/v2/merchants/me", { headers });
    if (!meRes.ok) return { crew: [], note: "Square auth failed (" + meRes.status + ")" };
    const merchantId = ((await meRes.json()).merchant || {}).id;

    if (merchantId !== LABOR_MERCHANT) {
      return {
        crew: [],
        note: "Clock-in data lives in the POS Square account (" + LABOR_MERCHANT +
              "), but this site's token is for " + merchantId +
              ". Add SQUARE_LABOR_TOKEN in Netlify to switch this on."
      };
    }

    const tcRes = await fetch("https://connect.squareup.com/v2/labor/timecards/search", {
      method: "POST", headers,
      body: JSON.stringify({
        // the crew window must match the 4am-to-4am business day, or a
        // bartender who clocked out at 1am lands on the wrong night
        query: { filter: { start: { start_at: date + "T04:00:00-05:00",
                                    end_at:   nextDay(date) + "T03:59:59-05:00" } } },
        limit: 200
      })
    });
    if (!tcRes.ok) return { crew: [], note: "Square timecards returned " + tcRes.status };
    const cards = (await tcRes.json()).timecards || [];
    if (!cards.length) return { crew: [], note: "Nobody clocked in" };

    let names = {};
    const tmRes = await fetch("https://connect.squareup.com/v2/team-members/search", {
      method: "POST", headers, body: JSON.stringify({ limit: 200 })
    });
    if (tmRes.ok) {
      ((await tmRes.json()).team_members || []).forEach(m => {
        names[m.id] = [m.given_name, m.family_name].filter(Boolean).join(" ")
          || m.email_address || m.id;
      });
    }

    const fmt = t => t ? new Date(t).toLocaleTimeString("en-US",
      { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }) : null;

    return {
      crew: cards.map(c => ({
        name: names[c.team_member_id] || "Unnamed",
        role: (c.wage && c.wage.title) || "",
        in: fmt(c.start_at) || "\u2014",
        out: fmt(c.end_at) || (c.status === "OPEN" ? "still on" : "\u2014")
      })).sort((a, b) => a.name.localeCompare(b.name)),
      note: null
    };
  } catch (e) {
    return { crew: [], note: "Square lookup failed: " + e.message };
  }
}

/* ---------------------------------------------------------------- html */
function buildHtml(date, rows, hourly, crew, crewNote) {
  const live = rows.filter(r => r.status !== "upcoming");
  const done = live.filter(r => r.status === "done" || r.status === "na");
  const missed = live.filter(r => r.status === "overdue" || r.status === "due");
  const pct = live.length ? Math.round(done.length / live.length * 100) : 100;

  const nice = new Date(date + "T12:00:00").toLocaleDateString("en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const th = `style="text-align:left;font:700 11px/1 Arial,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:${CSS.dim};padding:0 10px 8px 0;border-bottom:1px solid ${CSS.line}"`;
  const td = `style="padding:9px 10px 9px 0;border-bottom:1px solid ${CSS.line};font:14px/1.4 Arial,sans-serif;vertical-align:top"`;

  let boards = "";
  Object.keys(ROLES).forEach(r => {
    const l = live.filter(x => x.role === r);
    if (!l.length) return;
    const d = l.filter(x => x.status === "done" || x.status === "na").length;
    const m = l.filter(x => x.status === "overdue").length;
    boards += `<tr><td ${td}>${ROLES[r]}</td>
      <td ${td} align="right"><b style="color:${CSS.green}">${d}</b></td>
      <td ${td} align="right">${l.length - d - m}</td>
      <td ${td} align="right"><b style="color:${m ? CSS.red : CSS.dim}">${m}</b></td></tr>`;
  });

  let missHtml = missed.length
    ? `<table width="100%" cellpadding="0" cellspacing="0">
        <tr><th ${th}>Task</th><th ${th}>Board</th><th ${th} align="right">Status</th></tr>
        ${missed.map(m => `<tr>
          <td ${td}>${esc(m.title)}${m.area ? `<br><span style="font-size:12px;color:${CSS.dim}">${esc(m.area)}</span>` : ""}</td>
          <td ${td}>${ROLES[m.role] || m.role}</td>
          <td ${td} align="right"><span style="color:${m.status === "overdue" ? CSS.red : "#8a6d1f"};font-weight:600">${m.status === "overdue" ? "missed" : "open"}</span></td>
        </tr>`).join("")}
      </table>`
    : `<p style="font:15px Arial,sans-serif;color:${CSS.green};margin:0"><b>Every task was signed off.</b></p>`;

  let hourlyHtml = "";
  if (hourly.length) {
    hourlyHtml = `<h3 style="font:700 12px/1 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;color:${CSS.gold};margin:34px 0 12px">Hourly rounds</h3>`;
    hourly.forEach(t => {
      let strip = "";
      for (let x = t.hour_start; x <= t.hour_end; x++) {
        const ok = (t.hoursDone || []).indexOf(x) > -1;
        strip += `<span style="display:inline-block;min-width:30px;text-align:center;padding:4px 0;margin:0 3px 3px 0;border-radius:5px;font:700 11px Arial,sans-serif;background:${ok ? "#cfead4" : "#f6d5d2"};color:${ok ? CSS.green : CSS.red}">${hourName(x)}</span>`;
      }
      const shortfall = t.hours_expected - t.hours_covered;
      hourlyHtml += `<div style="margin-bottom:14px">
        <div style="font:600 14px Arial,sans-serif">${esc(t.title)}
          <span style="font-weight:400;color:${shortfall > 0 ? CSS.red : CSS.green}"> — ${t.hours_covered} of ${t.hours_expected} hours covered${shortfall > 0 ? `, ${shortfall} missed` : ""}</span>
        </div><div style="margin-top:6px">${strip}</div></div>`;
    });
  }

  const crewHtml = crew.length
    ? `<table width="100%" cellpadding="0" cellspacing="0">
        <tr><th ${th}>Clocked in</th><th ${th}>Role</th><th ${th} align="right">In</th><th ${th} align="right">Out</th></tr>
        ${crew.map(c => `<tr><td ${td}>${esc(c.name)}</td><td ${td}>${esc(c.role)}</td>
          <td ${td} align="right">${esc(c.in)}</td><td ${td} align="right">${esc(c.out)}</td></tr>`).join("")}
      </table>`
    : `<p style="font:14px Arial,sans-serif;color:${CSS.dim};margin:0">${esc(crewNote || "No clock-in data")}</p>`;

  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 12px">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:14px;overflow:hidden">

  <tr><td style="background:${CSS.ink};padding:26px 30px">
    <div style="font:700 15px Georgia,serif;letter-spacing:.2em;text-transform:uppercase;color:${CSS.goldLt}">The Quarry</div>
    <div style="font:600 20px Arial,sans-serif;color:${CSS.cream};margin-top:8px">Shift checklist — ${nice}</div>
    <div style="font:14px Arial,sans-serif;color:#9d9285;margin-top:6px">
      ${done.length} of ${live.length} signed off · <b style="color:${pct === 100 ? "#8fd694" : pct >= 85 ? CSS.goldLt : "#e8a49e"}">${pct}%</b>
    </div>
  </td></tr>

  <tr><td style="padding:26px 30px">
    <h3 style="font:700 12px/1 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;color:${CSS.gold};margin:0 0 12px">By board</h3>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><th ${th}>Board</th><th ${th} align="right">Done</th><th ${th} align="right">Open</th><th ${th} align="right">Missed</th></tr>
      ${boards}
    </table>

    <h3 style="font:700 12px/1 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;color:${CSS.gold};margin:34px 0 12px">Not signed off — ${missed.length}</h3>
    ${missHtml}

    ${hourlyHtml}

    <h3 style="font:700 12px/1 Arial,sans-serif;letter-spacing:.15em;text-transform:uppercase;color:${CSS.gold};margin:34px 0 12px">On shift, per Square</h3>
    ${crewHtml}

    <p style="font:13px/1.6 Arial,sans-serif;color:${CSS.dim};margin:30px 0 0;padding-top:18px;border-top:1px solid ${CSS.line}">
      Full history is in the admin panel under Checklists → Archive.
      Initials on the boards are self-reported; the Square list above is who was actually on the clock.
    </p>
  </td></tr>

</table></td></tr></table></body></html>`;
}

/* ---------------------------------------------------------------- send */
async function send(subject, html) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error("SENDGRID_API_KEY not set");
  const to = (process.env.CHECKLIST_REPORT_TO || "management@thequarrystl.com")
    .split(",").map(s => s.trim()).filter(Boolean);
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: to.map(e => ({ email: e })) }],
      from: { email: "management@thequarrystl.com", name: "The Quarry" },
      subject,
      content: [{ type: "text/html", value: html }]
    })
  });
  if (!res.ok) throw new Error("sendgrid " + res.status + ": " + (await res.text()));
}

/* ---------------------------------------------------------------- main */
exports.handler = async (event) => {
  const manual = event && event.queryStringParameters && event.queryStringParameters.key;
  if (manual && manual !== process.env.VENUE_AVAILABILITY_KEY) {
    return { statusCode: 401, body: "unauthorized" };
  }

  const date = (event && event.queryStringParameters && event.queryStringParameters.date) || chicagoDate();

  try {
    const rows = await sb("rpc/checklist_due", { p_date: date });

    const hourly = rows.filter(r => r.recurrence === "hourly");
    if (hourly.length) {
      const ids = hourly.map(t => t.task_id).join(",");
      const slots = await sb(`checklist_logs?select=task_id,slot&slot=not.is.null&business_date=eq.${date}&task_id=in.(${ids})`);
      hourly.forEach(t => {
        t.hoursDone = slots.filter(s => s.task_id === t.task_id).map(s => s.slot);
      });
    }

    const { crew, note } = await squareCrew(date);

    const live = rows.filter(r => r.status !== "upcoming");
    const missed = live.filter(r => r.status === "overdue" || r.status === "due").length;
    const subject = missed === 0
      ? `Quarry checklist ${date} — all clear`
      : `Quarry checklist ${date} — ${missed} not signed off`;

    await send(subject, buildHtml(date, rows, hourly, crew, note));

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, date, total: live.length, missed, crew: crew.length, squareNote: note })
    };
  } catch (e) {
    console.error("nightly report failed:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
