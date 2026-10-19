// ============================================================================
// Supabase Edge Function: staff-evals
// The Quarry — role-specific staff self-evaluations, sent by private link.
//
//   1. Employee rates themselves 1–5 on each policy area for their role, with a
//      real example from a shift, plus three open questions.
//   2. Management rates the same areas on the same scale, leaves a note per
//      area, strengths, and a focus for the next 30 days.
//   3. The employee's same link shows both ratings side by side and asks for a
//      short reflection, then they acknowledge.
//
// Evaluations are NOT disciplinary and never feed write-ups. The page says so.
// ----------------------------------------------------------------------------
// One function, action-routed. verify_jwt = false (custom auth per action).
//
//   ADMIN (header x-admin-token, verified by verify-admin-password). Roles:
//   owner, events_staff.
//     admin_meta       forms + rating scale
//     admin_roster     active staff (Square team + checklist_staff) w/ suggested roles
//     admin_list       all evaluations (summary rows)
//     admin_get        one evaluation + audit + that employee's other evals
//     admin_send       send one form to a list of people (one row + link each)
//     admin_remind     re-email the link
//     admin_metrics    Square/checklist/training numbers for one employee vs peers
//     admin_respond    save management ratings/notes (+ finish = notify employee,
//                      and snapshot the numbers onto the record)
//     admin_void       void (link stops working, record kept)
//     admin_reviews    list guest reviews (Google) for the feedback screen
//     admin_reviews_import  add/refresh reviews (dedup on source+external_id)
//     admin_review_update   management note ("what we're changing"), share, staff tags
//     admin_feedback_preview  the guest-feedback block exactly as staff will see it
//
//   PUBLIC (token) — /staff-eval.html?t=<token>
//     eval_load        the form, or their answers + management response
//     eval_submit      store self-ratings, examples, open answers
//     eval_ack         store the employee's reflection + acknowledgment
//
// Tables: staff_evaluations, staff_evaluation_audit, guest_reviews (RLS on, no policies).
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), SQUARE_ACCESS_TOKEN.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SQUARE_TOKEN = (Deno.env.get("SQUARE_ACCESS_TOKEN") ?? "").trim();
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const EVAL_URL = Deno.env.get("STAFF_EVAL_URL") || `${SITE}/staff-eval.html`;
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ALLOWED_ROLES = ["owner", "events_staff"];
const MIN_EXAMPLE = 8;   // words per area example
const MIN_OPEN = 15;     // words per open question
const MIN_REFLECT = 15;  // words in the final reflection
const FEEDBACK_DAYS = 60; // guest reviews shown on an evaluation look back this far
const FEEDBACK_MAX = 8;

// ---------------------------------------------------------------------------
// RATING SCALE — anchored to how often, so a 4 means the same thing for a
// busser and a bartender.
// ---------------------------------------------------------------------------
const SCALE = [
  { v: 1, label: "Not yet", hint: "I don't do this consistently yet" },
  { v: 2, label: "Some shifts", hint: "I do it when it's slow, not when it's busy" },
  { v: 3, label: "Most shifts", hint: "I do it most of the time, I slip on busy nights" },
  { v: 4, label: "Every shift", hint: "I do this every shift, busy or not" },
  { v: 5, label: "I could train it", hint: "Every shift, and I could teach a new hire to do it" },
];

// ---------------------------------------------------------------------------
// FORMS — the source of truth. Change wording here and bump `version`.
// Each area: the standard (what we expect, shown to the employee) and the
// prompt for their example.
// ---------------------------------------------------------------------------
type Area = { id: string; title: string; standard: string; prompt: string };
type Open = { id: string; q: string };
type Form = { key: string; version: number; title: string; who: string; intro: string; areas: Area[]; open: Open[] };

const OPEN_COMMON: Open[] = [
  { id: "guest", q: "Look at what guests have been saying (the reviews at the start, or what you've heard on the floor). Pick one complaint. What will you personally do differently so it doesn't happen at your tables or your station?" },
  { id: "strong", q: "Where are you strongest right now? Give us a real example from a recent shift." },
  { id: "hardest", q: "Which of these standards is hardest to hit on a busy night, and why? What would make it easier?" },
  { id: "need", q: "What do you need from management (training, tools, scheduling, communication) to do your job better?" },
];
const INTRO =
  "This is your self-evaluation. It is not a test and it is not a write-up. For each standard, rate yourself honestly and give us one real example from a shift. Management rates the same standards, then you'll see both side by side and we'll talk about where to go from here. Honest 3s are more useful to us than 5s across the board.";

