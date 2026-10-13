// ============================================================================
// Supabase Edge Function: incidents
// The Quarry — incident reports (guest falls, injuries, damage, disturbances)
// with written, signed statements from employees and witnesses by link.
// ----------------------------------------------------------------------------
// One function, action-routed. verify_jwt = false (custom auth per action).
//
//   ADMIN (header x-admin-token, verified by the site's verify-admin-password
//   Netlify function). Roles: owner, events_staff.
//     admin_meta        incident types, medical options, statement questions
//     admin_list        incidents + statement counts
//     admin_get         one incident + statements (+ photo URLs) + audit
//     admin_save        create / update an incident
//     admin_request     request a statement (name/email/phone) → private link
//     admin_remind      re-email a statement link
//     admin_void_stmt   withdraw a statement request
//     admin_status      close / reopen
//     admin_pdf         full report PDF (incident + every statement + photos)
//
//   PUBLIC (statement token) — /incident-statement.html?t=<token>
//     stmt_load         incident basics (never the manager's summary or other
//                       statements, so witnesses write their own account)
//     stmt_photo        upload one photo (JPEG data URL, resized client-side)
//     stmt_submit       answers + typed name + drawn signature
//
// Tables: incidents, incident_statements, incident_audit (RLS on, no policies).
// Bucket: incident-reports (private) — photos + PDFs.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from "https://esm.sh/pdf-lib@1.17.1?target=deno";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://thequarrystl.com";
const VERIFY_URL = `${SITE}/.netlify/functions/verify-admin-password`;
const SEND_EMAIL_URL = `${SITE}/.netlify/functions/send-email`;
const STMT_URL = Deno.env.get("INCIDENT_STATEMENT_URL") || `${SITE}/incident-statement.html`;
const LOGO_URL = `${SITE}/assets/quarry-q-logo.png`;
const BUCKET = "incident-reports";
const MANAGEMENT_EMAIL = "management@thequarrystl.com";
const ALLOWED_ROLES = ["owner", "events_staff"];
const MAX_PHOTOS = 4;

export const TYPES: Record<string, string> = {
  guest_injury: "Guest injury / fall",
  employee_injury: "Employee injury",
  property_damage: "Property damage",
  altercation: "Altercation / disturbance",
  alcohol: "Intoxicated guest / alcohol",
  theft: "Theft / lost property",
  vehicle: "Parking lot / vehicle",
  other: "Other",
};
export const MEDICAL: Record<string, string> = {
  none: "No medical attention needed",
  first_aid: "First aid given on site",
  ems: "Ambulance / EMS called",
  refused: "Medical help offered and refused",
  unknown: "Unknown",
};
export const SEEN: Record<string, string> = {
  saw: "I saw it happen",
  after: "I got there right after",
  told: "I was told about it",
};
// The statement form. `req` = required.
export const QUESTIONS = [
  { id: "where", label: "Where were you and what were you doing when it happened?", req: true },
  { id: "saw", label: "Describe exactly what you saw and heard, in order. Only what you personally saw or heard.", req: true },
  { id: "before", label: "What happened right before? Describe the area: floor, lighting, anything on the ground, signs, weather.", req: false },
  { id: "after", label: "What did you do after it happened? Who did you tell, and when?", req: true },
  { id: "injury", label: "Did you see any injury? What did the person say about how they were feeling?", req: false },
  { id: "others", label: "Who else was there or saw it? Names or descriptions.", req: false },
  { id: "other", label: "Anything else we should know?", req: false },
];

const EDITABLE = [
  "incident_type", "incident_date", "incident_time", "location", "summary", "people_involved",
  "injured_name", "injured_contact", "injured_role", "injury_details", "medical_response",
  "police_called", "police_report_no", "conditions", "actions_taken", "follow_up", "insurance_notified", "reported_by",
];

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
const link = (tok: string) => `${STMT_URL}?t=${tok}`;
const fmtDate = (d: string | null) => {
  if (!d) return "";
  const dt = new Date(String(d).length <= 10 ? d + "T12:00:00" : d);
  return dt.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" });
};
const fmtStamp = (d: string | null) =>
  d ? new Date(d).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" }) + " CT" : "";

