// ============================================================================
// Supabase Edge Function: callin-reservation
// The Quarry: phone-in reservation requests typed on the staff iPads
// (quarry-checklist.netlify.app/callin.html), so nothing lives on paper.
// Saves a row in callin_reservations FIRST, then emails management@ through
// the site's send-email function. If the email fails the row is still saved.
//
// verify_jwt = false.
//   PUBLIC (iPad page; origin must be quarry-checklist or one of its drafts)
//     submit         name + phone required; taken_by_staff_id must be an
//                    active checklist_staff person. Honeypot + min fill time +
//                    per-IP and global rate limits.
//   ADMIN  header x-admin-token (verify-admin-password). Roles: owner, events_staff.
//     admin_list     recent call-ins
//     admin_status   set new / followed_up
// A guest name starting with "TEST" marks the row is_test and the subject [TEST].
// Tables: callin_reservations (RLS on, no policies), checklist_staff (read).
// ============================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ADMIN_ROLES = ["owner", "events_staff"];
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+--)?quarry-checklist\.netlify\.app$/;
const ADMIN_ORIGIN_OK = /^https:\/\/((www\.)?thequarrystl\.com|[a-z0-9-]+--roaring-pegasus-444826\.netlify\.app)$/;
const PER_IP_10MIN = 8, GLOBAL_PER_HOUR = 40;