const FORMS: Record<string, Form> = {
  server: {
    key: "server", version: 2, title: "Server Self-Evaluation", who: "Servers", intro: INTRO,
    areas: [
      { id: "pace", title: "Greet and pace", standard: "Every new table greeted within 1 minute. Drinks down within 5 minutes. Check back within 2 minutes of food landing.", prompt: "Tell us about a busy stretch: did you hit those times? If not, where did it slip?" },
      { id: "handheld", title: "Handheld ordering", standard: "Every order goes on the handheld at the table. The terminal is only for closing out a check, or when no handheld is available.", prompt: "When was the last time you rang at the terminal instead of the handheld, and why?" },
      { id: "hands", title: "Full hands, in and out", standard: "Never walk into or out of the building empty-handed. The building is in and out. If your items aren't up, run someone else's.", prompt: "Describe what you carried in and out on your last few trips through the building." },
      { id: "team", title: "\"Not my table\" doesn't exist", standard: "Drinks on the counter get run by whoever sees them. Dirty tables get bussed by whoever walks by. A guest at another server's table who flags you is your guest.", prompt: "Give an example of helping a table or a teammate that wasn't yours." },
      { id: "guest", title: "Over-communicate with guests", standard: "Tell the table about a delay before they have to ask. An upset guest is the #1 priority. Go to them right away, apologize, own it, fix it, and bring in a manager. Never hide from a table.", prompt: "Tell us about the last time a table was unhappy or waiting too long. What did you do?" },
      { id: "allergy", title: "Allergies and accuracy", standard: "Never guess on an allergy. Check with the kitchen and a manager, flag the ticket, and come back to the guest with a clear answer.", prompt: "How do you handle an allergy question when you're not 100% sure of the answer?" },
      { id: "sell", title: "Sell The Quarry", standard: "Mention tonight's special, upcoming events and golf at every greet. Invite guests back.", prompt: "What do you actually say at the greet? Write it the way you'd say it." },
      { id: "close", title: "Leaving the floor and cashing out", standard: "Tell a manager or owner before you leave the floor for any reason. Side work and your checklist signed off. Cash settled to the closing manager on the cash-out sheet with both sets of initials.", prompt: "Walk us through how you close out your night." },
    ],
    open: OPEN_COMMON,
  },

  host: {
    key: "host", version: 2, title: "Host Self-Evaluation", who: "Hosts", intro: INTRO,
    areas: [
      { id: "door", title: "Own the door", standard: "Every guest is greeted the moment they walk in. The host stand is never left empty during service without someone covering it.", prompt: "Tell us about a time the door got busy. How fast did guests get greeted?" },
      { id: "rotation", title: "Seating rotation", standard: "Seat sections evenly in rotation. Tell the server every time you seat them. Don't double-seat a section unless that server says they're ready.", prompt: "How do you decide where the next party goes when it's busy?" },
      { id: "wait", title: "Wait times and the waitlist", standard: "Quote honest wait times. Check in with waiting guests before they come to you. Know which tables are about to open.", prompt: "Describe the last time you had a wait. What did you quote and how close was it?" },
      { id: "phone", title: "Phone and reservations", standard: "Never book a phone reservation yourself. Point callers to the website, or take their details and pass them to a manager or owner to confirm.", prompt: "What do you say when someone calls to make a reservation?" },
      { id: "know", title: "Know tonight", standard: "Know tonight's special, upcoming events, golf, and any private-event or wedding closures, so you can answer any guest question at the door.", prompt: "What's coming up at The Quarry in the next two weeks? How do you find out?" },
      { id: "support", title: "Support the floor", standard: "When the door is quiet, help reset tables, refill waters, run menus and help the bussers. Standing at the stand on a slow stretch isn't the job.", prompt: "What do you do when nobody is at the door?" },
      { id: "checklist", title: "Checklist and side work", standard: "Host & Bus board signed off for your shift. Menus clean, stand stocked, entry tidy.", prompt: "Which part of the checklist do you skip or rush most often?" },
    ],
    open: OPEN_COMMON,
  },

  busser: {
    key: "busser", version: 2, title: "Busser Self-Evaluation", who: "Bussers", intro: INTRO,
    areas: [
      { id: "station", title: "Hold your station", standard: "Station 1 is inside, Station 2 is outside. Stay posted in your area until your break. Tell a manager before you leave it.", prompt: "On your last shift, how much of the night were you actually in your station?" },
      { id: "scout", title: "Scout your tables", standard: "Keep eyes on every table in your area. Clear empties as soon as guests are done with them. No table sits dirty.", prompt: "How do you know a table needs you before the server asks?" },
      { id: "reset", title: "Fast resets", standard: "When a table leaves: clear, wipe, reset and tell the host it's ready, fast.", prompt: "Walk us through a reset, start to finish." },
      { id: "servers", title: "Back up the servers", standard: "You're the servers' support. Refill waters, pre-bus, run food when it's up, and ask servers what they need.", prompt: "Give an example of something you did that made a server's night easier." },
      { id: "hands", title: "Full hands, in and out", standard: "Never walk into or out of the building empty-handed.", prompt: "What do you carry out to the floor when you head back out?" },
      { id: "guests", title: "Guest manners", standard: "Clear politely (\"May I take these?\"), never reach over guests, and pass any guest request to their server right away.", prompt: "A guest asks you for something while you're clearing. What do you do?" },
      { id: "checklist", title: "Checklist and closing duties", standard: "Host & Bus board signed off. Closing duties done before you clock out.", prompt: "Which closing duty gets skipped most often, and why?" },
    ],
    open: OPEN_COMMON,
  },

  expo: {
    key: "expo", version: 2, title: "Expo Self-Evaluation", who: "Expo / food runners", intro: INTRO,
    areas: [
      { id: "check", title: "Check every plate", standard: "Every plate is checked against the ticket before it leaves the window: mods, sides, sauces, and allergies.", prompt: "When did you last catch a mistake before it went out? What was it?" },
      { id: "allergy", title: "Allergy tickets", standard: "Allergy tickets are confirmed with the line and handed off clearly. If anything is unclear, stop and get a manager. Never guess.", prompt: "Walk us through what happens when an allergy ticket comes up." },
      { id: "timing", title: "Timing", standard: "A table's food goes out together. Food doesn't die in the window. Call for runners the moment a table is up.", prompt: "Tell us about a night the window backed up. What did you do?" },
      { id: "line", title: "Talk to the line", standard: "Clear, calm calls to the kitchen. When tickets run long, tell the servers so they can warn their tables before the guest asks.", prompt: "How do you let servers know their table's food is running behind?" },
      { id: "present", title: "Presentation", standard: "Rims wiped, garnish right, hot food hot. If it doesn't look right, it goes back.", prompt: "What do you check on a plate in the few seconds before it goes out?" },
      { id: "run", title: "Run it right", standard: "Table and seat numbers on every run. No auctioning food (\"Who had the burger?\"). Pick up empties on the way back.", prompt: "How do you know which guest gets which plate?" },
      { id: "station", title: "Window and checklist", standard: "Window and expo station kept clean and stocked through service. Checklist signed off.", prompt: "What's the state of the window at the end of your shift?" },
    ],
    open: OPEN_COMMON,
  },

  bartender: {
    key: "bartender", version: 2, title: "Bartender Self-Evaluation", who: "Bartenders", intro: INTRO,
    areas: [
      { id: "speed", title: "Bar and service-bar speed", standard: "Bar guests are greeted fast. Server tickets are made promptly. Nothing dies on the counter. If you're buried, call for help.", prompt: "Tell us about the last time you got buried. What happened to the server tickets?" },
      { id: "responsible", title: "Responsible service", standard: "When in doubt, card them. Stop serving a guest who's visibly intoxicated and tell a manager. No overpours.", prompt: "Describe a time you cut someone off or carded someone. How did you handle it?" },
      { id: "recipes", title: "Pours and recipes", standard: "Jigger every pour. Make every cocktail to the recipe as written. Log waste and spills.", prompt: "Which drinks do you free-pour or eyeball, if any?" },
      { id: "ring", title: "Ring everything", standard: "Every drink is rung in Square before it's poured. No free drinks. Comps need a manager's approval.", prompt: "When was the last time a drink went out that wasn't rung? What happened?" },
      { id: "wine", title: "Wine and beer service", standard: "Bottles are presented, opened and poured properly. Beer buckets and bottles go out cold and correct.", prompt: "How do you present and open a bottle of wine for a table?" },
      { id: "sell", title: "Bar guests and selling", standard: "Talk up specials, upcoming events, the wine club and golf. Bar regulars know your name and you know theirs.", prompt: "What do you tell a new bar guest about The Quarry?" },
      { id: "cash", title: "Cash and tabs", standard: "Drawer counted in and out. Tabs closed before you leave. Manager tabs rung correctly. Cash-out follows the procedure.", prompt: "Walk us through how you close your drawer and tabs." },
      { id: "clean", title: "Clean bar and checklist", standard: "Bar stays clean and stocked through service. Opening, hourly and closing tasks on the Bar board signed off.", prompt: "Which checklist task gets skipped most when it's busy?" },
    ],
    open: OPEN_COMMON,
  },

  kitchen: {
    key: "kitchen", version: 2, title: "Kitchen Self-Evaluation", who: "Line, prep and dish", intro: INTRO,
    areas: [
      { id: "safety", title: "Food safety", standard: "Temps checked and logged. Everything labeled and dated. First in, first out. Hands washed and gloves changed between tasks.", prompt: "What's one food-safety step you've seen skipped on a busy night?" },
      { id: "allergy", title: "Allergies", standard: "Allergy tickets get a clean surface, clean tools and a fresh pan. If you're not sure, ask the chef. Never guess.", prompt: "Walk us through how you cook an allergy ticket." },
      { id: "spec", title: "Recipes and plating", standard: "Every plate matches the spec: portion, temp, plating. Taste and check before it goes to the window.", prompt: "Which dish is hardest to keep consistent, and why?" },
      { id: "tickets", title: "Ticket times and calls", standard: "Call back to expo. Say \"behind\" and \"hot\". Tell expo the moment your station is running long so the servers can warn their tables.", prompt: "What do you do when your station falls behind?" },
      { id: "prep", title: "Prep and 86s", standard: "Prep list done to par before service. If something is about to run out, tell the chef and expo right away so it gets 86'd before a server sells it.", prompt: "When did something last run out mid-service? How was it handled?" },
      { id: "clean", title: "Clean as you go", standard: "Station clean through service. Dish keeps up so the line never runs out of plates or pans. Closing checklist signed off.", prompt: "What does your station look like at the end of a Saturday?" },
      { id: "team", title: "One kitchen", standard: "Help the next station when you're caught up, line, prep or dish. No \"that's not my job\".", prompt: "Give an example of jumping in to help another station." },
      { id: "waste", title: "Product and waste", standard: "Store product properly, rotate it, and log waste. Don't throw out what could be used, and don't serve what shouldn't be.", prompt: "How do you handle product that's close to its date?" },
    ],
    open: OPEN_COMMON,
  },
};
const ORDER = ["server", "host", "busser", "expo", "bartender", "kitchen"];

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
const link = (tok: string) => `${EVAL_URL}?t=${tok}`;
const firstName = (n: string) => String(n || "").trim().split(" ")[0];
const SUMMARY =
  "id,ref_no,role_key,status,employee_name,employee_email,employee_phone,sent_by,delivery,batch_id,sent_at,opened_at,submitted_at,responded_by,responded_at,acknowledged_at,self_ratings,mgr_ratings,created_at";

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
  await supa.from("staff_evaluation_audit").insert({ evaluation_id: id, event, actor, ip: req ? clientIp(req) : null, user_agent: req ? req.headers.get("user-agent") : null, detail });
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

