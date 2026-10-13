// ============================================================================
// Supabase Edge Function: training-tests
// The Quarry — training tests sent to staff by private link.
// Multiple choice is graded on submit and shown to the employee right away;
// written scenario answers go to a manager for review (approve / needs work +
// notes), then the employee's link shows the review.
// ----------------------------------------------------------------------------
// One function, action-routed. verify_jwt = false (custom auth per action).
//
//   ADMIN (header x-admin-token: <quarryAdminToken>, verified by the site's
//   verify-admin-password Netlify function). Roles: owner, events_staff.
//     admin_meta     test catalog (questions incl. answers/rubrics)
//     admin_list     all attempts (summary rows)
//     admin_get      one attempt + audit + that employee's other attempts
//     admin_send     create an attempt, mint a link, optionally email it
//     admin_remind   re-email the link
//     admin_review   save per-question decisions/notes (+ finish = notify)
//     admin_void     void an attempt (link stops working)
//
//   PUBLIC (token, no admin auth) — /training-test.html?t=<token>
//     test_load      the test (no answers) or, once submitted, the results
//     test_submit    grade multiple choice, store written answers
//
// Tables: training_test_attempts, training_test_audit (RLS on, no policies).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto).
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const TEST_URL = Deno.env.get("TRAINING_TEST_URL") || `${SITE}/training-test.html`;
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ALLOWED_ROLES = ["owner", "events_staff"];
const MIN_WORDS = 25;

// ---------------------------------------------------------------------------
// TEST CATALOG — the source of truth. Answers never leave this function until
// the employee submits.
// ---------------------------------------------------------------------------
type MC = { id: string; q: string; options: string[]; answer: number; why: string };
type Open = { id: string; title: string; scenario: string; ask: string; lookFor: string[] };
type Test = { key: string; version: number; title: string; intro: string; passMc: number; mc: MC[]; open: Open[] };