async function adminRole(req: Request): Promise<string | null> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) return null;
  try {
    const r = await fetch(VERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify", token: tok }) });
    const b = await r.json().catch(() => ({}));
    return b.ok ? (b.role || null) : null;
  } catch (_) { return null; }
}
async function audit(incidentId: string, event: string, actor: string, req: Request | null, detail: Record<string, unknown> = {}, statementId: string | null = null) {
  await supa.from("incident_audit").insert({
    incident_id: incidentId, statement_id: statementId, event, actor,
    ip: req ? clientIp(req) : null, user_agent: req ? req.headers.get("user-agent") : null, detail,
  });
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
     <div style="padding:12px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">The Quarry · 3960 Highway Z, New Melle, MO 63385 · Confidential</div></div>`;
const button = (href: string, label: string) =>
  `<p style="margin:22px 0;"><a href="${href}" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">${label}</a></p>`;

async function emailRequest(s: any, inc: any, reminder = false) {
  if (!isEmail(s.person_email)) return false;
  const first = String(s.person_name || "").split(" ")[0];
  return await sendEmail([{ email: s.person_email.trim(), firstName: first }],
    `${reminder ? "Reminder: " : ""}Statement needed — ${TYPES[inc.incident_type] || "incident"} on ${fmtDate(inc.incident_date)}`,
    shell(reminder ? "Reminder: your statement is still needed" : "We need your statement",
      `<p>Hi ${esc(first)},</p><p>We're documenting an incident at The Quarry on <strong>${esc(fmtDate(inc.incident_date))}</strong> (${esc(TYPES[inc.incident_type] || "")}${inc.location ? ", " + esc(inc.location) : ""}). Please write down what you saw while it's fresh. It takes about 10 minutes.</p><p>Write only what you personally saw or heard, and please don't compare notes with anyone before you write it.</p>${button(link(s.token), "Write my statement")}<p style="font-size:12px;color:#888;">This link is just for you.</p>`));
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function b64ToBytes(d: string): Uint8Array {
  const b64 = d.includes(",") ? d.split(",")[1] : d;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function signed(path: string, seconds = 60 * 60) {
  const { data } = await supa.storage.from(BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl || null;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
function clean(s: unknown): string {
  return String(s ?? "").replace(/\r/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, "*").replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, "");
}
async function buildPdf(inc: any, stmts: any[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Incident Report ${inc.ref_no}`);
  pdf.setAuthor("The Quarry — Roddy & Meier Holdings LLC");
  const F = await pdf.embedFont(StandardFonts.Helvetica);
  const B = await pdf.embedFont(StandardFonts.HelveticaBold);
  const SERIF = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const W = 612, H = 792, M = 48, CW = W - M * 2;
  const charcoal = rgb(0.102, 0.102, 0.102), gold = rgb(0.722, 0.576, 0.227), brown = rgb(0.173, 0.102, 0.055);
  const grey = rgb(0.42, 0.42, 0.42), line = rgb(0.85, 0.82, 0.77), cream = rgb(0.961, 0.941, 0.910);
  let logo: any = null;
  try { const r = await fetch(LOGO_URL); if (r.ok) logo = await pdf.embedPng(new Uint8Array(await r.arrayBuffer())); } catch (_) { /* optional */ }

  let page: PDFPage = pdf.addPage([W, H]);
  let y = 0, pageNo = 1;
  const footer = (p: PDFPage, n: number) => {
    p.drawLine({ start: { x: M, y: 40 }, end: { x: W - M, y: 40 }, thickness: 0.5, color: line });
    p.drawText(clean(`CONFIDENTIAL INCIDENT REPORT  ·  ${inc.ref_no}  ·  Prepared in anticipation of a possible claim`), { x: M, y: 28, size: 7, font: F, color: grey });
    p.drawText(`Page ${n}`, { x: W - M - 30, y: 28, size: 7, font: F, color: grey });
  };
  const header = (p: PDFPage, first: boolean) => {
    const hh = first ? 92 : 40;
    p.drawRectangle({ x: 0, y: H - hh, width: W, height: hh, color: charcoal });
    if (first) {
      if (logo) { const s = 46 / logo.height; p.drawImage(logo, { x: M, y: H - 70, width: logo.width * s, height: 46 }); }
      const lx = logo ? M + 58 : M;
      p.drawText("THE QUARRY", { x: lx, y: H - 44, size: 20, font: SERIF, color: gold });
      p.drawText("NEW MELLE, MISSOURI", { x: lx, y: H - 60, size: 7.5, font: F, color: rgb(0.83, 0.69, 0.42) });
      const t = "INCIDENT REPORT";
      p.drawText(t, { x: W - M - B.widthOfTextAtSize(t, 11), y: H - 42, size: 11, font: B, color: rgb(1, 1, 1) });
      const rt = clean(`Ref ${inc.ref_no}`);
      p.drawText(rt, { x: W - M - F.widthOfTextAtSize(rt, 9), y: H - 58, size: 9, font: F, color: gold });
    } else {
      p.drawText("THE QUARRY", { x: M, y: H - 26, size: 12, font: SERIF, color: gold });
      const rt = clean(`Incident Report · ${inc.ref_no} (continued)`);
      p.drawText(rt, { x: W - M - F.widthOfTextAtSize(rt, 8.5), y: H - 25, size: 8.5, font: F, color: rgb(1, 1, 1) });
    }
    return H - hh - 22;
  };
  y = header(page, true);
  const newPage = () => { footer(page, pageNo); page = pdf.addPage([W, H]); pageNo++; y = header(page, false); };
  const need = (h: number) => { if (y - h < 60) newPage(); };
  const wrap = (text: string, font: PDFFont, size: number, width: number): string[] => {
    const out: string[] = [];
    for (const para of clean(text).split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(""); continue; }
      let cur = "";
      for (const wd of words) {
        const t = cur ? cur + " " + wd : wd;
        if (font.widthOfTextAtSize(t, size) <= width) cur = t;
        else {
          if (cur) out.push(cur);
          let rest = wd;
          while (font.widthOfTextAtSize(rest, size) > width) {
            let i = rest.length;
            while (i > 1 && font.widthOfTextAtSize(rest.slice(0, i), size) > width) i--;
            out.push(rest.slice(0, i)); rest = rest.slice(i);
          }
          cur = rest;
        }
      }
      out.push(cur);
    }
    return out;
  };
  const para = (text: string, o: { size?: number; font?: PDFFont; color?: any; lh?: number } = {}) => {
    const size = o.size ?? 10, font = o.font ?? F, lh = o.lh ?? size * 1.4;
    for (const ln of wrap(text, font, size, CW)) { need(lh); page.drawText(ln, { x: M, y: y - size, size, font, color: o.color ?? charcoal }); y -= lh; }
  };
  const title = (t: string) => {
    need(34); y -= 6;
    page.drawText(clean(t).toUpperCase(), { x: M, y: y - 9, size: 8.5, font: B, color: brown });
    y -= 13; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.75, color: gold }); y -= 8;
  };
  const block = (label: string, text: string | null) => { if (!text) return; title(label); para(text); y -= 4; };
  const grid = (rows: [string, string][]) => {
    const colW = CW / 2, rowH = 30, n = Math.ceil(rows.length / 2);
    need(n * rowH + 10);
    page.drawRectangle({ x: M, y: y - n * rowH, width: CW, height: n * rowH, color: cream, borderColor: line, borderWidth: 0.75 });
    rows.forEach(([k, v], i) => {
      const cx = M + (i % 2) * colW + 10, cy = y - Math.floor(i / 2) * rowH;
      page.drawText(clean(k).toUpperCase(), { x: cx, y: cy - 11, size: 6.5, font: B, color: grey });
      let val = clean(v || "-");
      while (B.widthOfTextAtSize(val, 10) > colW - 20 && val.length > 3) val = val.slice(0, -2);
      page.drawText(val, { x: cx, y: cy - 24, size: 10, font: B, color: charcoal });
    });
    y -= n * rowH + 10;
  };

  grid([
    ["Type", TYPES[inc.incident_type] || inc.incident_type],
    ["Date / time", [fmtDate(inc.incident_date), inc.incident_time].filter(Boolean).join(" · ")],
    ["Location", inc.location || ""],
    ["Reported by", inc.reported_by || ""],
    ["Person injured / involved", [inc.injured_name, inc.injured_role].filter(Boolean).join(" · ")],
    ["Their contact", inc.injured_contact || ""],
    ["Medical response", MEDICAL[inc.medical_response] || inc.medical_response || ""],
    ["Police", inc.police_called ? "Called" + (inc.police_report_no ? " · report " + inc.police_report_no : "") : "Not called"],
  ]);
  block("What happened (manager's account)", inc.summary);
  block("People involved", inc.people_involved);
  block("Injury details", inc.injury_details);
  block("Conditions at the scene", inc.conditions);
  block("Actions taken", inc.actions_taken);
  block("Follow-up", inc.follow_up);
  title("Status");
  para(`${inc.status === "closed" ? "Closed " + fmtStamp(inc.closed_at) : "Open"}  ·  Insurance notified: ${inc.insurance_notified ? "yes" : "no"}  ·  Statements submitted: ${stmts.filter((s) => s.status === "submitted").length}`, { size: 9, color: grey });

  for (const s of stmts.filter((x) => x.status === "submitted")) {
    newPage();
    title(`Statement — ${s.person_name}${s.person_role ? " (" + s.person_role + ")" : ""}`);
    para(`Submitted ${fmtStamp(s.submitted_at)}  ·  ${SEEN[s.answers?.seen] || ""}`, { size: 9, color: grey });
    y -= 4;
    for (const q of QUESTIONS) {
      const a = s.answers?.[q.id];
      if (!a) continue;
      need(30);
      para(q.label, { size: 8.5, font: B, color: brown });
      para(a);
      y -= 6;
    }
    // photos
    const photos: string[] = s.answers?.photos || [];
    for (const path of photos) {
      try {
        const { data } = await supa.storage.from(BUCKET).download(path);
        if (!data) continue;
        const img = await pdf.embedJpg(new Uint8Array(await data.arrayBuffer()));
        const scale = Math.min(CW / img.width, 260 / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        need(h + 14);
        page.drawImage(img, { x: M, y: y - h, width: w, height: h });
        y -= h + 12;
      } catch (e) { console.error("photo embed", e); }
    }
    // signature
    need(90);
    y -= 6;
    if (s.signature && String(s.signature).startsWith("data:image/png")) {
      try {
        const img = await pdf.embedPng(b64ToBytes(s.signature));
        const sc = Math.min(220 / img.width, 46 / img.height);
        page.drawImage(img, { x: M + 4, y: y - 46, width: img.width * sc, height: img.height * sc });
      } catch (_) { /* skip */ }
    }
    page.drawLine({ start: { x: M, y: y - 48 }, end: { x: M + 260, y: y - 48 }, thickness: 0.75, color: charcoal });
    page.drawText("SIGNATURE", { x: M, y: y - 58, size: 6.5, font: B, color: grey });
    page.drawText(clean(`${s.signed_name || s.person_name}  ·  ${fmtStamp(s.submitted_at)}  ·  IP ${s.submit_ip || "-"}`), { x: M, y: y - 70, size: 8, font: F, color: charcoal });
    y -= 82;
    para("I confirm this statement is true and complete to the best of my knowledge.", { size: 8, color: grey });
  }
  footer(page, pageNo);
  return await pdf.save();
}

// ============================================================================
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: Record<string, any> = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    // ---------------- PUBLIC ----------------
    if (action.startsWith("stmt_")) {
      const tok = String(body.token || "");
      if (tok.length < 30) return json({ error: "This link is incomplete." }, 400);
      const { data: s } = await supa.from("incident_statements").select("*").eq("token", tok).single();
      if (!s) return json({ error: "This link isn't valid." }, 404);
      if (s.status === "voided") return json({ error: "This statement request was withdrawn.", voided: true }, 410);
      const { data: inc } = await supa.from("incidents").select("id,ref_no,incident_type,incident_date,incident_time,location").eq("id", s.incident_id).single();
      if (!inc) return json({ error: "Incident not found." }, 404);
      const head = {
        ref_no: inc.ref_no, type: TYPES[inc.incident_type] || inc.incident_type, date: inc.incident_date, time: inc.incident_time,
        location: inc.location, person_name: s.person_name, status: s.status, submitted_at: s.submitted_at,
        questions: QUESTIONS, seen: SEEN, max_photos: MAX_PHOTOS,
      };

      if (action === "stmt_load") {
        if (s.status === "requested" && !s.opened_at) {
          await supa.from("incident_statements").update({ opened_at: new Date().toISOString() }).eq("id", s.id);
          await audit(s.incident_id, "statement_opened", s.person_name, req, {}, s.id);
        }
        return json(head);
      }
      if (s.status === "submitted") return json({ error: "This statement was already submitted.", done: true }, 409);

      if (action === "stmt_photo") {
        const d = String(body.photo || "");
        if (!d.startsWith("data:image/jpeg;base64,")) return json({ error: "Photo must be a JPEG." }, 400);
        if (d.length > 3_000_000) return json({ error: "That photo is too large." }, 400);
        const n = Number(body.index) || 0;
        const path = `${s.incident_id}/${s.id}/photo-${Date.now()}-${n}.jpg`;
        const up = await supa.storage.from(BUCKET).upload(path, b64ToBytes(d), { contentType: "image/jpeg", upsert: false });
        if (up.error) return json({ error: "Photo upload failed. Try again." }, 500);
        return json({ path });
      }

      if (action === "stmt_submit") {
        const a = body.answers || {};
        const answers: Record<string, unknown> = {};
        for (const q of QUESTIONS) {
          const v = String(a[q.id] || "").trim().slice(0, 6000);
          if (q.req && v.length < 15) return json({ error: `Please answer: "${q.label.split("?")[0]}?"` }, 400);
          if (v) answers[q.id] = v;
        }
        if (!SEEN[a.seen]) return json({ error: "Tell us whether you saw it happen." }, 400);
        answers.seen = a.seen;
        const photos = (Array.isArray(a.photos) ? a.photos : []).filter((p: unknown) => typeof p === "string" && p.startsWith(`${s.incident_id}/${s.id}/`)).slice(0, MAX_PHOTOS);
        if (photos.length) answers.photos = photos;
        const signedName = String(body.signed_name || "").trim();
        const sig = String(body.signature || "");
        if (signedName.length < 2) return json({ error: "Type your full name." }, 400);
        if (!sig.startsWith("data:image/png;base64,") || sig.length < 500) return json({ error: "Please sign with your finger." }, 400);
        if (sig.length > 600_000) return json({ error: "Signature image too large." }, 400);
        if (!body.confirm) return json({ error: "Tick the box to confirm your statement." }, 400);
        const now = new Date().toISOString();
        await supa.from("incident_statements").update({
          status: "submitted", answers, signed_name: signedName.slice(0, 120), signature: sig, submitted_at: now,
          submit_ip: clientIp(req), submit_user_agent: req.headers.get("user-agent"),
        }).eq("id", s.id).eq("status", "requested");
        await audit(s.incident_id, "statement_submitted", s.person_name, req, { photos: photos.length }, s.id);
        await sendEmail([{ email: MANAGEMENT_EMAIL, firstName: "Quarry Management" }],
          `Statement received — ${s.person_name} (${inc.ref_no})`,
          shell("Statement received", `<p><strong>${esc(s.person_name)}</strong> submitted a statement for ${esc(inc.ref_no)} — ${esc(TYPES[inc.incident_type] || "")} on ${esc(fmtDate(inc.incident_date))}.</p>${button(SITE + "/admin/", "Open admin")}`));
        return json({ ok: true, status: "submitted" });
      }
      return json({ error: "unknown action" }, 400);
    }

    // ---------------- ADMIN ----------------
    if (!action.startsWith("admin_")) return json({ error: "unknown action" }, 400);
    const role = await adminRole(req);
    if (!role) return json({ error: "unauthorized — log in again" }, 401);
    if (!ALLOWED_ROLES.includes(role)) return json({ error: "Your login can't manage incident reports." }, 403);
    const actor = role === "owner" ? "admin" : role;

    if (action === "admin_meta") return json({ types: TYPES, medical: MEDICAL, seen: SEEN, questions: QUESTIONS });

    if (action === "admin_list") {
      const { data, error } = await supa.from("incidents").select("id,ref_no,status,incident_type,incident_date,incident_time,location,injured_name,reported_by,created_at,closed_at").order("incident_date", { ascending: false }).limit(1000);
      if (error) return json({ error: error.message }, 500);
      const { data: st } = await supa.from("incident_statements").select("incident_id,status");
      const counts: Record<string, { req: number; sub: number }> = {};
      for (const x of st ?? []) {
        if (x.status === "voided") continue;
        const c = counts[x.incident_id] ||= { req: 0, sub: 0 };
        if (x.status === "submitted") c.sub++; else c.req++;
      }
      return json({ incidents: (data ?? []).map((i) => ({ ...i, pending: counts[i.id]?.req || 0, submitted: counts[i.id]?.sub || 0 })) });
    }

    if (action === "admin_get") {
      const { data: inc } = await supa.from("incidents").select("*").eq("id", body.id).single();
      if (!inc) return json({ error: "not found" }, 404);
      const { data: st } = await supa.from("incident_statements").select("*").eq("incident_id", inc.id).order("created_at");
      const statements = [];
      for (const s of st ?? []) {
        const photos = [];
        for (const p of (s.answers?.photos || [])) photos.push({ path: p, url: await signed(p) });
        statements.push({ ...s, token: undefined, link: link(s.token), photo_urls: photos });
      }
      const { data: auditRows } = await supa.from("incident_audit").select("*").eq("incident_id", inc.id).order("created_at");
      return json({ incident: inc, statements, audit: auditRows });
    }

    if (action === "admin_save") {
      const f = body.fields || {};
      const row: Record<string, unknown> = {};
      for (const k of EDITABLE) if (k in f) row[k] = f[k] === "" ? null : f[k];
      if ("police_called" in row) row.police_called = !!row.police_called;
      if ("insurance_notified" in row) row.insurance_notified = !!row.insurance_notified;
      if (row.incident_type && !TYPES[row.incident_type as string]) return json({ error: "Pick an incident type." }, 400);
      if (row.medical_response && !MEDICAL[row.medical_response as string]) delete row.medical_response;
      if (body.id) {
        row.updated_at = new Date().toISOString();
        const { error } = await supa.from("incidents").update(row).eq("id", body.id);
        if (error) return json({ error: error.message }, 500);
        await audit(body.id, "updated", actor, req);
        return json({ id: body.id });
      }
      if (!row.incident_type || !row.incident_date) return json({ error: "Type and date are required." }, 400);
      const { data: ins, error } = await supa.from("incidents").insert(row).select("id,ref_no").single();
      if (error) return json({ error: error.message }, 500);
      await audit(ins.id, "created", actor, req);
      return json({ id: ins.id, ref_no: ins.ref_no });
    }

    if (action === "admin_request") {
      const f = body.fields || {};
      const name = String(f.person_name || "").trim();
      if (!name) return json({ error: "Type their name." }, 400);
      const email = String(f.person_email || "").trim();
      if (email && !isEmail(email)) return json({ error: "That email doesn't look right." }, 400);
      const { data: inc } = await supa.from("incidents").select("*").eq("id", body.id).single();
      if (!inc) return json({ error: "not found" }, 404);
      const tok = newToken();
      const { data: s, error } = await supa.from("incident_statements").insert({
        incident_id: inc.id, token: tok, person_name: name.slice(0, 120), person_email: email || null,
        person_phone: String(f.person_phone || "").trim() || null, person_role: String(f.person_role || "employee"),
        requested_by: String(f.requested_by || "").trim() || null,
      }).select("*").single();
      if (error) return json({ error: error.message }, 500);
      await audit(inc.id, "statement_requested", actor, req, { name, role: s.person_role }, s.id);
      let emailed = false;
      if (email && !body.no_email) { emailed = await emailRequest(s, inc); if (emailed) await audit(inc.id, "emailed", actor, req, { to: email }, s.id); }
      return json({ id: s.id, link: link(tok), emailed });
    }

    if (action === "admin_remind") {
      const { data: s } = await supa.from("incident_statements").select("*").eq("id", body.statement_id).single();
      if (!s || s.status !== "requested") return json({ error: "Only open requests can be re-sent." }, 409);
      const { data: inc } = await supa.from("incidents").select("*").eq("id", s.incident_id).single();
      const ok = await emailRequest(s, inc, true);
      if (!ok) return json({ error: "No valid email on file. Copy or text the link instead." }, 400);
      await audit(s.incident_id, "reminded", actor, req, { to: s.person_email }, s.id);
      return json({ ok: true });
    }

    if (action === "admin_void_stmt") {
      const { data: s } = await supa.from("incident_statements").select("id,incident_id,status").eq("id", body.statement_id).single();
      if (!s || s.status !== "requested") return json({ error: "Only open requests can be withdrawn." }, 409);
      await supa.from("incident_statements").update({ status: "voided" }).eq("id", s.id);
      await audit(s.incident_id, "statement_withdrawn", actor, req, {}, s.id);
      return json({ ok: true });
    }

    if (action === "admin_status") {
      const close = body.status === "closed";
      const now = new Date().toISOString();
      await supa.from("incidents").update({ status: close ? "closed" : "open", closed_at: close ? now : null, updated_at: now }).eq("id", body.id);
      await audit(body.id, close ? "closed" : "reopened", actor, req);
      return json({ ok: true });
    }

    if (action === "admin_pdf") {
      const { data: inc } = await supa.from("incidents").select("*").eq("id", body.id).single();
      if (!inc) return json({ error: "not found" }, 404);
      const { data: st } = await supa.from("incident_statements").select("*").eq("incident_id", inc.id).order("submitted_at");
      const bytes = await buildPdf(inc, st || []);
      const path = `${inc.id}/${inc.ref_no}-report-${Date.now()}.pdf`;
      const up = await supa.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (up.error) return json({ error: "PDF upload failed" }, 500);
      await audit(inc.id, "pdf", actor, req);
      return json({ url: await signed(path, 60 * 30) });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    console.error("incidents error", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