async function emailInvite(e: any, reminder = false) {
  if (!isEmail(e.employee_email)) return false;
  const f = FORMS[e.role_key];
  const first = firstName(e.employee_name);
  return await sendEmail([{ email: e.employee_email.trim(), firstName: first }],
    `${reminder ? "Reminder: " : ""}Your ${f.title} — The Quarry`,
    shell(reminder ? "Reminder: your self-evaluation is waiting" : `Your ${f.title}`,
      `<p>Hi ${esc(first)},</p><p>We want to hear how you think you're doing. Rate yourself on each of our ${f.who.toLowerCase()} standards and give us a real example from a shift. It takes about 10–15 minutes on your phone.</p><p>This isn't a test or a write-up. Management will rate the same standards and respond, and you'll see both on this same link.</p>${button(link(e.token), "Start my evaluation")}<p style="font-size:12px;color:#888;">This link is just for you.</p>`));
}

// What the employee sees after they submit.
function viewFor(e: any) {
  const f = FORMS[e.role_key];
  const responded = e.status === "responded" || e.status === "acknowledged";
  return {
    areas: f.areas.map((a) => ({
      id: a.id, title: a.title, standard: a.standard,
      self: e.self_ratings?.[a.id] ?? null, example: e.self_examples?.[a.id] || "",
      mgr: responded ? (e.mgr_ratings?.[a.id] ?? null) : null, mgr_note: responded ? (e.mgr_notes?.[a.id] || "") : "",
    })),
    open: f.open.map((o) => ({ id: o.id, q: o.q, answer: e.open_answers?.[o.id] || "" })),
    responded,
    strengths: responded ? e.strengths : null, focus: responded ? e.focus : null, overall_note: responded ? e.overall_note : null,
    responded_by: responded ? e.responded_by : null, responded_at: responded ? e.responded_at : null,
    reflection: e.reflection || null, acknowledged_at: e.acknowledged_at || null,
    feedback: e.feedback_snapshot || [],
  };
}