const SERVER_TEST: Test = {
  key: "server",
  version: 1,
  title: "Server Test",
  intro:
    "Two parts. Part 1 is multiple choice and you'll see your score as soon as you submit. Part 2 is real situations from a busy night at The Quarry. Answer them the way you'd actually handle it on the floor, step by step, in detail. A manager reviews Part 2 and leaves you notes.",
  passMc: 90,
  mc: [
    { id: "m1", q: "A new table just sat in your section. How fast do they need to be greeted?", options: ["Within 30 seconds", "Within 1 minute", "Within 3 minutes", "When you finish what you're doing"], answer: 1, why: "Every new table is greeted within 1 minute — even if it's just \"Hi, I'll be right with you.\"" },
    { id: "m2", q: "How fast should drinks be on the table after you take the order?", options: ["Within 5 minutes", "Within 10 minutes", "With the food", "Whenever the bar gets to them"], answer: 0, why: "Drinks down within 5 minutes. If the bar is behind, tell the table before they ask." },
    { id: "m3", q: "Food just landed on your table. When do you check back?", options: ["When they wave you down", "Within 2 minutes", "When you drop the check", "Only if they look unhappy"], answer: 1, why: "Check back within 2 minutes: \"How is everything tasting?\"" },
    { id: "m4", q: "Your section is caught up for a minute. Where should you be?", options: ["At the service station, ready for the next table", "In server alley, out of the way", "On the floor helping the team — running, bussing, filling waters", "In the kitchen checking on your food"], answer: 2, why: "There's always something to be doing. No standing at the service station or in server alley." },
    { id: "m5", q: "When is it OK to ring an order at the terminal instead of your handheld?", options: ["Whenever it's faster", "When the table is in a hurry", "Only to close out a check, or when no handheld is available", "Any time you're near the service station"], answer: 2, why: "Every order goes on the handheld. The terminal is a last resort." },
    { id: "m6", q: "You're heading into the building and your items aren't ready yet. What do you do?", options: ["Wait in the kitchen until they're up", "Run someone else's food or drinks that are up, then get back to the floor", "Chat at the service station until they're ready", "Go back out and check later"], answer: 1, why: "The building is in and out only. If yours aren't up, run someone else's." },
    { id: "m7", q: "Four drinks are sitting on the bar counter. None of them are yours. What do you do?", options: ["Leave them — their server will grab them", "Tell the bartender they're dying", "Find out where they go and run them", "Run them only if you're not busy"], answer: 2, why: "Drinks on the counter are everyone's. Run them." },
    { id: "m8", q: "You walk past a table that isn't yours, covered in empty plates and glasses. What do you do?", options: ["Tell their server", "Bus it on your way", "Leave it for the busser", "Nothing — it's not your section"], answer: 1, why: "Full hands in, full hands out. \"Not my table\" doesn't exist." },
    { id: "m9", q: "Walking back into the kitchen with nothing in your hands is…", options: ["Fine if you're just checking on food", "Fine on a slow night", "Never OK — grab empties on the way", "Fine if a manager is around"], answer: 2, why: "Never walk in or out empty-handed." },
    { id: "m10", q: "A guest at another server's table is upset and flags you down. Whose problem is it?", options: ["Their server's", "The manager's", "Yours — own it, get help, and follow up", "Nobody's until they ask their server"], answer: 2, why: "A frustrated guest is the #1 priority, your table or not." },
    { id: "m11", q: "The kitchen is running 15 minutes behind on your table's food. When do you tell them?", options: ["Before they have to ask", "When they ask", "When the food comes out", "Only if it goes past 20 minutes"], answer: 0, why: "Over-communicate. The guest should never have to ask where their food is." },
    { id: "m12", q: "A guest is angry about their meal. What's the right first move?", options: ["Wait for a manager before going back to the table", "Avoid the table until the food is fixed", "Go to them right away, apologize, own it, and fix it — then go above and beyond", "Explain why the kitchen is behind tonight"], answer: 2, why: "Never hide from an upset table. Kill them with kindness and over-deliver." },
    { id: "m13", q: "A guest asks if a dish is safe for their allergy and you're not 100% sure. What do you do?", options: ["Say it should be fine", "Tell them to order something else", "Never guess — check with the kitchen and a manager, flag the ticket, then come back with a clear answer", "Let the kitchen figure it out when the ticket comes in"], answer: 2, why: "Never guess on an allergy." },
    { id: "m14", q: "Which of these should you mention when you greet a table?", options: ["Tonight's special, upcoming events and golf", "Only the drink menu", "Nothing — wait for them to ask", "The wait time in the kitchen"], answer: 0, why: "Talk up specials, events and golf at every greet." },
    { id: "m15", q: "What do you do before leaving the floor for any reason?", options: ["Nothing if it's quick", "Tell another server", "Tell a manager or owner", "Tell the host"], answer: 2, why: "Always tell a manager or owner before you leave the floor." },
  ],
  open: [
    { id: "o1", title: "Drinks on the counter", scenario: "Friday, 7:15 PM. You're walking back from dropping a check. Four drinks are sitting on the bar counter. They aren't yours and the bartender is buried. Your own Table 23 just sat.", ask: "Walk us through exactly what you do, step by step.", lookFor: ["Runs the drinks — finds out the table", "Still greets Table 23 within 1 minute", "Never walks past drinks on the counter", "Full hands both ways"] },
    { id: "o2", title: "A table full of dishes", scenario: "You walk past Table 14. It's not your section. It's covered in empty glasses, plates and napkins, and the guests are still sitting there talking.", ask: "What do you do and what do you say to the guests?", lookFor: ["Buses it on the way, without being asked", "Polite, quiet clearing (\"May I take these?\")", "Offers something (another round, waters) or tells their server", "Treats it as their table"] },
    { id: "o3", title: "Another table asks you for something", scenario: "You're carrying food to your table. A guest at another server's table stops you: \"Can we get some ranch and another round?\" Your hands are full.", ask: "How do you handle it, start to finish?", lookFor: ["Acknowledges them right away — never ignores", "Delivers the food, then comes straight back", "Gets the ranch / rings or relays the round", "Tells their server and follows up"] },
    { id: "o4", title: "An angry guest", scenario: "A guest at your Table 31 is upset. Their food took 30 minutes and the order came out wrong. You also have two other tables waiting on you.", ask: "Exactly what do you say and do? Tell us how you turn this table around.", lookFor: ["Goes to the table right away — doesn't hide", "Sincere apology, no excuses", "Fixes it fast and brings in a manager", "Goes above and beyond (kills them with kindness)", "Keeps other tables informed / gets help"] },
    { id: "o5", title: "The kitchen is backed up", scenario: "Expo says tickets are 25 minutes out. You have four tables: one has waited 20 minutes for food, one just ordered, one just sat, and one wants the check.", ask: "Walk us through your next 10 minutes. Who do you go to first and what do you say?", lookFor: ["Greets the new table within 1 minute", "Updates the waiting tables before they ask, with an honest time", "Drops the check promptly", "Apologizes and offers something extra", "Checks back often"] },
    { id: "o6", title: "You made a mistake", scenario: "You forgot to ring in a guest's appetizer. Fifteen minutes later they ask where it is.", ask: "What do you say and what do you do?", lookFor: ["Owns the mistake honestly", "Apologizes", "Gets it fired right away / tells the kitchen and a manager", "Over-communicates timing and checks back", "Goes above and beyond to make it right"] },
    { id: "o7", title: "Caught up while a teammate is buried", scenario: "It's a slow stretch and your tables are fine. Another server is clearly in the weeds.", ask: "What do you do for the next 10 minutes? Be specific.", lookFor: ["Stays on the floor — not the service station", "Runs food and drinks, buses, fills waters", "Checks on the other server's tables", "Asks the server what they need"] },
    { id: "o8", title: "Going above and beyond", scenario: "A couple is celebrating an anniversary at one of your tables on a Saturday night.", ask: "What would you do to make it a night they leave a 5-star review about? Be specific to The Quarry.", lookFor: ["Specific, personal touches", "Uses The Quarry — wine, golf, events, the view", "Over-attentive without hovering", "Invites them back"] },
  ],
};
const TESTS: Record<string, Test> = { server: SERVER_TEST };

