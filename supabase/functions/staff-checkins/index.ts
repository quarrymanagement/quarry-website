// ============================================================================
// Supabase Edge Function: staff-checkins
// The Quarry — goals from the self-evaluation + weekly accountability check-ins.
//
//   Evaluation (staff-eval.html) ends with 2 goals for next week, each tied to
//   a standard from their role. Management can edit or add goals.
//   Each week management sets a team focus per role and sends check-ins with
//   three questions:
//     1. What did you focus on this week?   (per open goal: done / partly /
//        not yet + what they did; free text if they had no goals)
//     2. What could you do to keep improving on those?
//     3. What are two things you want to add on?   (two new goals)
//   Done goals close. Unfinished goals carry if they tick "keep working on
//   this" (default on). Max 4 open goals.
// ----------------------------------------------------------------------------
// verify_jwt = false (custom auth per action).
//
//   PUBLIC
//     goals_get      (eval token)  active + closed goals for that evaluation's person
//     goals_set      (eval token)  employee's 2 goals from the evaluation
//     checkin_load   (check-in token)
//     checkin_submit (check-in token)
//   ADMIN (x-admin-token, roles owner/events_staff)
//     admin_goals        goals for a name
//     admin_goal_save    add / edit / close a goal (set_by mgmt when added)
//     admin_focus        get this week's focus per role (+ last week's)
//     admin_focus_set    set one role's focus for a week
//     admin_due          who gets this week's check-in (active goals, not sent yet)
//     admin_send         create check-ins + email links
//     admin_list         check-ins for a week (or recent)
//     admin_note         management reply on a check-in (employee sees it; emailed the first time)
//     admin_void         void a check-in
// Tables: staff_goals, staff_checkins, staff_weekly_focus (RLS on, no policies).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const CHECKIN_URL = `${SITE}/staff-checkin.html`;
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ALLOWED_ROLES = ["owner", "events_staff"];
const ROLES = ["server", "host", "busser", "expo", "bartender", "kitchen"];
const ROLE_NAMES: Record<string, string> = { server: "Servers", host: "Hosts", busser: "Bussers", expo: "Expo", bartender: "Bartenders", kitchen: "Kitchen" };
const MIN_GOAL = 6, MIN_NOTE = 3, MIN_IMPROVE = 5, MIN_NEW = 4, NEW_GOALS = 2, MAX_OPEN = 4; // check-ins are meant to take about a minute
// Standards per role, for tying a new goal to one. Mirrors FORMS in staff-evals (titles only).
const AREAS: Record<string, [string, string][]> = {
  server: [["pace", "Greet and pace"], ["handheld", "Handheld ordering"], ["hands", "Full hands, in and out"], ["team", "\"Not my table\" doesn't exist"], ["guest", "Over-communicate with guests"], ["allergy", "Allergies and accuracy"], ["sell", "Sell The Quarry"], ["close", "Leaving the floor and cashing out"]],
  host: [["door", "Own the door"], ["rotation", "Seating rotation"], ["wait", "Wait times and the waitlist"], ["phone", "Phone and reservations"], ["know", "Know tonight"], ["support", "Support the floor"], ["checklist", "Checklist and side work"]],
  busser: [["station", "Hold your station"], ["scout", "Scout your tables"], ["reset", "Fast resets"], ["servers", "Back up the servers"], ["hands", "Full hands, in and out"], ["guests", "Guest manners"], ["checklist", "Checklist and closing duties"]],
  expo: [["check", "Check every plate"], ["allergy", "Allergy tickets"], ["timing", "Timing"], ["line", "Talk to the line"], ["present", "Presentation"], ["run", "Run it right"], ["station", "Window and checklist"]],
  bartender: [["speed", "Bar and service-bar speed"], ["responsible", "Responsible service"], ["recipes", "Pours and recipes"], ["ring", "Ring everything"], ["wine", "Wine and beer service"], ["sell", "Bar guests and selling"], ["cash", "Cash and tabs"], ["clean", "Clean bar and checklist"]],
  kitchen: [["safety", "Food safety"], ["allergy", "Allergies"], ["spec", "Recipes and plating"], ["tickets", "Ticket times and calls"], ["prep", "Prep and 86s"], ["clean", "Clean as you go"], ["team", "One kitchen"], ["waste", "Product and waste"]],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const words = (s: unknown) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const clean = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const firstName = (n: string) => String(n || "").trim().split(" ")[0];
const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const link = (t: string) => `${CHECKIN_URL}?t=${t}`;

// Monday (Chicago) of the week containing `d`, as YYYY-MM-DD.
function mondayOf(d = new Date()): string {
  const local = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const dow = (local.getDay() + 6) % 7; // Mon=0
  local.setDate(local.getDate() - dow);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}
function addDays(ymd: string, n: number) { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function adminRole(req: Request): Promise<string | null> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) return null;
  try {
    const r = await fetch(VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", token: tok }) });
    const b = await r.json().catch(() => ({}));
    return b.ok ? (b.role || null) : null;
  } catch (_) { return null; }
}
async function sendEmail(to: { email: string; firstName?: string }[], subject: string, htmlBody: string) {
  try {
    const r = await fetch(SEND_EMAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, htmlBody, recipients: to, fromEmail: MANAGEMENT_EMAIL, fromName: "The Quarry" }) });
    return r.ok;
  } catch (_) { return false; }
}
const shell = (title: string, inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e6dfd3;border-radius:10px;overflow:hidden;">
     <div style="background:#1A1A1A;padding:18px 22px;"><span style="color:#B8933A;font-family:Georgia,serif;font-weight:bold;letter-spacing:3px;font-size:18px;">THE QUARRY</span></div>
     <div style="padding:22px;color:#222;font-size:15px;line-height:1.5;"><h2 style="margin:0 0 12px;color:#2C1A0E;font-size:19px;">${title}</h2>${inner}</div>
     <div style="padding:12px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">The Quarry · 3960 Highway Z, New Melle, MO 63385</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:22px 0;"><a href="${href}" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a></p>`;

async function goalsFor(name: string, includeClosed = false) {
  let q = supa.from("staff_goals").select("*").ilike("employee_name", String(name).replace(/[%_\\]/g, (c) => "\\" + c)).order("created_at");
  if (!includeClosed) q = q.eq("status", "active");
  const { data } = await q;
  return data ?? [];
}
async function focusFor(role: string | null, week: string) {
  if (!role) return null;
  const { data } = await supa.from("staff_weekly_focus").select("text").eq("role_key", role).eq("week_of", week).maybeSingle();
  return data?.text || null;
}
const goalOut = (g: any) => ({ id: g.id, area_id: g.area_id, area_title: g.area_title, goal: g.goal, set_by: g.set_by, status: g.status, created_at: g.created_at, closed_at: g.closed_at });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  try {
    // ---------------- PUBLIC: goals from the evaluation ----------------
    if (action === "goals_get" || action === "goals_set") {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: e } = await supa.from("staff_evaluations").select("id,employee_name,role_key,status").eq("token", tok).single();
      if (!e || e.status === "voided") return json({ error: "This link isn't valid." }, 404);
      if (action === "goals_get") return json({ goals: (await goalsFor(e.employee_name, true)).map(goalOut) });
      const { data: mine } = await supa.from("staff_goals").select("id").eq("evaluation_id", e.id).eq("set_by", "employee");
      if ((mine ?? []).length) return json({ ok: true, already: true, goals: (await goalsFor(e.employee_name, true)).map(goalOut) });
      const list = Array.isArray(body.goals) ? body.goals.slice(0, 2) : [];
      const rows = list.map((g: any) => ({ area_id: clean(g.area_id, 40), area_title: clean(g.area_title, 120), goal: clean(g.goal, 1000) })).filter((g: any) => g.goal);
      if (!rows.length) return json({ error: "Set at least one goal for next week." }, 400);
      if (rows.length < NEW_GOALS) return json({ error: `Set ${NEW_GOALS} goals for next week.` }, 400);
      if (rows.some((g: any) => words(g.goal) < MIN_GOAL)) return json({ error: `Each goal needs at least ${MIN_GOAL} words: what exactly you'll do.` }, 400);
      await supa.from("staff_goals").insert(rows.map((g: any) => ({ ...g, evaluation_id: e.id, employee_name: e.employee_name, role_key: e.role_key, set_by: "employee" })));
      return json({ ok: true, goals: (await goalsFor(e.employee_name, true)).map(goalOut) });
    }

    // ---------------- PUBLIC: weekly check-in ----------------
    if (action === "checkin_load" || action === "checkin_submit") {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: c } = await supa.from("staff_checkins").select("*").eq("token", tok).single();
      if (!c) return json({ error: "This link isn't valid." }, 404);
      if (c.status === "voided") return json({ error: "This check-in was withdrawn.", voided: true }, 410);
      const head = { employee_name: c.employee_name, role_key: c.role_key, role_name: ROLE_NAMES[c.role_key] || "", week_of: c.week_of, focus: c.focus_text, min: { note: MIN_NOTE, goal: MIN_NEW, improve: MIN_IMPROVE }, new_goals_count: NEW_GOALS, max_open: MAX_OPEN, areas: (AREAS[c.role_key] || []).map(([id, title]) => ({ id, title })) };
      if (action === "checkin_load") {
        if (c.status === "submitted") {
          return json({ ...head, status: c.status, submitted_at: c.submitted_at, results: c.results, focus_note: c.focus_note, improve: c.improve, new_goals: c.new_goals || [], mgr_note: c.mgr_note, mgr_by: c.mgr_by, goals_now: (await goalsFor(c.employee_name)).map(goalOut) });
        }
        if (!c.opened_at) await supa.from("staff_checkins").update({ opened_at: new Date().toISOString() }).eq("id", c.id);
        const goals = (await goalsFor(c.employee_name)).map(goalOut);
        const { data: last } = await supa.from("staff_checkins").select("week_of,results,mgr_note,mgr_by").eq("employee_name", c.employee_name).eq("status", "submitted").lt("week_of", c.week_of).order("week_of", { ascending: false }).limit(1);
        return json({ ...head, status: c.status, goals, last: (last ?? [])[0] || null });
      }
      // submit
      if (c.status === "submitted") return json({ error: "Already submitted.", done: true }, 409);
      const goals = await goalsFor(c.employee_name);
      const inRes = body.results || {};
      const results: any[] = [];
      for (const g of goals) {
        const r = inRes[g.id] || {};
        if (!["done", "partly", "not_yet"].includes(r.result)) return json({ error: `Tell us how "${g.goal.slice(0, 40)}…" went.` }, 400);
        if (words(r.note) < MIN_NOTE) return json({ error: `Say what you did on each goal (at least ${MIN_NOTE} words).` }, 400);
        results.push({ goal_id: g.id, goal: g.goal, area_title: g.area_title, result: r.result, note: clean(r.note, 2000), keep: r.result !== "done" && r.keep !== false });
      }
      const focusNote = clean(body.focus_note, 3000);
      if (!goals.length && words(focusNote) < MIN_IMPROVE) return json({ error: "Tell us what you focused on this week." }, 400);
      const improve = clean(body.improve, 3000);
      if (words(improve) < MIN_IMPROVE) return json({ error: `Tell us what you could do to keep improving (at least ${MIN_IMPROVE} words).` }, 400);
      const ngs = (Array.isArray(body.new_goals) ? body.new_goals : []).slice(0, NEW_GOALS)
        .map((g: any) => ({ area_id: clean(g.area_id, 40) || null, area_title: clean(g.area_title, 120) || null, goal: clean(g.goal, 1000) })).filter((g: any) => g.goal);
      if (ngs.length < NEW_GOALS) return json({ error: `Add ${NEW_GOALS} things you want to work on next week.` }, 400);
      if (ngs.some((g: any) => words(g.goal) < MIN_NEW)) return json({ error: `Each new goal needs at least ${MIN_NEW} words.` }, 400);
      const kept = results.filter((r) => r.keep).length;
      if (kept + ngs.length > MAX_OPEN) return json({ error: `That would give you ${kept + ngs.length} open goals. Keep it to ${MAX_OPEN}: untick "keep working on this" on one you're letting go.` }, 400);
      const now = new Date().toISOString();
      for (const r of results) {
        if (r.result === "done") await supa.from("staff_goals").update({ status: "done", closed_at: now, updated_at: now }).eq("id", r.goal_id);
        else if (!r.keep) await supa.from("staff_goals").update({ status: "dropped", closed_at: now, updated_at: now }).eq("id", r.goal_id);
      }
      await supa.from("staff_goals").insert(ngs.map((g: any) => ({ ...g, evaluation_id: c.evaluation_id, employee_name: c.employee_name, role_key: c.role_key, set_by: "employee" })));
      await supa.from("staff_checkins").update({ status: "submitted", submitted_at: now, results, focus_note: focusNote || null, improve, new_goals: ngs, goals_shown: goals.map(goalOut) }).eq("id", c.id);
      return json({ ...head, status: "submitted", submitted_at: now, results, focus_note: focusNote || null, improve, new_goals: ngs, goals_now: (await goalsFor(c.employee_name)).map(goalOut) });
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ALLOWED_ROLES.includes(role)) return json({ error: "Your login can't manage check-ins." }, 403);
    const week = /^\d{4}-\d{2}-\d{2}$/.test(String(body.week_of || "")) ? String(body.week_of) : mondayOf();

    if (action === "admin_goals") return json({ goals: (await goalsFor(String(body.name || ""), true)).map(goalOut) });

    if (action === "admin_goal_save") {
      const now = new Date().toISOString();
      if (body.id) {
        const upd: Record<string, unknown> = { updated_at: now };
        if (typeof body.goal === "string") { if (words(body.goal) < 3) return json({ error: "Goal is too short." }, 400); upd.goal = clean(body.goal, 1000); }
        if (["active", "done", "dropped"].includes(body.status)) { upd.status = body.status; upd.closed_at = body.status === "active" ? null : now; }
        const { error } = await supa.from("staff_goals").update(upd).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
      } else {
        if (words(body.goal) < 3) return json({ error: "Write the goal first." }, 400);
        const { error } = await supa.from("staff_goals").insert({ evaluation_id: body.evaluation_id || null, employee_name: clean(body.name, 120), role_key: clean(body.role_key, 20) || null, area_id: clean(body.area_id, 40) || null, area_title: clean(body.area_title, 120) || null, goal: clean(body.goal, 1000), set_by: "mgmt" });
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true, goals: (await goalsFor(String(body.name || ""), true)).map(goalOut) });
    }

    if (action === "admin_focus") {
      const prev = addDays(week, -7);
      const { data } = await supa.from("staff_weekly_focus").select("*").in("week_of", [week, prev]);
      const cur: Record<string, string> = {}, last: Record<string, string> = {};
      for (const r of data ?? []) (r.week_of === week ? cur : last)[r.role_key] = r.text;
      return json({ week_of: week, focus: cur, last_week: last, roles: ROLES, role_names: ROLE_NAMES });
    }

    if (action === "admin_focus_set") {
      const rk = String(body.role_key || "");
      if (!ROLES.includes(rk)) return json({ error: "Unknown role" }, 400);
      const text = clean(body.text, 1000);
      if (!text) { await supa.from("staff_weekly_focus").delete().eq("role_key", rk).eq("week_of", week); return json({ ok: true }); }
      const { error } = await supa.from("staff_weekly_focus").upsert({ role_key: rk, week_of: week, text, set_by: clean(body.set_by, 80) || null, updated_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "admin_due") {
      const { data: goals } = await supa.from("staff_goals").select("employee_name,role_key,evaluation_id").eq("status", "active");
      const { data: sent } = await supa.from("staff_checkins").select("employee_name").eq("week_of", week).neq("status", "voided");
      const done = new Set((sent ?? []).map((s: any) => s.employee_name.toLowerCase()));
      const people = new Map<string, any>();
      for (const g of goals ?? []) {
        const k = g.employee_name.toLowerCase();
        if (done.has(k)) continue;
        const p = people.get(k) || { name: g.employee_name, role_key: g.role_key, evaluation_id: g.evaluation_id, goals: 0 };
        p.goals++; people.set(k, p);
      }
      const list = [...people.values()];
      for (const p of list) {
        const { data: e } = await supa.from("staff_evaluations").select("id,employee_email,employee_phone,role_key").ilike("employee_name", p.name).neq("status", "voided").order("created_at", { ascending: false }).limit(1);
        const ev = (e ?? [])[0];
        if (ev) { p.email = ev.employee_email; p.phone = ev.employee_phone; p.evaluation_id = ev.id; p.role_key = p.role_key || ev.role_key; }
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      return json({ week_of: week, due: list, already_sent: (sent ?? []).length });
    }

    if (action === "admin_send") {
      const people = Array.isArray(body.people) ? body.people.slice(0, 150) : [];
      if (!people.length) return json({ error: "Pick at least one person." }, 400);
      const results: any[] = [];
      for (const p of people) {
        const name = clean(p.name, 120);
        if (!name) continue;
        const { data: dup } = await supa.from("staff_checkins").select("id").ilike("employee_name", name).eq("week_of", week).neq("status", "voided").limit(1);
        if ((dup ?? []).length) { results.push({ name, error: "Already sent this week" }); continue; }
        const tok = newToken();
        const email = isEmail(p.email) ? String(p.email).trim() : null;
        const focus = await focusFor(p.role_key || null, week);
        const { data: ins, error } = await supa.from("staff_checkins").insert({
          token: tok, evaluation_id: p.evaluation_id || null, employee_name: name, employee_email: email, employee_phone: clean(p.phone, 40) || null,
          role_key: p.role_key || null, week_of: week, focus_text: focus, sent_by: clean(body.sent_by, 80) || null,
        }).select("id").single();
        if (error) { results.push({ name, error: error.message }); continue; }
        let emailed = false;
        if (email) {
          const first = firstName(name);
          emailed = await sendEmail([{ email, firstName: first }], "Your weekly check-in — The Quarry",
            shell("Your weekly check-in", `<p>Hi ${esc(first)},</p><p>Two minutes: tell us how your goals went last week and what you're working on this week.${focus ? ` This week's team focus: <b>${esc(focus)}</b>` : ""}</p>${button(link(tok), "Open my check-in")}<p style="font-size:12px;color:#888;">This link is just for you.</p>`));
        }
        results.push({ id: ins.id, name, email, phone: p.phone || null, link: link(tok), emailed });
      }
      return json({ week_of: week, results });
    }

    if (action === "admin_list") {
      const { data, error } = await supa.from("staff_checkins").select("*").eq("week_of", week).order("employee_name");
      if (error) return json({ error: error.message }, 500);
      return json({ week_of: week, checkins: (data ?? []).map((c: any) => ({ ...c, token: undefined, link: link(c.token) })) });
    }

    if (action === "admin_note") {
      const { data: c } = await supa.from("staff_checkins").select("id,token,employee_name,employee_email,mgr_at").eq("id", body.id).single();
      if (!c) return json({ error: "not found" }, 404);
      const note = clean(body.note, 3000) || null, by = clean(body.by, 80) || null;
      const { error } = await supa.from("staff_checkins").update({ mgr_note: note, mgr_by: by, mgr_at: new Date().toISOString() }).eq("id", c.id);
      if (error) return json({ error: error.message }, 500);
      let emailed = false;
      if (note && !c.mgr_at && isEmail(c.employee_email)) {
        const first = firstName(c.employee_name);
        emailed = await sendEmail([{ email: c.employee_email.trim(), firstName: first }], `${by || "Management"} replied to your check-in — The Quarry`,
          shell("You got a reply", `<p>Hi ${esc(first)},</p><p>${esc(by || "Management")} read your check-in and wrote back:</p><blockquote style="border-left:3px solid #B8933A;margin:12px 0;padding:6px 12px;color:#333;white-space:pre-wrap;">${esc(note)}</blockquote>${button(link(c.token), "Open my check-in")}`));
      }
      return json({ ok: true, emailed });
    }

    if (action === "admin_void") {
      const { error } = await supa.from("staff_checkins").update({ status: "voided" }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (err) {
    console.error("staff-checkins error", err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