// ---------------------------------------------------------------------------
// Guest feedback: recent shared reviews. Reviews that name this person first,
// then the most recent complaints (3 stars or fewer), then a couple of 5-star ones.
// ---------------------------------------------------------------------------
async function guestFeedback(name: string) {
  const since = new Date(Date.now() - FEEDBACK_DAYS * 864e5).toISOString().slice(0, 10);
  const { data } = await supa.from("guest_reviews").select("id,rating,body,review_date,mgmt_note,staff_mentions")
    .eq("share", true).gte("review_date", since).order("review_date", { ascending: false }).limit(300);
  const rows = (data ?? []).filter((r: any) => String(r.body || "").trim());
  const full = String(name || "").trim().toLowerCase(), first = firstName(name).toLowerCase();
  const isMine = (r: any) => !!full && (r.staff_mentions || []).some((m: string) => { const x = String(m).toLowerCase(); return x === full || x === first; });
  const mine = rows.filter(isMine);
  const neg = rows.filter((r: any) => !isMine(r) && (r.rating ?? 5) <= 3); // newest first
  const pos = rows.filter((r: any) => !isMine(r) && (r.rating ?? 0) >= 5);
  return [...mine, ...neg.slice(0, 5), ...pos.slice(0, 2)].slice(0, FEEDBACK_MAX).map((r: any) => ({
    id: r.id, rating: r.rating, body: r.body, date: r.review_date, note: r.mgmt_note || "", about_you: isMine(r),
  }));
}
async function staffFirstNames(): Promise<string[]> {
  const { data } = await supa.from("checklist_staff").select("name").eq("active", true);
  const out = new Set<string>();
  for (const s of data ?? []) { const f = firstName(s.name); if (f.length >= 3) out.add(f); }
  return [...out];
}
function findMentions(body: string, names: string[]): string[] {
  const t = String(body || "");
  return names.filter((n) => new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i").test(t));
}

// ---------------------------------------------------------------------------
// Roster: Square team (name, email, phone, job titles) + checklist_staff roles
// ---------------------------------------------------------------------------
function suggest(checklistRole: string, jobs: string[]): string[] {
  const out = new Set<string>();
  const r = String(checklistRole || "").toLowerCase();
  if (r === "server") out.add("server");
  if (r === "bartender") out.add("bartender");
  if (r === "kitchen") out.add("kitchen");
  for (const j of jobs.map((x) => x.toLowerCase())) {
    if (/berver/.test(j)) { out.add("server"); out.add("bartender"); }
    else if (/server/.test(j)) out.add("server");
    if (/bartend/.test(j)) out.add("bartender");
    if (/cook|chef|dish|prep|kitchen|line/.test(j)) out.add("kitchen");
    if (/host/.test(j)) out.add("host");
    if (/bus/.test(j)) out.add("busser");
    if (/expo|runner/.test(j)) out.add("expo");
  }
  return [...out];
}
async function roster() {
  type P = { name: string; email: string; phone: string; jobs: string[]; checklist_role: string; ref: string; source: string; support: boolean; suggested: string[] };
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
          byName.set(name.toLowerCase(), { name, email: m.email_address || "", phone: m.phone_number || "", jobs, checklist_role: "", ref: "sq:" + m.id, source: "square", support: false, suggested: [] });
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
    const hit = byName.get(k.toLowerCase());
    if (hit) hit.checklist_role = s.role || "";
    else byName.set(k.toLowerCase(), { name: k, email: "", phone: "", jobs: [], checklist_role: s.role || "", ref: "cl:" + s.id, source: "checklist", support: false, suggested: [] });
  }
  const out = [...byName.values()];
  for (const p of out) {
    p.suggested = suggest(p.checklist_role, p.jobs);
    p.support = p.checklist_role === "support" || p.jobs.some((j) => /support/i.test(j));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    // ---------------- PUBLIC ----------------
    if (action.startsWith("eval_")) {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: e } = await supa.from("staff_evaluations").select("*").eq("token", tok).single();
      if (!e) return json({ error: "This link isn't valid." }, 404);
      if (e.status === "voided") return json({ error: "This evaluation was withdrawn. Ask a manager for a new link.", voided: true }, 410);
      const f = FORMS[e.role_key];
      const head = {
        ref_no: e.ref_no, employee_name: e.employee_name, status: e.status, title: f.title, intro: f.intro, scale: SCALE,
        min: { example: MIN_EXAMPLE, open: MIN_OPEN, reflect: MIN_REFLECT },
      };

      if (action === "eval_load") {
        if (["submitted", "responded", "acknowledged"].includes(e.status)) return json({ ...head, view: viewFor(e) });
        if (e.status === "sent") {
          const now = new Date().toISOString();
          await supa.from("staff_evaluations").update({ status: "in_progress", opened_at: now, updated_at: now }).eq("id", e.id).eq("status", "sent");
          await audit(e.id, "opened", "employee", req);
        }
        return json({ ...head, feedback: await guestFeedback(e.employee_name), form: { areas: f.areas.map((a) => ({ id: a.id, title: a.title, standard: a.standard, prompt: a.prompt })), open: f.open } });
      }

      if (action === "eval_submit") {
        if (!["sent", "in_progress"].includes(e.status)) return json({ error: "This evaluation was already submitted.", done: true }, 409);
        const rIn = body.ratings || {}, xIn = body.examples || {}, oIn = body.open || {};
        const ratings: Record<string, number> = {}, examples: Record<string, string> = {}, open: Record<string, string> = {};
        for (const a of f.areas) {
          const v = Number(rIn[a.id]);
          if (!Number.isInteger(v) || v < 1 || v > 5) return json({ error: `Rate yourself on "${a.title}".` }, 400);
          const x = String(xIn[a.id] || "").trim().slice(0, 3000);
          if (words(x) < MIN_EXAMPLE) return json({ error: `"${a.title}" needs an example — at least ${MIN_EXAMPLE} words.` }, 400);
          ratings[a.id] = v; examples[a.id] = x;
        }
        for (const o of f.open) {
          const x = String(oIn[o.id] || "").trim().slice(0, 4000);
          if (words(x) < MIN_OPEN) return json({ error: `Answer every question at the end with at least ${MIN_OPEN} words.` }, 400);
          open[o.id] = x;
        }
        const now = new Date().toISOString();
        await supa.from("staff_evaluations").update({
          status: "submitted", submitted_at: now, updated_at: now, self_ratings: ratings, self_examples: examples, open_answers: open,
          feedback_snapshot: await guestFeedback(e.employee_name),
          submit_ip: clientIp(req), submit_user_agent: req.headers.get("user-agent"),
        }).eq("id", e.id).in("status", ["sent", "in_progress"]);
        await audit(e.id, "submitted", "employee", req);
        const avg = (Object.values(ratings).reduce((s, n) => s + n, 0) / f.areas.length).toFixed(1);
        await sendEmail([{ email: MANAGEMENT_EMAIL, firstName: "Quarry Management" }],
          `${e.employee_name} submitted their ${f.title} (${e.ref_no})`,
          shell("Self-evaluation ready for your response", `<p><strong>${esc(e.employee_name)}</strong> finished the ${esc(f.title)}. Their average self-rating is <strong>${avg} / 5</strong>.</p><p>Rate the same standards and send your response in Admin › Team › Evaluations.</p>${button(SITE + "/admin/", "Open admin")}`));
        const { data: fresh } = await supa.from("staff_evaluations").select("*").eq("id", e.id).single();
        return json({ ...head, status: "submitted", view: viewFor(fresh) });
      }

      if (action === "eval_ack") {
        if (e.status === "acknowledged") return json({ error: "Already acknowledged.", done: true }, 409);
        if (e.status !== "responded") return json({ error: "Management hasn't responded yet." }, 409);
        const txt = String(body.reflection || "").trim().slice(0, 4000);
        if (words(txt) < MIN_REFLECT) return json({ error: `Write at least ${MIN_REFLECT} words about what you'll work on.` }, 400);
        const now = new Date().toISOString();
        await supa.from("staff_evaluations").update({ status: "acknowledged", reflection: txt, acknowledged_at: now, ack_ip: clientIp(req), updated_at: now }).eq("id", e.id).eq("status", "responded");
        await audit(e.id, "acknowledged", "employee", req);
        await sendEmail([{ email: MANAGEMENT_EMAIL, firstName: "Quarry Management" }],
          `${e.employee_name} acknowledged their evaluation (${e.ref_no})`,
          shell("Evaluation acknowledged", `<p><strong>${esc(e.employee_name)}</strong> read your response and wrote:</p><blockquote style="border-left:3px solid #B8933A;margin:12px 0;padding:6px 12px;color:#333;white-space:pre-wrap;">${esc(txt)}</blockquote>${button(SITE + "/admin/", "Open admin")}`));
        const { data: fresh } = await supa.from("staff_evaluations").select("*").eq("id", e.id).single();
        return json({ ...head, status: "acknowledged", view: viewFor(fresh) });
      }
      return json({ error: "unknown action" }, 400);
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ALLOWED_ROLES.includes(role)) return json({ error: "Your login can't manage evaluations." }, 403);
    const actor = role === "owner" ? "admin" : role;

    if (action === "admin_meta") return json({ forms: FORMS, order: ORDER, scale: SCALE, min: { example: MIN_EXAMPLE, open: MIN_OPEN, reflect: MIN_REFLECT } });

    if (action === "admin_roster") return json({ roster: await roster() });

    if (action === "admin_list") {
      const { data, error } = await supa.from("staff_evaluations").select(SUMMARY).order("created_at", { ascending: false }).limit(2000);
      if (error) return json({ error: error.message }, 500);
      return json({ evaluations: data });
    }

    if (action === "admin_get") {
      const { data: e } = await supa.from("staff_evaluations").select("*").eq("id", body.id).single();
      if (!e) return json({ error: "not found" }, 404);
      const { data: auditRows } = await supa.from("staff_evaluation_audit").select("*").eq("evaluation_id", e.id).order("created_at");
      const { data: history } = await supa.from("staff_evaluations").select(SUMMARY)
        .ilike("employee_name", String(e.employee_name).replace(/[%_\\]/g, (c: string) => "\\" + c)).neq("id", e.id).order("created_at", { ascending: false });
      return json({ evaluation: e, audit: auditRows, history, link: link(e.token) });
    }

    if (action === "admin_send") {
      const key = String(body.role_key || "");
      if (!FORMS[key]) return json({ error: "Unknown form" }, 400);
      const people = Array.isArray(body.people) ? body.people.slice(0, 150) : [];
      if (!people.length) return json({ error: "Pick at least one person." }, 400);
      const sentBy = String(body.sent_by || "").trim().slice(0, 80) || null;
      const batch = crypto.randomUUID();
      const results: unknown[] = [];
      for (const p of people) {
        const name = String(p.name || "").trim().slice(0, 120);
        if (!name) continue;
        const email = isEmail(p.email) ? String(p.email).trim() : null;
        const phone = String(p.phone || "").trim() || null;
        const tok = newToken();
        const row = {
          token: tok, role_key: key, form_version: FORMS[key].version, employee_name: name, employee_email: email, employee_phone: phone,
          employee_ref: p.ref || null, sent_by: sentBy, delivery: email ? "email" : (phone ? "text" : "link"), batch_id: batch,
        };
        const { data: ins, error } = await supa.from("staff_evaluations").insert(row).select("*").single();
        if (error) { results.push({ name, error: error.message }); continue; }
        await audit(ins.id, "sent", actor, req, { delivery: row.delivery, by: sentBy, batch });
        let emailed = false;
        if (email) { emailed = await emailInvite(ins); if (emailed) await audit(ins.id, "emailed", actor, req, { to: email }); }
        results.push({ id: ins.id, ref_no: ins.ref_no, name, email, phone, link: link(tok), emailed });
      }
      return json({ batch_id: batch, results });
    }

    if (action === "admin_metrics") {
      const days = [30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 60;
      const { data, error } = await supa.rpc("staff_eval_metrics", { p_name: String(body.name || ""), p_days: days });
      if (error) return json({ error: error.message }, 500);
      return json({ metrics: data });
    }

    if (action === "admin_remind") {
      const { data: e } = await supa.from("staff_evaluations").select("*").eq("id", body.id).single();
      if (!e || !["sent", "in_progress"].includes(e.status)) return json({ error: "Only evaluations that haven't been submitted can be re-sent." }, 409);
      const ok = await emailInvite(e, true);
      if (!ok) return json({ error: "No valid email on file. Copy the link and text it instead." }, 400);
      await audit(e.id, "reminded", actor, req, { to: e.employee_email });
      return json({ ok: true });
    }

    if (action === "admin_respond") {
      const { data: e } = await supa.from("staff_evaluations").select("*").eq("id", body.id).single();
      if (!e) return json({ error: "not found" }, 404);
      if (!["submitted", "responded"].includes(e.status)) return json({ error: e.status === "acknowledged" ? "Already acknowledged by the employee — locked." : "They haven't submitted yet." }, 409);
      const f = FORMS[e.role_key];
      const rIn = body.ratings || {}, nIn = body.notes || {};
      const ratings: Record<string, number | null> = {}, notes: Record<string, string> = {};
      for (const a of f.areas) {
        const v = Number(rIn[a.id]);
        ratings[a.id] = Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
        notes[a.id] = String(nIn[a.id] || "").trim().slice(0, 3000);
      }
      const finish = !!body.finish;
      const focus = String(body.focus || "").trim().slice(0, 4000);
      if (finish) {
        const missing = f.areas.filter((a) => ratings[a.id] == null).map((a) => a.title);
        if (missing.length) return json({ error: "Rate every standard first: " + missing.join(", ") }, 400);
        if (!focus) return json({ error: "Add a focus for the next 30 days before sending." }, 400);
      }
      const now = new Date().toISOString();
      const upd: Record<string, unknown> = {
        mgr_ratings: ratings, mgr_notes: notes, focus: focus || null,
        strengths: String(body.strengths || "").trim().slice(0, 4000) || null,
        overall_note: String(body.overall_note || "").trim().slice(0, 5000) || null,
        responded_by: String(body.responded_by || "").trim().slice(0, 80) || e.responded_by || null, updated_at: now,
      };
      if (finish) {
        upd.status = "responded"; upd.responded_at = now;
        const { data: m } = await supa.rpc("staff_eval_metrics", { p_name: e.employee_name, p_days: 60 });
        if (m) upd.metrics_snapshot = m;
      }
      const { error } = await supa.from("staff_evaluations").update(upd).eq("id", e.id);
      if (error) return json({ error: error.message }, 500);
      await audit(e.id, finish ? "responded" : "response_saved", actor, req);
      let emailed = false;
      if (finish && isEmail(e.employee_email)) {
        const first = firstName(e.employee_name);
        emailed = await sendEmail([{ email: e.employee_email.trim(), firstName: first }],
          `Management responded to your evaluation — The Quarry`,
          shell("Your evaluation response is ready", `<p>Hi ${esc(first)},</p><p>${esc(upd.responded_by || "Management")} went through your self-evaluation and rated the same standards. Open your link to see both side by side, read the notes, and tell us what you'll work on.</p>${button(link(e.token), "See my evaluation")}`));
        if (emailed) await audit(e.id, "emailed", actor, req, { to: e.employee_email, kind: "response" });
      }
      return json({ ok: true, status: finish ? "responded" : e.status, emailed, link: link(e.token) });
    }

    if (action === "admin_reviews") {
      const { data, error } = await supa.from("guest_reviews").select("*").order("review_date", { ascending: false, nullsFirst: false }).limit(1000);
      if (error) return json({ error: error.message }, 500);
      return json({ reviews: data, staff_names: await staffFirstNames(), days: FEEDBACK_DAYS });
    }

    if (action === "admin_reviews_import") {
      const list = Array.isArray(body.reviews) ? body.reviews.slice(0, 1000) : [];
      const names = await staffFirstNames();
      let added = 0, updated = 0;
      for (const r of list) {
        const ext = String(r.external_id || "").trim().slice(0, 300);
        const text = String(r.body || "").trim().slice(0, 8000);
        if (!ext) continue;
        const rating = Number(r.rating);
        const fields = {
          author: String(r.author || "").trim().slice(0, 120) || null, rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
          body: text || null, review_date: /^\d{4}-\d{2}-\d{2}$/.test(String(r.review_date || "")) ? r.review_date : null,
          owner_reply: String(r.owner_reply || "").trim().slice(0, 8000) || null, url: String(r.url || "").trim().slice(0, 1000) || null, updated_at: new Date().toISOString(),
        };
        const source = String(r.source || "google").slice(0, 40);
        const { data: ex } = await supa.from("guest_reviews").select("id").eq("source", source).eq("external_id", ext).maybeSingle();
        if (ex) { await supa.from("guest_reviews").update(fields).eq("id", ex.id); updated++; }
        else { await supa.from("guest_reviews").insert({ ...fields, source, external_id: ext, staff_mentions: findMentions(text, names) }); added++; }
      }
      return json({ ok: true, added, updated });
    }

    if (action === "admin_review_update") {
      const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof body.mgmt_note === "string") upd.mgmt_note = body.mgmt_note.trim().slice(0, 3000) || null;
      if (typeof body.share === "boolean") upd.share = body.share;
      if (Array.isArray(body.staff_mentions)) upd.staff_mentions = body.staff_mentions.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 20);
      const { error } = await supa.from("guest_reviews").update(upd).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "admin_feedback_preview") return json({ feedback: await guestFeedback(String(body.name || "")), days: FEEDBACK_DAYS });

    if (action === "admin_void") {
      const now = new Date().toISOString();
      const { error } = await supa.from("staff_evaluations").update({ status: "voided", void_reason: String(body.reason || "").trim() || null, updated_at: now }).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
      await audit(body.id, "voided", actor, req, { reason: body.reason || "" });
      return json({ ok: true });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (err) {
    console.error("staff-evals error", err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