// ---------------------------------------------------------------------------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
const newToken = () => crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const words = (s: string) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
const link = (tok: string) => `${TEST_URL}?t=${tok}`;
const SUMMARY =
  "id,ref_no,test_key,status,employee_name,employee_position,employee_email,sent_by,delivery,sent_at,opened_at,submitted_at,mc_score,mc_total,overall_decision,reviewed_by,reviewed_at,created_at";

async function adminRole(req: Request): Promise<string | null> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) return null;
  try {
    const r = await fetch(VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", token: tok }) });
    const b = await r.json().catch(() => ({}));
    return b.ok ? (b.role || null) : null;
  } catch (_) { return null; }
}
async function audit(id: string, event: string, actor: string, req: Request | null, detail: Record<string, unknown> = {}) {
  await supa.from("training_test_audit").insert({ attempt_id: id, event, actor, ip: req ? clientIp(req) : null, user_agent: req ? req.headers.get("user-agent") : null, detail });
}
async function sendEmail(to: { email: string; firstName?: string }[], subject: string, htmlBody: string) {
  try {
    const r = await fetch(SEND_EMAIL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, htmlBody, recipients: to, fromEmail: MANAGEMENT_EMAIL, fromName: "The Quarry" }) });
    return r.ok;
  } catch (e) { console.error("sendEmail failed", e); return false; }
}
const shell = (title: string, inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e6dfd3;border-radius:10px;overflow:hidden;">
     <div style="background:#1A1A1A;padding:18px 22px;"><span style="color:#B8933A;font-family:Georgia,serif;font-weight:bold;letter-spacing:3px;font-size:18px;">THE QUARRY</span></div>
     <div style="padding:22px;color:#222;font-size:15px;line-height:1.5;"><h2 style="margin:0 0 12px;color:#2C1A0E;font-size:19px;">${title}</h2>${inner}</div>
     <div style="padding:12px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">The Quarry · 3960 Highway Z, New Melle, MO 63385</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:22px 0;"><a href="${href}" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a></p>`;

async function emailInvite(a: any, reminder = false) {
  if (!isEmail(a.employee_email)) return false;
  const t = TESTS[a.test_key];
  const first = String(a.employee_name || "").split(" ")[0];
  return await sendEmail([{ email: a.employee_email.trim(), firstName: first }],
    `${reminder ? "Reminder: " : ""}Your ${t.title} — The Quarry`,
    shell(reminder ? "Reminder: your test is waiting" : `Your ${t.title}`,
      `<p>Hi ${esc(first)},</p><p>Here's your ${esc(t.title.toLowerCase())}. It takes about 20–30 minutes. Part 1 is multiple choice and you'll see your score right away. Part 2 is real situations — answer in detail, the way you'd actually handle it. A manager will review it and leave you notes.</p>${button(link(a.token), "Start the test")}<p style="font-size:12px;color:#888;">This link is just for you.</p>`));
}

// What the employee sees once submitted (MC answers revealed; reviews only once reviewed).
function resultsFor(a: any) {
  const t = TESTS[a.test_key];
  const reviewed = a.status === "reviewed";
  return {
    mc: t.mc.map((q) => ({ id: q.id, q: q.q, options: q.options, chosen: a.mc_answers?.[q.id] ?? null, answer: q.answer, correct: a.mc_answers?.[q.id] === q.answer, why: q.why })),
    mc_score: a.mc_score, mc_total: a.mc_total, mc_pct: a.mc_total ? Math.round((100 * a.mc_score) / a.mc_total) : 0, pass_mc: t.passMc,
    open: t.open.map((o) => ({
      id: o.id, title: o.title, scenario: o.scenario, ask: o.ask, answer: a.open_answers?.[o.id] || "",
      review: reviewed ? (a.reviews?.[o.id] || null) : null,
    })),
    overall_decision: reviewed ? a.overall_decision : null, overall_note: reviewed ? a.overall_note : null,
    reviewed_by: reviewed ? a.reviewed_by : null, reviewed_at: reviewed ? a.reviewed_at : null,
  };
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    // ---------------- PUBLIC ----------------
    if (action === "test_load" || action === "test_submit") {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: a } = await supa.from("training_test_attempts").select("*").eq("token", tok).single();
      if (!a) return json({ error: "This link isn't valid." }, 404);
      if (a.status === "voided") return json({ error: "This test was withdrawn. Ask a manager for a new link.", voided: true }, 410);
      const t = TESTS[a.test_key];
      const head = { ref_no: a.ref_no, employee_name: a.employee_name, status: a.status, title: t.title, intro: t.intro, min_words: MIN_WORDS, submitted_at: a.submitted_at };

      if (action === "test_load") {
        if (a.status === "submitted" || a.status === "reviewed") return json({ ...head, results: resultsFor(a) });
        if (a.status === "sent") {
          const now = new Date().toISOString();
          await supa.from("training_test_attempts").update({ status: "in_progress", opened_at: now, updated_at: now }).eq("id", a.id).eq("status", "sent");
          await audit(a.id, "opened", "employee", req);
        }
        return json({
          ...head,
          test: {
            mc: t.mc.map((q) => ({ id: q.id, q: q.q, options: q.options })),
            open: t.open.map((o) => ({ id: o.id, title: o.title, scenario: o.scenario, ask: o.ask })),
          },
        });
      }

      // test_submit
      if (a.status === "submitted" || a.status === "reviewed") return json({ error: "This test was already submitted.", done: true }, 409);
      const mcIn = body.mc || {}, openIn = body.open || {};
      const mc: Record<string, number> = {};
      let score = 0;
      for (const q of t.mc) {
        const v = Number(mcIn[q.id]);
        if (!Number.isInteger(v) || v < 0 || v >= q.options.length) return json({ error: "Answer every multiple choice question." }, 400);
        mc[q.id] = v;
        if (v === q.answer) score++;
      }
      const open: Record<string, string> = {};
      for (const o of t.open) {
        const txt = String(openIn[o.id] || "").trim().slice(0, 4000);
        if (words(txt) < MIN_WORDS) return json({ error: `"${o.title}" needs more detail — at least ${MIN_WORDS} words.` }, 400);
        open[o.id] = txt;
      }
      const now = new Date().toISOString();
      await supa.from("training_test_attempts").update({
        status: "submitted", submitted_at: now, updated_at: now, mc_answers: mc, mc_score: score, mc_total: t.mc.length, open_answers: open,
        submit_ip: clientIp(req), submit_user_agent: req.headers.get("user-agent"),
      }).eq("id", a.id).in("status", ["sent", "in_progress"]);
      await audit(a.id, "submitted", "employee", req, { mc_score: score, mc_total: t.mc.length });
      const pct = Math.round((100 * score) / t.mc.length);
      await sendEmail([{ email: MANAGEMENT_EMAIL, firstName: "Quarry Management" }],
        `${a.employee_name} submitted the ${t.title} (${a.ref_no}) — ready for review`,
        shell("Test ready for review", `<p><strong>${esc(a.employee_name)}</strong> submitted the ${esc(t.title)}.</p><p>Multiple choice: <strong>${score}/${t.mc.length} (${pct}%)</strong>. ${t.open.length} written answers are waiting for your review in Admin › Team › Training Tests.</p>${button(SITE + "/admin/", "Open admin")}`));
      const { data: fresh } = await supa.from("training_test_attempts").select("*").eq("id", a.id).single();
      return json({ ...head, status: "submitted", submitted_at: now, results: resultsFor(fresh) });
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ALLOWED_ROLES.includes(role)) return json({ error: "Your login can't manage training tests." }, 403);
    const actor = role === "owner" ? "admin" : role;

    if (action === "admin_meta") return json({ tests: TESTS, min_words: MIN_WORDS });

    if (action === "admin_list") {
      const { data, error } = await supa.from("training_test_attempts").select(SUMMARY).order("created_at", { ascending: false }).limit(1000);
      if (error) return json({ error: error.message }, 500);
      return json({ attempts: data });
    }

    if (action === "admin_get") {
      const { data: a } = await supa.from("training_test_attempts").select("*").eq("id", body.id).single();
      if (!a) return json({ error: "not found" }, 404);
      const { data: auditRows } = await supa.from("training_test_audit").select("*").eq("attempt_id", a.id).order("created_at");
      const { data: history } = await supa.from("training_test_attempts").select(SUMMARY)
        .ilike("employee_name", String(a.employee_name).replace(/[%_\\]/g, (c: string) => "\\" + c)).neq("id", a.id).order("created_at", { ascending: false });
      return json({ attempt: a, audit: auditRows, history, link: link(a.token) });
    }

    if (action === "admin_send") {
      const f = body.fields || {};
      const name = String(f.employee_name || "").trim();
      if (!name) return json({ error: "Missing: employee name" }, 400);
      const key = String(f.test_key || "server");
      if (!TESTS[key]) return json({ error: "Unknown test" }, 400);
      const email = String(f.employee_email || "").trim();
      if (email && !isEmail(email)) return json({ error: "That email doesn't look right." }, 400);
      const tok = newToken();
      const row = {
        token: tok, test_key: key, test_version: TESTS[key].version, employee_name: name.slice(0, 120),
        employee_email: email || null, employee_phone: String(f.employee_phone || "").trim() || null,
        employee_position: String(f.employee_position || "").trim() || null, employee_ref: f.employee_ref || null,
        sent_by: String(f.sent_by || "").trim() || null, delivery: String(f.delivery || "link"),
      };
      const { data: ins, error } = await supa.from("training_test_attempts").insert(row).select("*").single();
      if (error) return json({ error: error.message }, 500);
      await audit(ins.id, "sent", actor, req, { delivery: row.delivery, by: row.sent_by });
      let emailed = false;
      if (row.delivery === "email") {
        emailed = await emailInvite(ins);
        if (emailed) await audit(ins.id, "emailed", actor, req, { to: email });
      }
      return json({ id: ins.id, ref_no: ins.ref_no, link: link(tok), emailed });
    }

    if (action === "admin_remind") {
      const { data: a } = await supa.from("training_test_attempts").select("*").eq("id", body.id).single();
      if (!a || !["sent", "in_progress"].includes(a.status)) return json({ error: "Only tests that haven't been submitted can be re-sent." }, 409);
      if (body.email_override && isEmail(body.email_override)) {
        await supa.from("training_test_attempts").update({ employee_email: body.email_override.trim() }).eq("id", a.id);
        a.employee_email = body.email_override.trim();
      }
      const ok = await emailInvite(a, true);
      if (!ok) return json({ error: "No valid email on file. Copy the link and text it instead." }, 400);
      await audit(a.id, "reminded", actor, req, { to: a.employee_email });
      return json({ ok: true });
    }

    if (action === "admin_review") {
      const { data: a } = await supa.from("training_test_attempts").select("*").eq("id", body.id).single();
      if (!a) return json({ error: "not found" }, 404);
      if (!["submitted", "reviewed"].includes(a.status)) return json({ error: "This test hasn't been submitted yet." }, 409);
      const t = TESTS[a.test_key];
      const inRev = body.reviews || {};
      const reviews: Record<string, { decision: string | null; note: string }> = {};
      for (const o of t.open) {
        const r = inRev[o.id] || {};
        const d = ["approved", "needs_work"].includes(r.decision) ? r.decision : null;
        reviews[o.id] = { decision: d, note: String(r.note || "").trim().slice(0, 3000) };
      }
      const finish = !!body.finish;
      const overall = ["passed", "retake"].includes(body.overall_decision) ? body.overall_decision : null;
      if (finish) {
        const missing = t.open.filter((o) => !reviews[o.id].decision).map((o) => o.title);
        if (missing.length) return json({ error: "Approve or mark needs work on every answer first: " + missing.join(", ") }, 400);
        if (!overall) return json({ error: "Choose Passed or Retake before finishing." }, 400);
      }
      const now = new Date().toISOString();
      const upd: Record<string, unknown> = {
        reviews, overall_decision: overall, overall_note: String(body.overall_note || "").trim().slice(0, 5000) || null,
        reviewed_by: String(body.reviewed_by || "").trim() || a.reviewed_by || null, updated_at: now,
      };
      if (finish) { upd.status = "reviewed"; upd.reviewed_at = now; }
      const { error } = await supa.from("training_test_attempts").update(upd).eq("id", a.id);
      if (error) return json({ error: error.message }, 500);
      await audit(a.id, finish ? "reviewed" : "review_saved", actor, req, finish ? { overall } : {});
      let emailed = false;
      if (finish && isEmail(a.employee_email)) {
        const first = String(a.employee_name).split(" ")[0];
        emailed = await sendEmail([{ email: a.employee_email.trim(), firstName: first }],
          `Your ${t.title} has been reviewed — The Quarry`,
          shell("Your test has been reviewed", `<p>Hi ${esc(first)},</p><p>${overall === "passed" ? "Nice work — you passed." : "Your manager left notes and would like you to take it again."} Open your results to see the notes on each answer.</p>${button(link(a.token), "See my results")}`));
        if (emailed) await audit(a.id, "emailed", actor, req, { to: a.employee_email, kind: "review" });
      }
      return json({ ok: true, status: finish ? "reviewed" : a.status, emailed, link: link(a.token) });
    }

    if (action === "admin_void") {
      const now = new Date().toISOString();
      const { error } = await supa.from("training_test_attempts").update({ status: "voided", void_reason: String(body.reason || "").trim() || null, updated_at: now }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      await audit(body.id, "voided", actor, req, { reason: body.reason || "" });
      return json({ ok: true });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    console.error("training-tests error", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
