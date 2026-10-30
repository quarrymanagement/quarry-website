// ============================================================================
// Supabase Edge Function: floor-observations
// The Quarry: floor evaluations. Short "win" / "fix" notes a manager writes
// after watching someone on the floor. Separate from staff_evaluations
// (self-evals), which this function only READS for the side-by-side view.
//
// Flow: manager adds a DRAFT -> Matt approves -> employee gets a private email
// (this update on top, scoreboard, full history newest first, Acknowledge
// link). A "marked" item comes back the following week in a follow-up email
// with the person's whole history. 3+ fixes in one category inside 30 days is
// flagged as a repeat in the admin view, the email and the employee page.
//
// verify_jwt = false (custom auth per action).
//   ADMIN  header x-admin-token (verified by verify-admin-password). Roles: owner.
//     admin_meta, admin_roster, admin_list, admin_person, admin_create,
//     admin_update, admin_approve, admin_void, admin_delete, admin_followups
//   PUBLIC token  /floor-notes.html?t=<token>
//     notes_load, notes_ack
//   CRON   header x-cron-key (sha256 must match server_observation_settings
//          'cron_key_sha256'; no row = disabled)
//     cron_followups
//
// Safety: employee_ref 'test:*' rows only ever email management@. Requests
// from a non-production origin (Netlify draft) can't email real staff.
// Tables: server_observations, server_observation_audit, server_observation_settings
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), SQUARE_ACCESS_TOKEN (read-only roster).
// ============================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SQUARE_TOKEN = (Deno.env.get("SQUARE_ACCESS_TOKEN") ?? "").trim();
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ALLOWED_ROLES = ["owner"];
const PROD_ORIGINS = ["https://thequarrystl.com", "https://www.thequarrystl.com"];
const DRAFT_ORIGIN = /^https:\/\/[a-z0-9-]+--roaring-pegasus-444826\.netlify\.app$/;
const REPEAT_N = 3, REPEAT_DAYS = 30;

const CATEGORIES: Record<string, string> = {
  service_steps: "Service steps",
  upsell_menu: "Upsell & menu knowledge",
  speed_attention: "Speed & attentiveness",
  alcohol_id: "Alcohol & ID checks",
  teamwork_sidework: "Teamwork & sidework",
  attendance_appearance: "Attendance & appearance",
  guest_recovery: "Guest recovery",
};
const SHIFTS = ["lunch", "dinner", "brunch", "event", "other"];
const TEST_PEOPLE = [{ name: "TEST Server", email: MANAGEMENT_EMAIL, phone: "", jobs: ["Server (test)"], ref: "test:server", source: "test" }];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const firstName = (n: string) => String(n || "").trim().split(" ")[0];
const isTestRef = (ref: string) => String(ref || "").startsWith("test:");
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fmtDay = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t ? t.slice(0, n) : null; };

function siteFor(req: Request | null): { base: string; prod: boolean } {
  const o = req?.headers.get("origin") || "";
  if (PROD_ORIGINS.includes(o)) return { base: o, prod: true };
  if (DRAFT_ORIGIN.test(o)) return { base: o, prod: false };
  return { base: SITE, prod: !req || !o };   // cron / server-to-server = production links
}
const pageLink = (base: string, tok: string) => `${base}/floor-notes.html?t=${tok}`;

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function adminRole(req: Request): Promise<string | null> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) return null;
  try {
    const r = await fetch(VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", token: tok }) });
    const b = await r.json().catch(() => ({}));
    return b.ok ? (b.role || null) : null;
  } catch (_) { return null; }
}
async function audit(obsId: string | null, ref: string | null, event: string, actor: string, req: Request | null, detail: Record<string, unknown> = {}) {
  await supa.from("server_observation_audit").insert({ observation_id: obsId, employee_ref: ref, event, actor, ip: req ? clientIp(req) : null, detail });
}
async function sendEmail(to: { email: string; firstName?: string }[], subject: string, htmlBody: string): Promise<boolean> {
  try {
    const r = await fetch(SEND_EMAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, htmlBody, recipients: to, fromEmail: MANAGEMENT_EMAIL, fromName: "The Quarry" }) });
    const b = await r.json().catch(() => ({}));
    return r.ok && (b.sent == null || b.sent > 0);
  } catch (e) { console.error("sendEmail failed", e); return false; }
}