const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": ORIGIN_OK.test(origin) || ADMIN_ORIGIN_OK.test(origin) ? origin : "https://quarry-checklist.netlify.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t ? t.slice(0, n) : null; };
const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
const fmtPhone = (p: string) => { const d = p.replace(/\D/g, ""); const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d; return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : p; };
const fmtDay = (d: string | null) => d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
const fmtTime = (t: string | null) => { if (!t) return ""; const m = /^(\d{1,2}):(\d{2})$/.exec(t); if (!m) return t; let h = +m[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };

async function adminRole(req: Request): Promise<string | null> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) return null;
  try {
    const r = await fetch(VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", token: tok }) });
    const b = await r.json().catch(() => ({}));
    return b.ok ? (b.role || null) : null;
  } catch (_) { return null; }
}
async function sendEmail(subject: string, htmlBody: string): Promise<string | null> {
  try {
    const r = await fetch(SEND_EMAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, htmlBody, recipients: [{ email: MANAGEMENT_EMAIL, firstName: "Management" }], fromEmail: MANAGEMENT_EMAIL, fromName: "The Quarry iPad" }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return `send-email ${r.status}`;
    if (b.sent === 0) return "send-email sent 0";
    return null;
  } catch (e) { return String((e as Error).message || e).slice(0, 200); }
}
function emailHtml(r: any) {
  const row = (k: string, v: string) => v ? `<tr><td style="padding:7px 10px;border-bottom:1px solid #eee3d2;color:#7a6e60;font-size:13px;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:7px 10px;border-bottom:1px solid #eee3d2;font-size:15px;color:#222;">${v}</td></tr>` : "";
  const digits = String(r.guest_phone).replace(/[^\d+]/g, "");
  const taken = new Date(r.created_at).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e6dfd3;border-radius:10px;overflow:hidden;">
  <div style="background:#1A1A1A;padding:16px 22px;"><span style="color:#B8933A;font-family:Georgia,serif;font-weight:bold;letter-spacing:3px;font-size:18px;">THE QUARRY</span><span style="color:#ccc;font-size:12px;margin-left:10px;">Call-in reservation #${r.ref_no}</span></div>
  <div style="padding:18px 22px;">
  ${r.is_test ? `<p style="background:#fff4d6;color:#8a5a00;padding:8px 10px;border-radius:6px;font-size:13px;margin:0 0 12px;">TEST submission, not a real guest.</p>` : ""}
  <p style="margin:0 0 12px;font-size:15px;">A guest called in. <b>Please follow up</b> to confirm.</p>
  <table style="border-collapse:collapse;width:100%;">
  ${row("Name", `<b>${esc(r.guest_name)}</b>`)}
  ${row("Phone", `<a href="tel:${esc(digits)}" style="color:#2C1A0E;font-weight:bold;">${esc(fmtPhone(r.guest_phone))}</a>`)}
  ${row("Email", r.guest_email ? `<a href="mailto:${esc(r.guest_email)}">${esc(r.guest_email)}</a>` : "")}
  ${row("Guests", r.guest_count ? esc(r.guest_count) : "")}
  ${row("Date", esc(fmtDay(r.requested_date)))}
  ${row("Time", esc(fmtTime(r.requested_time)))}
  ${row("Catering", r.catering ? "<b>Yes</b>" + (r.catering_notes ? " — " + esc(r.catering_notes) : "") : "No")}
  ${row("Notes", esc(r.notes || "").replace(/\n/g, "<br>"))}
  ${row("Taken by", esc(r.taken_by) + ` <span style="color:#7a6e60;font-size:12px;">· ${esc(taken)}</span>`)}
  </table>
  </div><div style="padding:10px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">Sent from the staff iPad call-in form. Saved in the call-in log (admin) as #${r.ref_no}.</div></div>`;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const CORS = cors(origin);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    if (action === "submit") {
      if (!ORIGIN_OK.test(origin)) return json({ error: "Use the iPad call-in form." }, 403);
      if (String(body.website || "").trim()) return json({ ok: true, ref_no: 0 });            // honeypot: pretend success
      const elapsed = Number(body.elapsed_ms || 0);
      if (!(elapsed >= 2500)) return json({ error: "That was fast. Check the form and tap Send again." }, 400);

      const name = clip(body.guest_name, 120), phone = clip(body.guest_phone, 40);
      if (!name) return json({ error: "Guest name is required.", field: "guest_name" }, 400);
      const digits = String(phone || "").replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) return json({ error: "Enter a phone number we can call back.", field: "guest_phone" }, 400);
      const email = clip(body.guest_email, 200);
      if (email && !isEmail(email)) return json({ error: "That email doesn't look right. Fix it or leave it blank.", field: "guest_email" }, 400);
      const count = body.guest_count === "" || body.guest_count == null ? null : Math.round(Number(body.guest_count));
      if (count != null && !(count >= 1 && count <= 2000)) return json({ error: "Guest count should be a number.", field: "guest_count" }, 400);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.requested_date || "") ? body.requested_date : null;
      const time = clip(body.requested_time, 40);

      const sid = String(body.taken_by_staff_id || "");
      if (!/^[0-9a-f-]{36}$/i.test(sid)) return json({ error: "Pick who took the call.", field: "taken_by" }, 400);
      const { data: staff } = await supa.from("checklist_staff").select("id,name,active").eq("id", sid).maybeSingle();
      if (!staff?.active) return json({ error: "Pick who took the call.", field: "taken_by" }, 400);

      const ip = clientIp(req);
      const since10 = new Date(Date.now() - 10 * 60e3).toISOString(), since60 = new Date(Date.now() - 60 * 60e3).toISOString();
      const [{ count: nIp }, { count: nAll }] = await Promise.all([
        supa.from("callin_reservations").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", since10),
        supa.from("callin_reservations").select("id", { count: "exact", head: true }).gte("created_at", since60),
      ]);
      if ((nIp ?? 0) >= PER_IP_10MIN || (nAll ?? 0) >= GLOBAL_PER_HOUR) return json({ error: "Too many sent just now. Wait a few minutes, or call a manager." }, 429);

      const row = {
        guest_name: name, guest_phone: phone, guest_email: email, guest_count: count, requested_date: date, requested_time: time,
        catering: !!body.catering, catering_notes: body.catering ? clip(body.catering_notes, 2000) : null, notes: clip(body.notes, 4000),
        taken_by: staff.name, taken_by_staff_id: staff.id, is_test: /^TEST\b/.test(name), ip, user_agent: clip(req.headers.get("user-agent"), 300),
      };
      const { data: saved, error } = await supa.from("callin_reservations").insert(row).select("*").single();
      if (error) return json({ error: "Couldn't save. Write it down and tell a manager. (" + error.message + ")" }, 500);

      const when = [saved.requested_date ? fmtDay(saved.requested_date).replace(/, \d{4}$/, "") : "", fmtTime(saved.requested_time)].filter(Boolean).join(" ");
      const subject = (saved.is_test ? "[TEST] " : "") + `Call-in reservation: ${saved.guest_name}` + (saved.guest_count ? `, ${saved.guest_count} guests` : "") + (when ? `, ${when}` : "") + (saved.catering ? " (catering)" : "");
      const err = await sendEmail(subject, emailHtml(saved));
      await supa.from("callin_reservations").update(err ? { email_error: err } : { emailed_at: new Date().toISOString() }).eq("id", saved.id);
      return json({ ok: true, ref_no: saved.ref_no, emailed: !err });
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ADMIN_ROLES.includes(role)) return json({ error: "Your login can't see call-ins." }, 403);

    if (action === "admin_list") {
      const { data, error } = await supa.from("callin_reservations")
        .select("id,ref_no,guest_name,guest_phone,guest_email,guest_count,requested_date,requested_time,catering,catering_notes,notes,taken_by,status,followed_up_at,followed_up_by,emailed_at,email_error,is_test,created_at")
        .order("created_at", { ascending: false }).limit(300);
      if (error) return json({ error: error.message }, 500);
      return json({ callins: data });
    }
    if (action === "admin_status") {
      const st = body.status === "followed_up" ? "followed_up" : "new";
      const { error } = await supa.from("callin_reservations").update({ status: st, followed_up_at: st === "followed_up" ? new Date().toISOString() : null, followed_up_by: st === "followed_up" ? (clip(body.actor, 60) || role) : null }).eq("id", String(body.id || ""));
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error. Write it down and tell a manager." }, 500);
  }
});