// ---------- roster (read-only; same keys as staff-evals) ----------
async function roster() {
  type P = { name: string; email: string; phone: string; jobs: string[]; ref: string; source: string };
  const byName = new Map<string, P>();
  if (SQUARE_TOKEN) {
    try {
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const r = await fetch("https://connect.squareup.com/v2/team-members/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, "Square-Version": "2025-01-23", "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 200, cursor, query: { filter: { status: "ACTIVE" } } }),
        });
        const j = await r.json();
        for (const m of j.team_members ?? []) {
          if (m.is_owner) continue;
          const name = [m.given_name, m.family_name].filter(Boolean).join(" ").trim();
          if (!name) continue;
          const jobs = (m.wage_setting?.job_assignments ?? []).map((x: any) => x.job_title).filter(Boolean);
          byName.set(name.toLowerCase(), { name, email: m.email_address || "", phone: m.phone_number || "", jobs, ref: "sq:" + m.id, source: "square" });
        }
        cursor = j.cursor;
        if (!cursor) break;
      }
    } catch (e) { console.error("square roster failed", e); }
  }
  const { data: staff } = await supa.from("checklist_staff").select("id,name,role,active").eq("active", true).order("name");
  for (const s of staff ?? []) {
    const k = String(s.name || "").trim();
    if (!k || s.role === "manager") continue;
    if (!byName.has(k.toLowerCase())) byName.set(k.toLowerCase(), { name: k, email: "", phone: "", jobs: s.role ? [s.role] : [], ref: "cl:" + s.id, source: "checklist" });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function emailFor(ref: string): Promise<string> {
  if (isTestRef(ref)) return MANAGEMENT_EMAIL;          // test rows: management@ only, ever
  if (!ref.startsWith("sq:") || !SQUARE_TOKEN) return "";
  try {
    const r = await fetch(`https://connect.squareup.com/v2/team-members/${encodeURIComponent(ref.slice(3))}`, {
      headers: { Authorization: `Bearer ${SQUARE_TOKEN}`, "Square-Version": "2025-01-23" },
    });
    const j = await r.json();
    const e = j.team_member?.email_address || "";
    return isEmail(e) ? e.trim() : "";
  } catch (_) { return ""; }
}

// ---------- scoring ----------
function repeats(rows: any[], asOf = todayCT()) {
  const since = addDays(asOf, -REPEAT_DAYS);
  const c: Record<string, number> = {};
  for (const r of rows) if (r.kind === "fix" && r.status !== "voided" && r.observed_on >= since && r.observed_on <= asOf) c[r.category] = (c[r.category] || 0) + 1;
  return Object.entries(c).filter(([, n]) => n >= REPEAT_N).map(([category, count]) => ({ category, label: CATEGORIES[category] || category, count }));
}
function scoreboard(rows: any[]) {
  const live = rows.filter((r) => r.status !== "voided");
  return { wins: live.filter((r) => r.kind === "win").length, fixes: live.filter((r) => r.kind === "fix").length, repeats: repeats(live) };
}
const PUBLIC_COLS = "id,observed_on,shift,observed_by,kind,category,note,comment,marked,followup_due_on,followup_sent_at,status,sent_at,acknowledged_at";
const pub = (r: any) => ({ id: r.id, observed_on: r.observed_on, shift: r.shift, observed_by: r.observed_by, kind: r.kind, category: r.category, category_label: CATEGORIES[r.category] || r.category, note: r.note, comment: r.comment, marked: r.marked, followup_sent_at: r.followup_sent_at, sent_at: r.sent_at, acknowledged_at: r.acknowledged_at });

// ---------- email ----------
const shell = (title: string, inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e6dfd3;border-radius:10px;overflow:hidden;">
     <div style="background:#1A1A1A;padding:18px 22px;"><span style="color:#B8933A;font-family:Georgia,serif;font-weight:bold;letter-spacing:3px;font-size:18px;">THE QUARRY</span></div>
     <div style="padding:22px;color:#222;font-size:15px;line-height:1.5;"><h2 style="margin:0 0 12px;color:#2C1A0E;font-size:19px;">${title}</h2>${inner}</div>
     <div style="padding:12px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">The Quarry · 3960 Highway Z, New Melle, MO 63385 · This note is private to you.</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:22px 0;"><a href="${href}" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a></p>`;
function itemHtml(r: any, big = false) {
  const win = r.kind === "win";
  const tag = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:bold;background:${win ? "#dcf5e3" : "#fdeaea"};color:${win ? "#176b34" : "#a52a1e"};">${win ? "WIN" : "FIX"}</span>`;
  return `<div style="border:1px solid #eee3d2;border-left:4px solid ${win ? "#3a9a5b" : "#c0392b"};border-radius:8px;padding:${big ? "12px 14px" : "9px 12px"};margin:0 0 10px;background:#fff;">
    <div style="font-size:12px;color:#7a6e60;margin-bottom:4px;">${tag} &nbsp;<b style="color:#2C1A0E;">${esc(CATEGORIES[r.category] || r.category)}</b> · ${esc(fmtDay(r.observed_on))}${r.shift ? " · " + esc(r.shift) : ""}</div>
    <div style="font-size:${big ? 15 : 14}px;color:#222;">${esc(r.note)}</div>
    ${r.comment ? `<div style="margin-top:6px;font-size:13.5px;color:#5C3D2E;"><b>Manager comment:</b> ${esc(r.comment)}</div>` : ""}</div>`;
}
function scoreHtml(sb: ReturnType<typeof scoreboard>) {
  const cell = (n: number | string, l: string, c: string) => `<td style="text-align:center;padding:10px;border:1px solid #eee3d2;background:#FBF8F2;"><div style="font-size:22px;font-weight:bold;color:${c};">${n}</div><div style="font-size:11px;color:#7a6e60;text-transform:uppercase;letter-spacing:.5px;">${l}</div></td>`;
  const rep = sb.repeats.length
    ? `<p style="margin:8px 0 0;font-size:13.5px;color:#a52a1e;"><b>Repeating:</b> ${sb.repeats.map((x) => `${esc(x.label)} (${x.count} in ${REPEAT_DAYS} days)`).join(", ")}</p>`
    : `<p style="margin:8px 0 0;font-size:13px;color:#7a6e60;">No repeating fixes right now.</p>`;
  return `<h3 style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#B8933A;margin:22px 0 8px;">Your scoreboard</h3>
    <table style="border-collapse:collapse;width:100%;"><tr>${cell(sb.wins, "Wins", "#176b34")}${cell(sb.fixes, "Fixes", "#a52a1e")}${cell(sb.repeats.length, "Repeating", sb.repeats.length ? "#a52a1e" : "#7a6e60")}</tr></table>${rep}`;
}
function buildEmail(kind: "update" | "followup", name: string, top: any[], history: any[], link: string, test: boolean) {
  const first = esc(firstName(name));
  const sb = scoreboard(history);
  const intro = kind === "update"
    ? `<p>Hi ${first}, here's a note from a manager who watched your shift. Wins are things to keep doing. Fixes are things to work on. Nothing here is a write-up.</p>`
    : `<p>Hi ${first}, last week a manager marked ${top.length === 1 ? "this note" : "these notes"} to check in on again. Take another look, along with your history below.</p>`;
  const head = kind === "update" ? "This update" : "Follow-up from last week";
  const hist = history.length ? history.map((r) => itemHtml(r)).join("") : `<p style="color:#7a6e60;">Nothing yet.</p>`;
  const inner = intro +
    `<h3 style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#B8933A;margin:16px 0 8px;">${head}</h3>${top.map((r) => itemHtml(r, true)).join("")}` +
    scoreHtml(sb) + button(link, "Read & acknowledge") +
    `<h3 style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#B8933A;margin:22px 0 8px;">Full history (newest first)</h3>${hist}` +
    `<p style="font-size:12px;color:#7a6e60;margin-top:16px;">Questions? Talk to a manager on your next shift.</p>`;
  const subject = (test ? "[TEST] " : "") + (kind === "update" ? "Your floor notes from The Quarry" : "Follow-up: your floor notes from last week");
  return { subject, html: shell(kind === "update" ? "Floor notes" : "Floor notes: follow-up", inner) };
}
async function historyFor(ref: string) {
  const { data } = await supa.from("server_observations").select("*").eq("employee_ref", ref).in("status", ["sent", "approved"])
    .order("observed_on", { ascending: false }).order("created_at", { ascending: false }).limit(500);
  return data ?? [];
}

// ---------- weekly follow-up ----------
async function runFollowups(dry: boolean, req: Request | null, actor: string, base: string, allowReal: boolean) {
  const today = todayCT();
  const { data: due } = await supa.from("server_observations").select("*").eq("marked", true).eq("status", "sent")
    .is("followup_sent_at", null).lte("followup_due_on", today).order("observed_on");
  const byRef = new Map<string, any[]>();
  for (const r of due ?? []) { if (!byRef.has(r.employee_ref)) byRef.set(r.employee_ref, []); byRef.get(r.employee_ref)!.push(r); }
  const out: any[] = [];
  for (const [ref, items] of byRef) {
    const test = isTestRef(ref);
    if (!test && !allowReal) { out.push({ name: items[0].employee_name, items: items.length, skipped: "real staff blocked from this origin" }); continue; }
    const email = await emailFor(ref);
    if (!email) { out.push({ name: items[0].employee_name, items: items.length, skipped: "no email on file" }); continue; }
    if (dry) { out.push({ name: items[0].employee_name, items: items.length, would_send: true }); continue; }
    const hist = await historyFor(ref);
    const tok = items[items.length - 1].ack_token;
    const m = buildEmail("followup", items[0].employee_name, items, hist, pageLink(base, tok), test);
    const ok = await sendEmail([{ email, firstName: firstName(items[0].employee_name) }], m.subject, m.html);
    if (ok) {
      await supa.from("server_observations").update({ followup_sent_at: new Date().toISOString(), acknowledged_at: null, updated_at: new Date().toISOString() }).in("id", items.map((x) => x.id));
      for (const it of items) await audit(it.id, ref, "followup_sent", actor, req, {});
    }
    out.push({ name: items[0].employee_name, items: items.length, sent: ok });
  }
  return { today, people: out };
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    // ---------------- PUBLIC (token) ----------------
    if (action === "notes_load" || action === "notes_ack") {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: row } = await supa.from("server_observations").select("id,employee_ref,employee_name,status").eq("ack_token", tok).maybeSingle();
      if (!row || row.status === "voided") return json({ error: "This link isn't valid anymore. Ask a manager." }, 404);
      const hist = await historyFor(row.employee_ref);
      if (action === "notes_ack") {
        const now = new Date().toISOString();
        const ids = hist.filter((r) => !r.acknowledged_at).map((r) => r.id);
        if (ids.length) await supa.from("server_observations").update({ acknowledged_at: now, updated_at: now }).in("id", ids);
        await audit(row.id, row.employee_ref, "acknowledged", "employee", req, { count: ids.length });
        return json({ ok: true, acknowledged_at: now, count: ids.length });
      }
      const fresh = hist.filter((r) => !r.acknowledged_at);
      return json({
        first_name: firstName(row.employee_name),
        update: (fresh.length ? fresh : hist.filter((r) => r.id === row.id)).map(pub),
        followups: hist.filter((r) => r.marked && r.followup_sent_at && !r.acknowledged_at).map(pub),
        scoreboard: scoreboard(hist), history: hist.map(pub),
        acknowledged: fresh.length === 0, categories: CATEGORIES, repeat_rule: { n: REPEAT_N, days: REPEAT_DAYS },
      });
    }

    // ---------------- CRON ----------------
    if (action === "cron_followups") {
      const key = req.headers.get("x-cron-key") || "";
      const { data: s } = await supa.from("server_observation_settings").select("value").eq("key", "cron_key_sha256").maybeSingle();
      if (!s?.value) return json({ ok: false, disabled: true, reason: "follow-up cron not configured" }, 503);
      if (!key || (await sha256(key)) !== s.value) return json({ error: "unauthorized" }, 401);
      return json({ ok: true, ...(await runFollowups(!!body.dry_run, null, "cron", SITE, true)) });
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ALLOWED_ROLES.includes(role)) return json({ error: "Your login can't manage floor evaluations." }, 403);
    const actor = String(body.actor || "").trim().slice(0, 60) || "admin";
    const site = siteFor(req);

    if (action === "admin_meta") return json({ categories: CATEGORIES, shifts: SHIFTS, repeat_rule: { n: REPEAT_N, days: REPEAT_DAYS }, draft_site: !site.prod, today: todayCT() });

    if (action === "admin_roster") {
      const r = (await roster()).map((p) => ({ name: p.name, ref: p.ref, source: p.source, jobs: p.jobs, has_email: isEmail(p.email) }));
      return json({ roster: r.concat(TEST_PEOPLE.map((p) => ({ name: p.name, ref: p.ref, source: p.source, jobs: p.jobs, has_email: true }))) });
    }

    if (action === "admin_list") {
      const { data, error } = await supa.from("server_observations").select("*").neq("status", "voided")
        .order("created_at", { ascending: false }).limit(1500);
      if (error) return json({ error: error.message }, 500);
      const byRef: Record<string, any[]> = {};
      for (const r of data ?? []) (byRef[r.employee_ref] ||= []).push(r);
      const people = Object.entries(byRef).map(([ref, rows]) => ({
        ref, name: rows[0].employee_name, ...scoreboard(rows),
        drafts: rows.filter((r) => r.status === "draft").length,
        marked_open: rows.filter((r) => r.marked && !r.followup_sent_at).length,
        last_on: rows.map((r) => r.observed_on).sort().pop(),
      })).sort((a, b) => (b.repeats.length - a.repeats.length) || String(b.last_on).localeCompare(String(a.last_on)));
      return json({ observations: (data ?? []).map((r) => ({ ...r, ack_token: undefined, employee_email: undefined })), people });
    }

    if (action === "admin_person") {
      const ref = String(body.ref || "");
      if (!ref) return json({ error: "ref required" }, 400);
      const { data: rows } = await supa.from("server_observations").select("*").eq("employee_ref", ref)
        .order("observed_on", { ascending: false }).order("created_at", { ascending: false }).limit(500);
      const name = rows?.[0]?.employee_name || String(body.name || "");
      let q = supa.from("staff_evaluations").select("id,ref_no,role_key,status,sent_at,submitted_at,responded_at,acknowledged_at,self_ratings,mgr_ratings,strengths,focus")
        .neq("status", "voided").order("created_at", { ascending: false }).limit(20);
      q = isTestRef(ref) ? q.eq("employee_ref", "__none__") : q.or(`employee_ref.eq."${ref}",employee_name.ilike."${name.replace(/[,()*%"\\]/g, "")}"`);
      const { data: evals } = await q;
      const { data: aud } = await supa.from("server_observation_audit").select("observation_id,event,actor,detail,created_at").eq("employee_ref", ref).order("created_at", { ascending: false }).limit(100);
      const live = (rows ?? []).filter((r) => r.status !== "voided");
      return json({
        ref, name, observations: (rows ?? []).map((r) => ({ ...r, ack_token: undefined, employee_email: undefined, link: r.ack_token && (r.status === "sent" || r.status === "approved") ? pageLink(site.base, r.ack_token) : null })),
        scoreboard: scoreboard(live), sent_scoreboard: scoreboard(live.filter((r) => r.status === "sent")),
        self_evals: evals ?? [], audit: aud ?? [], has_email: !!(await emailFor(ref)),
      });
    }

    if (action === "admin_create") {
      const ref = String(body.employee_ref || "").trim(), name = String(body.employee_name || "").trim();
      if (!/^(sq|cl|test):[A-Za-z0-9_-]+$/.test(ref) || !name) return json({ error: "Pick someone from the roster." }, 400);
      if (!["win", "fix"].includes(body.kind)) return json({ error: "Pick Win or Fix." }, 400);
      if (!CATEGORIES[body.category]) return json({ error: "Pick a category." }, 400);
      const note = clip(body.note, 4000); if (!note) return json({ error: "Write what you saw." }, 400);
      const observed_on = /^\d{4}-\d{2}-\d{2}$/.test(body.observed_on || "") ? body.observed_on : todayCT();
      const marked = !!body.marked;
      const row = {
        employee_ref: ref, employee_name: name.slice(0, 120), observed_on, shift: SHIFTS.includes(body.shift) ? body.shift : null,
        observed_by: clip(body.observed_by, 60) || actor, kind: body.kind, category: body.category, note, comment: clip(body.comment, 4000),
        marked, followup_due_on: marked ? addDays(observed_on, 7) : null, status: "draft", is_test: isTestRef(ref), created_by: actor,
      };
      const { data, error } = await supa.from("server_observations").insert(row).select("id").single();
      if (error) return json({ error: error.message }, 500);
      await audit(data.id, ref, "created", actor, req, { kind: row.kind, category: row.category, marked });
      return json({ ok: true, id: data.id });
    }

    if (action === "admin_update") {
      const { data: r } = await supa.from("server_observations").select("*").eq("id", String(body.id || "")).maybeSingle();
      if (!r || r.status === "voided") return json({ error: "Not found." }, 404);
      const up: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("comment" in body) up.comment = clip(body.comment, 4000);
      if ("marked" in body) {
        up.marked = !!body.marked;
        if (body.marked && !r.marked) { up.followup_due_on = addDays(r.observed_on, 7); up.followup_sent_at = null; }
        if (!body.marked) up.followup_due_on = null;
      }
      if (r.status === "draft") {   // content edits only before it goes out
        if ("note" in body) { const n = clip(body.note, 4000); if (!n) return json({ error: "Note can't be empty." }, 400); up.note = n; }
        if ("kind" in body && ["win", "fix"].includes(body.kind)) up.kind = body.kind;
        if ("category" in body && CATEGORIES[body.category]) up.category = body.category;
        if ("shift" in body) up.shift = SHIFTS.includes(body.shift) ? body.shift : null;
        if ("observed_on" in body && /^\d{4}-\d{2}-\d{2}$/.test(body.observed_on)) { up.observed_on = body.observed_on; if (r.marked || body.marked) up.followup_due_on = addDays(body.observed_on, 7); }
      }
      const { error } = await supa.from("server_observations").update(up).eq("id", r.id);
      if (error) return json({ error: error.message }, 500);
      await audit(r.id, r.employee_ref, "updated", actor, req, { fields: Object.keys(up).filter((k) => k !== "updated_at") });
      return json({ ok: true });
    }

    if (action === "admin_approve") {
      // Approve drafts and email each person once: their new items on top + scoreboard + history.
      const ids: string[] = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String).filter(Boolean).slice(0, 100);
      if (!ids.length) return json({ error: "Nothing selected." }, 400);
      const { data: rows } = await supa.from("server_observations").select("*").in("id", ids).eq("status", "draft");
      if (!rows?.length) return json({ error: "Those are already approved or gone." }, 400);
      const byRef = new Map<string, any[]>();
      for (const r of rows) { if (!byRef.has(r.employee_ref)) byRef.set(r.employee_ref, []); byRef.get(r.employee_ref)!.push(r); }
      const results: any[] = [];
      for (const [ref, items] of byRef) {
        const test = isTestRef(ref);
        if (!test && !site.prod) { results.push({ name: items[0].employee_name, error: "Draft site: real staff can't be emailed from here." }); continue; }
        const now = new Date().toISOString();
        const email = body.send === false ? "" : await emailFor(ref);
        for (const it of items) {
          it.ack_token = newToken();
          await supa.from("server_observations").update({ status: email ? "sent" : "approved", approved_by: actor, approved_at: now, ack_token: it.ack_token, employee_email: email || null, sent_at: email ? now : null, updated_at: now }).eq("id", it.id);
          await audit(it.id, ref, "approved", actor, req, { emailed: !!email });
          it.status = email ? "sent" : "approved"; it.sent_at = now;
        }
        const link = pageLink(site.base, items[items.length - 1].ack_token);
        if (!email) { results.push({ name: items[0].employee_name, approved: items.length, emailed: false, link, note: "No email on file. Approved; send them the link." }); continue; }
        const hist = await historyFor(ref);
        const m = buildEmail("update", items[0].employee_name, items, hist, link, test);
        const ok = await sendEmail([{ email, firstName: firstName(items[0].employee_name) }], m.subject, m.html);
        if (!ok) {
          await supa.from("server_observations").update({ status: "approved", sent_at: null }).in("id", items.map((x) => x.id));
          for (const it of items) await audit(it.id, ref, "email_failed", actor, req, {});
        } else for (const it of items) await audit(it.id, ref, "emailed", actor, req, {});
        results.push({ name: items[0].employee_name, approved: items.length, emailed: ok, link });
      }
      return json({ ok: true, results });
    }

    if (action === "admin_send_approved") {
      // Retry the email for items that were approved but not sent (no email on file / send failed).
      const ref = String(body.ref || "");
      const test = isTestRef(ref);
      if (!test && !site.prod) return json({ error: "Draft site: real staff can't be emailed from here." }, 403);
      const { data: items } = await supa.from("server_observations").select("*").eq("employee_ref", ref).eq("status", "approved");
      if (!items?.length) return json({ error: "Nothing waiting to send." }, 400);
      const email = await emailFor(ref);
      if (!email) return json({ error: "No email on file for this person. Text them the link." }, 400);
      const now = new Date().toISOString();
      await supa.from("server_observations").update({ status: "sent", sent_at: now, employee_email: email, updated_at: now }).in("id", items.map((x) => x.id));
      const hist = await historyFor(ref);
      const m = buildEmail("update", items[0].employee_name, items, hist, pageLink(site.base, items[items.length - 1].ack_token), test);
      const ok = await sendEmail([{ email, firstName: firstName(items[0].employee_name) }], m.subject, m.html);
      if (!ok) await supa.from("server_observations").update({ status: "approved", sent_at: null }).in("id", items.map((x) => x.id));
      for (const it of items) await audit(it.id, ref, ok ? "emailed" : "email_failed", actor, req, {});
      return json({ ok, sent: ok ? items.length : 0 });
    }

    if (action === "admin_void") {
      const { data: r } = await supa.from("server_observations").select("id,employee_ref").eq("id", String(body.id || "")).maybeSingle();
      if (!r) return json({ error: "Not found." }, 404);
      await supa.from("server_observations").update({ status: "voided", marked: false, updated_at: new Date().toISOString() }).eq("id", r.id);
      await audit(r.id, r.employee_ref, "voided", actor, req, { reason: clip(body.reason, 300) });
      return json({ ok: true });
    }

    if (action === "admin_delete") {   // drafts and test rows only; anything sent is voided instead
      const { data: r } = await supa.from("server_observations").select("id,employee_ref,status,is_test").eq("id", String(body.id || "")).maybeSingle();
      if (!r) return json({ error: "Not found." }, 404);
      if (r.status !== "draft" && !r.is_test) return json({ error: "Only drafts can be deleted. Void it instead." }, 400);
      await supa.from("server_observations").delete().eq("id", r.id);
      await audit(null, r.employee_ref, "deleted", actor, req, { id: r.id, status: r.status });
      return json({ ok: true });
    }

    if (action === "admin_followups") {
      return json({ ok: true, ...(await runFollowups(body.dry_run !== false, req, actor, site.base, site.prod)) });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || "Server error" }, 500);
  }
});
