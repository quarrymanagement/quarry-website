// hr-docs: employee personnel documents with e-signature (The Quarry).
//
// ADMIN actions  (header x-admin-token = quarryAdminToken from admin/index.html,
//                 verified by the site's verify-admin-password function)
//   owner                     -> full HR admin (Matt)
//   role in hr_role_scopes    -> is_admin=true: full admin; otherwise a manager
//                                who only sees policy/training docs for
//                                employees in their departments
//   anything else             -> 403
// PUBLIC actions (employee or guardian, by the private token in their link)
//   s_load, s_send_code, s_verify, s_doc, s_view, s_sign, s_decline, s_download
//
// Nothing is ever deleted. Email is OFF unless HR_EMAIL_MODE is set.
import postgres from "postgres";
import { buildFinalPdf, fmtCT, pageCount, textToPdf } from "./pdf.ts";
import { makeStore } from "./storage.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SITE = env("HR_SITE_URL", "https://thequarrystl.com");
const VERIFY_URL = env("HR_VERIFY_ADMIN_URL", `${SITE}/.netlify/functions/verify-admin-password`);
const SIGN_URL = env("HR_SIGN_URL", `${SITE}/hr-sign.html`);
const EMAIL_MODE = env("HR_EMAIL_MODE", "off"); // off | netlify | sendgrid
const FROM_EMAIL = env("HR_FROM_EMAIL", "management@thequarrystl.com");
const FROM_NAME = env("HR_FROM_NAME", "The Quarry Management");
const COPY_EMAIL = env("HR_COPY_EMAIL", ""); // optional bcc-style copy of completed PDFs
// Dev mode is only honoured when not pointed at the hosted project.
const DEV = env("HR_DEV") === "1" && !env("SUPABASE_URL").includes("supabase.co");
const SIGNING_SECRET = env("HR_SIGNING_SECRET");

// deno-lint-ignore no-explicit-any
const sql: any = postgres(env("SUPABASE_DB_URL"), {
  prepare: false, // works through the Supabase pooler
  max: 3,
  idle_timeout: 20,
  // keep DATE columns (dob, due_date) as 'YYYY-MM-DD' strings
  types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
});
const store = makeStore(DEV);

export const KIND_LABEL: Record<string, string> = {
  discipline: "Disciplinary notice",
  policy: "Policy acknowledgment",
  training: "Training acknowledgment",
};
export const ACK_STATEMENT =
  "By signing, I acknowledge that I received and reviewed this document. My signature acknowledges receipt, not agreement.";
export const CONSENT_STATEMENT =
  "I agree to receive and sign this document electronically. I understand my electronic signature is the legal equivalent of my handwritten signature (E-SIGN Act and Missouri UETA). I can download a copy of the signed document. I may instead ask a manager for a paper copy to sign, at no cost, and I can withdraw this consent before I sign by telling a manager. To view and sign I need a device with a current web browser and an email address.";
const MAX_VERIFY = 5;
const LINK_DAYS = 14;
const SESSION_MIN = 30;

// ---------------------------------------------------------------- helpers
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}
const bad = (m: string, s = 400) => new HttpError(s, m);
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256 = async (d: Uint8Array | string) =>
  hex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : new Uint8Array(d)));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function safeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const isEmail = (s: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const clean = (s: unknown, max = 2000) => String(s ?? "").trim().slice(0, max);
const ipOf = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("cf-connecting-ip") ||
  req.headers.get("x-real-ip") || "unknown";
const uaOf = (req: Request) => clean(req.headers.get("user-agent"), 500);

export function ageOn(dob: string | null, on = new Date()): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.slice(0, 10).split("-").map(Number);
  const ct = new Date(on.toLocaleString("en-US", { timeZone: "America/Chicago" }));
  let age = ct.getFullYear() - y;
  if (ct.getMonth() + 1 < m || (ct.getMonth() + 1 === m && ct.getDate() < d)) age--;
  return age;
}
export const isMinor = (e: { dob: string | null; is_minor_override: boolean | null }) =>
  e.is_minor_override ?? ((ageOn(e.dob) ?? 99) < 18);

async function audit(
  ev: string,
  actor: string,
  req: Request | null,
  ids: { a?: string | null; d?: string | null; e?: string | null },
  detail: Record<string, unknown> = {},
) {
  await sql`insert into public.hr_audit (assignment_id, document_id, employee_id, event, actor, ip, user_agent, detail)
    values (${ids.a ?? null}, ${ids.d ?? null}, ${ids.e ?? null}, ${ev}, ${actor},
            ${req ? ipOf(req) : null}, ${req ? uaOf(req) : null}, ${sql.json(detail as any)})`;
}

// ---------------------------------------------------------------- email
const emailShell = (title: string, inner: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e6dfd3;border-radius:10px;overflow:hidden;">
     <div style="background:#1A1A1A;padding:18px 22px;"><span style="color:#B8933A;font-family:Georgia,serif;font-weight:bold;letter-spacing:3px;font-size:18px;">THE QUARRY</span></div>
     <div style="padding:22px;color:#222;font-size:15px;line-height:1.5;"><h2 style="margin:0 0 12px;color:#2C1A0E;font-size:19px;">${title}</h2>${inner}</div>
     <div style="padding:12px 22px;background:#F5F0E8;color:#7a6e60;font-size:11px;">The Quarry &middot; Confidential personnel communication</div>
   </div>`;

async function sendEmail(
  to: string,
  subject: string,
  html: string,
  ids: { a?: string; e?: string },
  attachment?: { name: string; bytes: Uint8Array },
): Promise<boolean> {
  if (!isEmail(to)) return false;
  if (EMAIL_MODE === "off") {
    await audit("email_suppressed", "system", null, ids, { to_domain: to.split("@")[1], subject });
    return false;
  }
  try {
    let ok = false;
    if (EMAIL_MODE === "sendgrid") {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${env("SENDGRID_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: FROM_EMAIL, name: FROM_NAME },
          subject,
          content: [{ type: "text/html", value: html }],
          attachments: attachment
            ? [{ content: b64(attachment.bytes), filename: attachment.name, type: "application/pdf", disposition: "attachment" }]
            : undefined,
        }),
      });
      ok = r.ok;
    } else if (EMAIL_MODE === "netlify") {
      const r = await fetch(`${SITE}/.netlify/functions/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          htmlBody: html,
          recipients: [{ email: to }],
          fromEmail: FROM_EMAIL,
          fromName: FROM_NAME,
        }),
      });
      ok = r.ok;
    }
    await audit(ok ? "email_sent" : "email_failed", "system", null, ids, { to_domain: to.split("@")[1], subject });
    return ok;
  } catch (e) {
    console.error("email failed", e);
    await audit("email_failed", "system", null, ids, { subject });
    return false;
  }
}

const signLink = (tok: string) => `${SIGN_URL}?t=${encodeURIComponent(tok)}`;

async function emailSignRequest(
  a: { id: string; ref_no: string; employee_id: string },
  doc: { title: string; kind: string },
  to: string,
  name: string,
  tok: string,
  who: "employee" | "guardian",
  reminder = false,
) {
  const first = esc(name.split(" ")[0]);
  const inner = who === "guardian"
    ? `<p>Hi ${first},</p><p>An employee of The Quarry under 18 who lists you as parent/guardian has signed <strong>${
      esc(doc.title)
    }</strong> (ref ${esc(a.ref_no)}). Missouri practice is for a parent or guardian to acknowledge it too.</p>
       <p style="margin:22px 0;"><a href="${
      signLink(tok)
    }" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">Review &amp; sign</a></p>
       <p style="font-size:12px;color:#888;">This link is private to you and expires in ${LINK_DAYS} days.</p>`
    : `<p>Hi ${first},</p><p>${reminder ? "A reminder: " : ""}The Quarry sent you a ${
      esc(KIND_LABEL[doc.kind].toLowerCase())
    }: <strong>${esc(doc.title)}</strong> (ref ${esc(a.ref_no)}).</p>
       <p>Signing confirms you <strong>received and reviewed</strong> it. It does not mean you agree, and you can add comments.</p>
       <p style="margin:22px 0;"><a href="${
      signLink(tok)
    }" style="background:#2C1A0E;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">Review &amp; sign</a></p>
       <p style="font-size:12px;color:#888;">This link is private to you and expires in ${LINK_DAYS} days. Questions? Talk to a manager.</p>`;
  return await sendEmail(
    to,
    `${reminder ? "Reminder: " : ""}Please review & sign - The Quarry (${a.ref_no})`,
    emailShell(who === "guardian" ? "Parent/guardian signature needed" : "Document to review & sign", inner),
    { a: a.id, e: a.employee_id },
  );
}

// ---------------------------------------------------------------- admin auth
type Ctx = { role: string; actor: string; isAdmin: boolean; departments: string[] };

async function adminCtx(req: Request): Promise<Ctx> {
  const tok = req.headers.get("x-admin-token") || "";
  if (!tok) throw bad("Not signed in", 401);
  let role: string | null = null;
  if (DEV && tok.startsWith("dev:")) role = tok.slice(4);
  else {
    try {
      const r = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", token: tok }),
      });
      const b = await r.json().catch(() => ({}));
      role = b.ok ? b.role || null : null;
    } catch { /* fallthrough */ }
  }
  if (!role) throw bad("Session expired. Sign in again.", 401);
  if (role === "owner") return { role, actor: "owner", isAdmin: true, departments: [] };
  const [s] = await sql`select * from public.hr_role_scopes where role = ${role} and voided_at is null`;
  if (!s) throw bad("Your login does not have access to personnel documents.", 403);
  return { role, actor: `${s.label} (${role})`, isAdmin: s.is_admin, departments: s.departments ?? [] };
}

function canSee(ctx: Ctx, kind: string, dept: string) {
  if (ctx.isAdmin) return true;
  return kind !== "discipline" && ctx.departments.includes(dept);
}
function mustAdmin(ctx: Ctx) {
  if (!ctx.isAdmin) throw bad("Only an HR admin can do that.", 403);
}

async function loadAssignment(id: string) {
  const [a] = await sql`select a.*, e.full_name, e.email, e.department, e.dob, e.is_minor_override,
      d.title, d.kind as doc_kind, d.policy_key, v.version, v.sha256 as doc_sha256, v.storage_path, v.page_count
    from public.hr_assignments a
    join public.hr_employees e on e.id = a.employee_id
    join public.hr_documents d on d.id = a.document_id
    join public.hr_document_versions v on v.id = a.version_id
    where a.id = ${id}`;
  if (!a) throw bad("Not found", 404);
  return a;
}
async function assignmentScoped(ctx: Ctx, id: string) {
  const a = await loadAssignment(id);
  if (!canSee(ctx, a.kind, a.department)) throw bad("Not found", 404);
  return a;
}

function pickVerify(e: { dob: string | null; phone_last4: string | null }) {
  return e.dob ? "dob" : e.phone_last4 ? "phone4" : "email_code";
}
function newRefNo() {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }).replace(/-/g, "").slice(2);
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(4));
  return `HR-${d}-${[...r].map((x) => abc[x % abc.length]).join("")}`;
}

// ---------------------------------------------------------------- admin actions
async function admin(action: string, body: any, req: Request, ctx: Ctx) {
  switch (action) {
    case "meta":
      return {
        role: ctx.role,
        actor: ctx.actor,
        is_admin: ctx.isAdmin,
        departments: ctx.isAdmin ? null : ctx.departments,
        email_mode: EMAIL_MODE,
        kinds: ctx.isAdmin ? KIND_LABEL : { policy: KIND_LABEL.policy, training: KIND_LABEL.training },
        ack_statement: ACK_STATEMENT,
      };

    case "employees_list": {
      const rows = await sql`select id, full_name, email, phone_last4 is not null as has_phone4, dob is not null as has_dob,
          dob, is_minor_override, guardian_name, guardian_email, department, position, active
        from public.hr_employees where voided_at is null order by active desc, full_name`;
      return {
        employees: rows
          .filter((r: any) => ctx.isAdmin || ctx.departments.includes(r.department))
          .map((r: any) => ({
            ...r,
            dob: ctx.isAdmin ? r.dob : undefined,
            minor: isMinor(r),
            guardian_email: ctx.isAdmin ? r.guardian_email : undefined,
          })),
      };
    }

    case "employee_save": {
      mustAdmin(ctx);
      const e = body.employee ?? {};
      const full_name = clean(e.full_name, 120);
      if (!full_name) throw bad("Name is required");
      if (e.email && !isEmail(e.email)) throw bad("Email looks wrong");
      if (e.guardian_email && !isEmail(e.guardian_email)) throw bad("Guardian email looks wrong");
      const p4 = clean(e.phone_last4, 4) || null;
      if (p4 && !/^\d{4}$/.test(p4)) throw bad("Phone last 4 must be 4 digits");
      const row = {
        full_name,
        email: clean(e.email, 200) || null,
        phone_last4: p4,
        dob: clean(e.dob, 10) || null,
        is_minor_override: typeof e.is_minor_override === "boolean" ? e.is_minor_override : null,
        guardian_name: clean(e.guardian_name, 120) || null,
        guardian_email: clean(e.guardian_email, 200) || null,
        department: clean(e.department, 20) || "FOH",
        position: clean(e.position, 80) || null,
        active: e.active !== false,
      };
      let id = e.id as string | undefined;
      if (id) {
        await sql`update public.hr_employees set ${sql(row as any)}, updated_at = now() where id = ${id} and voided_at is null`;
        await audit("employee_updated", ctx.actor, req, { e: id }, { fields: Object.keys(row) });
      } else {
        [{ id }] = await sql`insert into public.hr_employees ${sql(row as any)} returning id`;
        await audit("employee_created", ctx.actor, req, { e: id });
      }
      return { id };
    }

    case "employees_import": {
      // Pull names from the floor-board staff list (no PII). Square import
      // (emails/phones) is wired in production via SQUARE_ACCESS_TOKEN.
      mustAdmin(ctx);
      const staff = await sql`select id, name, role from public.checklist_staff where active is true`;
      let added = 0;
      for (const s of staff) {
        const r = await sql`insert into public.hr_employees (full_name, checklist_staff_id, position)
          values (${s.name}, ${s.id}, ${s.role}) on conflict (checklist_staff_id) do nothing returning id`;
        added += r.length;
      }
      const sq = env("SQUARE_ACCESS_TOKEN");
      if (sq && !DEV) {
        const r = await fetch("https://connect.squareup.com/v2/team-members/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${sq}`, "Square-Version": "2025-01-23", "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 200, query: { filter: { status: "ACTIVE" } } }),
        });
        const j = await r.json().catch(() => ({}));
        for (const m of j.team_members ?? []) {
          const name = [m.given_name, m.family_name].filter(Boolean).join(" ").trim();
          if (!name) continue;
          const p4 = String(m.phone_number ?? "").replace(/\D/g, "").slice(-4) || null;
          const upd = await sql`update public.hr_employees set square_team_member_id = ${m.id},
              email = coalesce(email, ${m.email_address ?? null}), phone_last4 = coalesce(phone_last4, ${p4})
            where lower(full_name) = lower(${name}) and square_team_member_id is null returning id`;
          if (!upd.length) {
            const ins = await sql`insert into public.hr_employees (full_name, email, phone_last4, square_team_member_id)
              values (${name}, ${
              m.email_address ?? null
            }, ${p4}, ${m.id}) on conflict (square_team_member_id) do nothing returning id`;
            added += ins.length;
          }
        }
      }
      await audit("employees_imported", ctx.actor, req, {}, { added });
      return { added };
    }

    case "documents_list": {
      const rows = await sql`select d.*, v.id as version_id, v.version, v.sha256, v.page_count, v.source,
          (select count(*)::int from public.hr_assignments a where a.document_id = d.id and a.status <> 'voided') as assigned,
          (select count(*)::int from public.hr_assignments a where a.document_id = d.id and a.status = 'signed') as signed
        from public.hr_documents d
        join lateral (select * from public.hr_document_versions v where v.document_id = d.id order by version desc limit 1) v on true
        where d.voided_at is null order by d.created_at desc`;
      return { documents: rows.filter((r: any) => ctx.isAdmin || r.kind !== "discipline") };
    }

    case "document_create": {
      mustAdmin(ctx);
      const kind = clean(body.kind, 20);
      if (!KIND_LABEL[kind]) throw bad("Pick a document type");
      const title = clean(body.title, 160);
      if (!title) throw bad("Title is required");
      let bytes: Uint8Array, source: "upload" | "created", body_text: string | null = null;
      if (body.pdf_base64) {
        bytes = unb64(String(body.pdf_base64));
        if (bytes.length > 20 * 1024 * 1024) throw bad("PDF is over 20 MB");
        if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw bad("That file is not a PDF");
        source = "upload";
      } else {
        body_text = clean(body.body_text, 60000);
        if (!body_text) throw bad("Upload a PDF or type the document text");
        bytes = await textToPdf(title, KIND_LABEL[kind], body_text);
        source = "created";
      }
      const pages = await pageCount(bytes).catch(() => {
        throw bad("Could not read that PDF");
      });
      const hash = await sha256(bytes);
      const [d] =
        await sql`insert into public.hr_documents (kind, title, description, policy_key, guardian_for_minors, created_by, created_by_role)
        values (${kind}, ${title}, ${clean(body.description, 500) || null}, ${clean(body.policy_key, 40) || null},
                ${body.guardian_for_minors !== false}, ${ctx.actor}, ${ctx.role}) returning id`;
      const path = `documents/${d.id}/v1-${hash.slice(0, 16)}.pdf`;
      await store.put(path, bytes);
      await sql`insert into public.hr_document_versions (document_id, version, source, original_filename, body_text, storage_path, sha256, page_count, byte_size, created_by)
        values (${d.id}, 1, ${source}, ${
        clean(body.filename, 200) || null
      }, ${body_text}, ${path}, ${hash}, ${pages}, ${bytes.length}, ${ctx.actor})`;
      await audit("document_created", ctx.actor, req, { d: d.id }, { kind, sha256: hash, pages, source });
      return { id: d.id, sha256: hash, pages };
    }

    case "assign": {
      const [doc] = await sql`select d.*, v.id as version_id from public.hr_documents d
        join lateral (select id from public.hr_document_versions where document_id = d.id order by version desc limit 1) v on true
        where d.id = ${body.document_id} and d.voided_at is null`;
      if (!doc) throw bad("Document not found", 404);
      if (!canSee(ctx, doc.kind, "__none__") && doc.kind === "discipline") throw bad("Not found", 404);
      let emps: any[];
      if (body.all_active) {
        emps = await sql`select * from public.hr_employees where active and voided_at is null`;
        // skip anyone who already has an open or signed copy of this doc
        const have = new Set(
          (await sql`select employee_id from public.hr_assignments where document_id = ${doc.id} and status <> 'voided' and status <> 'declined'`)
            .map((r: any) => r.employee_id),
        );
        emps = emps.filter((e) => !have.has(e.id));
      } else {
        const ids: string[] = Array.isArray(body.employee_ids) ? body.employee_ids.slice(0, 200) : [];
        if (!ids.length) throw bad("Pick at least one employee");
        emps = await sql`select * from public.hr_employees where id in ${sql(ids)} and voided_at is null`;
      }
      emps = emps.filter((e) => canSee(ctx, doc.kind, e.department));
      if (doc.kind === "discipline" && emps.length > 1) throw bad("Assign a disciplinary notice to one person at a time");
      const due = clean(body.due_date, 10) || null;
      const out: any[] = [];
      for (const e of emps) {
        const tok = randToken();
        const minor = doc.guardian_for_minors && isMinor(e);
        const ref = await newRefNo();
        const [a] = await sql`insert into public.hr_assignments
          (ref_no, document_id, version_id, employee_id, kind, token_hash, token_expires_at, verify_method,
           guardian_required, guardian_name, guardian_email, due_date, assigned_by, assigned_by_role)
          values (${ref}, ${doc.id}, ${doc.version_id}, ${e.id}, ${doc.kind}, ${await sha256(tok)},
                  now() + make_interval(days => ${LINK_DAYS}), ${pickVerify(e)},
                  ${minor}, ${minor ? e.guardian_name : null}, ${minor ? e.guardian_email : null}, ${due},
                  ${ctx.actor}, ${ctx.role}) returning id, ref_no, employee_id`;
        await audit("sent", ctx.actor, req, { a: a.id, d: doc.id, e: e.id }, { minor, verify: pickVerify(e) });
        const emailed = e.email ? await emailSignRequest(a, doc, e.email, e.full_name, tok, "employee") : false;
        if (emailed) await sql`update public.hr_assignments set last_emailed_at = now() where id = ${a.id}`;
        out.push({
          id: a.id,
          ref_no: a.ref_no,
          employee: e.full_name,
          minor,
          missing_guardian: minor && !isEmail(e.guardian_email),
          emailed,
          link: signLink(tok),
        });
      }
      return { assigned: out };
    }

    case "assignments_list": {
      const st = clean(body.status, 30) || null;
      const rows = await sql`select a.id, a.ref_no, a.kind, a.status, a.created_at, a.viewed_at, a.employee_signed_at,
          a.guardian_required, a.guardian_signed_at, a.completed_at, a.due_date, a.assigned_by, a.voided_at,
          e.full_name, e.department, d.title, d.id as document_id
        from public.hr_assignments a join public.hr_employees e on e.id = a.employee_id
        join public.hr_documents d on d.id = a.document_id
        where (${st}::text is null or a.status = ${st}) and (${body.document_id ?? null}::uuid is null or a.document_id = ${
        body.document_id ?? null
      })
        order by a.created_at desc limit 500`;
      return { assignments: rows.filter((r: any) => canSee(ctx, r.kind, r.department)) };
    }

    case "assignment_get": {
      const a = await assignmentScoped(ctx, body.id);
      const sigs =
        await sql`select party, signer_name, signature_method, comments, ip, user_agent, doc_sha256, signed_at, consent_at, identity_method
        from public.hr_signatures where assignment_id = ${a.id} order by signed_at`;
      const ev =
        await sql`select event, actor, ip, user_agent, detail, created_at from public.hr_audit where assignment_id = ${a.id} order by id`;
      delete a.token_hash;
      delete a.guardian_token_hash;
      delete a.email_code_hash;
      delete a.dob;
      return { assignment: a, signatures: sigs, audit: ev };
    }

    case "remind": {
      // issues a fresh link (old one stops working) and resets lockout
      const a = await assignmentScoped(ctx, body.id);
      if (!["sent", "viewed", "awaiting_guardian"].includes(a.status)) throw bad("Nothing to remind: " + a.status);
      const tok = randToken();
      let emailed = false;
      if (a.status === "awaiting_guardian") {
        await sql`update public.hr_assignments set guardian_token_hash = ${await sha256(tok)},
          guardian_token_expires_at = now() + make_interval(days => ${LINK_DAYS}), guardian_verify_fail_count = 0 where id = ${a.id}`;
        emailed = await emailSignRequest(
          a,
          { title: a.title, kind: a.kind },
          a.guardian_email,
          a.guardian_name || "Parent/Guardian",
          tok,
          "guardian",
          true,
        );
      } else {
        await sql`update public.hr_assignments set token_hash = ${await sha256(
          tok,
        )}, token_expires_at = now() + make_interval(days => ${LINK_DAYS}),
          verify_fail_count = 0, verify_locked_at = null, email_code_hash = null where id = ${a.id}`;
        emailed = await emailSignRequest(a, { title: a.title, kind: a.kind }, a.email, a.full_name, tok, "employee", true);
      }
      if (emailed) await sql`update public.hr_assignments set last_emailed_at = now() where id = ${a.id}`;
      await audit("link_reissued", ctx.actor, req, { a: a.id, d: a.document_id, e: a.employee_id }, { emailed });
      return { emailed, link: signLink(tok) };
    }

    case "record_refusal": {
      const a = await assignmentScoped(ctx, body.id);
      if (!["sent", "viewed"].includes(a.status)) throw bad("Can't record a refusal when status is " + a.status);
      const witness = clean(body.witness, 120);
      if (!witness) throw bad("Witness name is required");
      if (a.completed_at) throw bad("Already completed");
      await sql`update public.hr_assignments set status = 'refused_witnessed', refused_at = now(), refusal_witness = ${witness},
        refusal_note = ${
        clean(body.note, 1000) || null
      }, refusal_recorded_by = ${ctx.actor}, completed_at = now() where id = ${a.id}`;
      await audit("refused_witnessed", ctx.actor, req, { a: a.id, d: a.document_id, e: a.employee_id }, { witness });
      await finalize(a.id);
      return { ok: true };
    }

    case "void": {
      mustAdmin(ctx);
      const a = await assignmentScoped(ctx, body.id);
      const reason = clean(body.reason, 500);
      if (!reason) throw bad("Give a reason for voiding");
      if (a.status === "voided") return { ok: true };
      await sql`update public.hr_assignments set status = 'voided', voided_at = now(), void_reason = ${reason} where id = ${a.id}`;
      await audit("voided", ctx.actor, req, { a: a.id, d: a.document_id, e: a.employee_id }, { reason });
      return { ok: true };
    }

    case "download": {
      const a = await assignmentScoped(ctx, body.id);
      const path = body.which === "original" ? a.storage_path : a.final_pdf_path;
      if (!path) throw bad("No signed PDF yet");
      const bytes = await store.get(path);
      await audit("downloaded_by_admin", ctx.actor, req, { a: a.id, d: a.document_id, e: a.employee_id }, {
        which: body.which ?? "final",
      });
      return { filename: `${a.ref_no}-${body.which === "original" ? "original" : "signed"}.pdf`, pdf_base64: b64(bytes) };
    }

    case "personnel_file": {
      const [e] = await sql`select * from public.hr_employees where id = ${body.employee_id} and voided_at is null`;
      if (!e || !(ctx.isAdmin || ctx.departments.includes(e.department))) throw bad("Not found", 404);
      const rows =
        await sql`select a.id, a.ref_no, a.kind, a.status, a.created_at, a.viewed_at, a.employee_signed_at, a.guardian_required,
          a.guardian_signed_at, a.declined_at, a.refused_at, a.refusal_witness, a.completed_at, a.voided_at, a.void_reason,
          a.final_pdf_sha256, a.assigned_by, d.title, v.version, v.sha256 as doc_sha256
        from public.hr_assignments a join public.hr_documents d on d.id = a.document_id
        join public.hr_document_versions v on v.id = a.version_id
        where a.employee_id = ${e.id} order by a.created_at desc`;
      let legacy: any[] = [];
      if (ctx.isAdmin) {
        // Legacy Write-Ups tab (employee_writeups) shown read-only for admins.
        legacy =
          await sql`select id, ref_no, status, category, level, incident_date, issued_at, acknowledged_at, refused_at, voided_at
          from public.employee_writeups where lower(trim(employee_name)) = lower(trim(${e.full_name})) order by created_at desc`
            .catch(() => []);
      }
      return {
        employee: {
          id: e.id,
          full_name: e.full_name,
          email: e.email,
          department: e.department,
          position: e.position,
          active: e.active,
          minor: isMinor(e),
          dob: ctx.isAdmin ? e.dob : undefined,
          guardian_name: ctx.isAdmin ? e.guardian_name : undefined,
          guardian_email: ctx.isAdmin ? e.guardian_email : undefined,
        },
        documents: rows.filter((r: any) => canSee(ctx, r.kind, e.department)),
        legacy_writeups: legacy,
      };
    }

    case "unsigned": {
      // who has not signed a given document (default: the alcohol acknowledgment)
      const [doc] = body.document_id
        ? await sql`select * from public.hr_documents where id = ${body.document_id} and voided_at is null`
        : await sql`select * from public.hr_documents where policy_key = ${
          clean(body.policy_key, 40) || "alcohol_ack"
        } and voided_at is null order by created_at desc limit 1`;
      if (!doc) return { document: null, rows: [] };
      if (!ctx.isAdmin && doc.kind === "discipline") throw bad("Not found", 404);
      const rows = await sql`select e.id as employee_id, e.full_name, e.email, e.department, e.position,
          a.id as assignment_id, a.ref_no, a.status, a.created_at as sent_at, a.viewed_at, a.last_emailed_at, a.due_date
        from public.hr_employees e
        left join lateral (select * from public.hr_assignments x where x.employee_id = e.id and x.document_id = ${doc.id}
                           and x.status <> 'voided' order by x.created_at desc limit 1) a on true
        where e.active and e.voided_at is null and (a.status is null or a.status <> 'signed')
        order by (a.status is null) desc, e.full_name`;
      return {
        document: { id: doc.id, title: doc.title, kind: doc.kind, policy_key: doc.policy_key },
        rows: rows.filter((r: any) => ctx.isAdmin || ctx.departments.includes(r.department))
          .map((r: any) => ({ ...r, status: r.status ?? "not_sent" })),
      };
    }
  }
  throw bad("Unknown action");
}

// ---------------------------------------------------------------- signer side
type Party = "employee" | "guardian";

async function hmac(data: string) {
  if (!SIGNING_SECRET || SIGNING_SECRET.length < 32) throw bad("Signing is not configured", 503);
  const k = await crypto.subtle.importKey("raw", enc.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data))));
}
async function makeSession(id: string, party: Party, method: string) {
  const exp = Date.now() + SESSION_MIN * 60_000;
  const p = `${id}.${party}.${method}.${exp}`;
  return `${p}.${await hmac(p)}`;
}

async function byToken(tok: string) {
  if (!tok || tok.length < 20) throw bad("This link is not valid.", 404);
  const h = await sha256(tok);
  const [r] =
    await sql`select id, 'employee' as party from public.hr_assignments where token_hash = ${h} and token_expires_at > now()
    union all select id, 'guardian' from public.hr_assignments where guardian_token_hash = ${h} and guardian_token_expires_at > now()`;
  if (!r) throw bad("This link is not valid or has expired. Ask a manager to resend it.", 404);
  return { a: await loadAssignment(r.id), party: r.party as Party };
}
async function bySession(body: any) {
  const { a, party } = await byToken(String(body.t ?? ""));
  const s = String(body.session ?? "").split(".");
  if (s.length !== 5) throw bad("Please verify your identity first.", 401);
  const [id, p, method, exp, sig] = s;
  if (id !== a.id || p !== party || Number(exp) < Date.now() || !safeEq(sig, await hmac(s.slice(0, 4).join(".")))) {
    throw bad("Your session expired. Please verify again.", 401);
  }
  return { a, party, method };
}
function openFor(a: any, party: Party) {
  if (a.status === "voided") throw bad("This document was withdrawn. No action is needed.", 410);
  if (party === "employee" && !["sent", "viewed"].includes(a.status)) return false;
  if (party === "guardian" && a.status !== "awaiting_guardian") return false;
  return true;
}
const idMethodLabel = (
  m: string,
) => ({
  dob: "Private emailed link + date of birth",
  phone4: "Private emailed link + last 4 of phone",
  email_code: "Private emailed link + 6-digit emailed code",
}[m] ?? m);

async function signer(action: string, body: any, req: Request) {
  if (action === "s_load") {
    const { a, party } = await byToken(String(body.t ?? ""));
    if (a.status === "voided") throw bad("This document was withdrawn. No action is needed.", 410);
    const method = party === "guardian" ? (a.dob ? "dob" : "email_code") : a.verify_method;
    // Only non-sensitive info before identity is verified.
    return {
      party,
      first_name: party === "guardian" ? (a.guardian_name || "Parent/Guardian").split(" ")[0] : a.full_name.split(" ")[0],
      kind_label: KIND_LABEL[a.kind],
      ref_no: a.ref_no,
      status: a.status,
      open: openFor(a, party),
      verify_method: method,
      locked: party === "employee" && !!a.verify_locked_at,
    };
  }

  if (action === "s_send_code") {
    const { a, party } = await byToken(String(body.t ?? ""));
    const method = party === "guardian" ? (a.dob ? "dob" : "email_code") : a.verify_method;
    if (method !== "email_code") throw bad("Not needed");
    if (a.email_code_expires_at && new Date(a.email_code_expires_at).getTime() - 9 * 60_000 > Date.now()) {
      throw bad("A code was just sent. Wait a minute before asking again.", 429);
    }
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await sql`update public.hr_assignments set email_code_hash = ${await sha256(a.id + party + code)},
      email_code_expires_at = now() + interval '10 minutes' where id = ${a.id}`;
    const to = party === "guardian" ? a.guardian_email : a.email;
    await sendEmail(
      to,
      `Your Quarry verification code: ${code}`,
      emailShell(
        "Verification code",
        `<p>Your code is <strong style="font-size:22px;letter-spacing:3px">${code}</strong>. It expires in 10 minutes.</p>`,
      ),
      { a: a.id, e: a.employee_id },
    );
    await audit("code_sent", party, req, { a: a.id, d: a.document_id, e: a.employee_id });
    return { sent: true, to_hint: String(to ?? "").replace(/^(.).*(@.*)$/, "$1***$2"), dev_code: DEV ? code : undefined };
  }

  if (action === "s_verify") {
    const { a, party } = await byToken(String(body.t ?? ""));
    if (a.status === "voided") throw bad("This document was withdrawn.", 410);
    const failCol = party === "guardian" ? "guardian_verify_fail_count" : "verify_fail_count";
    if (a[failCol] >= MAX_VERIFY) {
      throw bad("Too many tries. Ask a manager to resend your link.", 423);
    }
    const method = party === "guardian" ? (a.dob ? "dob" : "email_code") : a.verify_method;
    const ans = clean(body.answer, 20);
    let ok = false;
    if (method === "dob") {
      ok = safeEq(ans, String(a.dob).slice(0, 10));
    } else if (method === "phone4") {
      const [e] = await sql`select phone_last4 from public.hr_employees where id = ${a.employee_id}`;
      ok = !!e?.phone_last4 && safeEq(ans.replace(/\D/g, ""), e.phone_last4);
    } else {
      ok = !!a.email_code_hash && new Date(a.email_code_expires_at) > new Date() &&
        safeEq(await sha256(a.id + party + ans.replace(/\D/g, "")), a.email_code_hash);
    }
    if (!ok) {
      const [r] = await sql`update public.hr_assignments set ${sql(failCol)} = ${sql(failCol)} + 1,
        verify_locked_at = case when ${party} = 'employee' and verify_fail_count + 1 >= ${MAX_VERIFY} then now() else verify_locked_at end
        where id = ${a.id} returning ${sql(failCol)} as n`;
      await audit("verify_failed", party, req, { a: a.id, d: a.document_id, e: a.employee_id }, { method, tries: r.n });
      throw bad(`That didn't match. ${Math.max(0, MAX_VERIFY - r.n)} tries left.`, 403);
    }
    if (method === "email_code") await sql`update public.hr_assignments set email_code_hash = null where id = ${a.id}`;
    await audit("identity_verified", party, req, { a: a.id, d: a.document_id, e: a.employee_id }, { method });
    return { session: await makeSession(a.id, party, method) };
  }

  const { a, party, method } = await bySession(body);

  if (action === "s_doc") {
    const bytes = await store.get(a.storage_path);
    const hash = await sha256(bytes);
    if (hash !== a.doc_sha256) {
      await audit("integrity_failure", "system", req, { a: a.id, d: a.document_id, e: a.employee_id });
      throw bad("This document failed an integrity check. Please tell a manager.", 500);
    }
    if (party === "employee" && a.status === "sent") {
      await sql`update public.hr_assignments set status = 'viewed', viewed_at = now() where id = ${a.id} and status = 'sent'`;
    }
    if (party === "guardian" && !a.guardian_viewed_at) {
      await sql`update public.hr_assignments set guardian_viewed_at = now() where id = ${a.id}`;
    }
    await audit("viewed", party, req, { a: a.id, d: a.document_id, e: a.employee_id }, { sha256: hash });
    const [emp] = party === "guardian"
      ? await sql`select signer_name, signed_at, comments from public.hr_signatures where assignment_id = ${a.id} and party = 'employee'`
      : [null];
    return {
      title: a.title,
      kind_label: KIND_LABEL[a.kind],
      ref_no: a.ref_no,
      version: a.version,
      sha256: hash,
      pages: a.page_count,
      employee_name: a.full_name,
      status: party === "employee" && a.status === "sent" ? "viewed" : a.status,
      open: openFor(a, party),
      guardian_required: a.guardian_required,
      employee_signature: emp ? { name: emp.signer_name, signed_at_ct: fmtCT(emp.signed_at) } : null,
      ack_statement: ACK_STATEMENT,
      consent_statement: CONSENT_STATEMENT,
      final_ready: !!a.final_pdf_path,
      pdf_base64: b64(bytes),
    };
  }

  if (action === "s_consent") {
    if (!openFor(a, party)) throw bad("This document is already complete.", 409);
    if (body.consent !== true) throw bad("Please agree to sign electronically first.");
    await audit("consented", party, req, { a: a.id, d: a.document_id, e: a.employee_id }, {
      statement_sha256: await sha256(CONSENT_STATEMENT),
    });
    return { consent_at: new Date().toISOString() };
  }

  if (action === "s_sign") {
    if (!openFor(a, party)) throw bad("This document is already complete.", 409);
    if (body.consent !== true) throw bad("Please agree to sign electronically first.");
    if (body.ack !== true) throw bad("Please check the acknowledgment box.");
    const name = clean(body.signer_name, 120);
    if (name.length < 3) throw bad("Type your full name.");
    const methodSig = body.signature_method === "drawn" ? "drawn" : "typed";
    const img = methodSig === "drawn" ? String(body.signature_image ?? "") : null;
    if (methodSig === "drawn" && (!img!.startsWith("data:image/png;base64,") || img!.length > 400_000)) {
      throw bad("Please draw your signature again.");
    }
    if (body.doc_sha256 !== a.doc_sha256) throw bad("The document changed while you were viewing it. Reload the page.", 409);
    // re-hash the stored bytes at signing time
    const hash = await sha256(await store.get(a.storage_path));
    if (hash !== a.doc_sha256) throw bad("This document failed an integrity check. Please tell a manager.", 500);
    // consent must have been recorded server-side (s_consent) in this session
    const [c] = await sql`select created_at from public.hr_audit where assignment_id = ${a.id} and event = 'consented'
      and actor = ${party} and created_at > now() - interval '2 hours' order by id desc limit 1`;
    if (!c) throw bad("Please agree to sign electronically first.");
    const consentAt = c.created_at;
    await sql.begin(async (tx: any) => {
      await tx`insert into public.hr_signatures (assignment_id, party, signer_name, signature_method, signature_image, comments,
          ack_statement, consent_statement, consent_at, identity_method, ip, user_agent, doc_sha256)
        values (${a.id}, ${party}, ${name}, ${methodSig}, ${img}, ${clean(body.comments, 4000) || null},
          ${ACK_STATEMENT}, ${CONSENT_STATEMENT}, ${consentAt}, ${idMethodLabel(method)}, ${ipOf(req)}, ${uaOf(req)}, ${hash})`;
      if (party === "employee") {
        const needG = a.guardian_required;
        await tx`update public.hr_assignments set employee_signed_at = now(),
          status = ${needG ? "awaiting_guardian" : "signed"}, completed_at = ${needG ? null : new Date()}
          where id = ${a.id}`;
      } else {
        await tx`update public.hr_assignments set guardian_signed_at = now(), status = 'signed', completed_at = now() where id = ${a.id}`;
      }
    });
    await audit(
      party === "guardian" ? "guardian_signed" : "signed",
      party,
      req,
      { a: a.id, d: a.document_id, e: a.employee_id },
      { sha256: hash, method: methodSig },
    );
    let guardian: string | null = null;
    if (party === "employee" && a.guardian_required) {
      if (isEmail(a.guardian_email)) {
        const gt = randToken();
        await sql`update public.hr_assignments set guardian_token_hash = ${await sha256(gt)},
          guardian_token_expires_at = now() + make_interval(days => ${LINK_DAYS}) where id = ${a.id}`;
        await emailSignRequest(
          a,
          { title: a.title, kind: a.kind },
          a.guardian_email,
          a.guardian_name || "Parent/Guardian",
          gt,
          "guardian",
        );
        await audit("guardian_requested", "system", null, { a: a.id, d: a.document_id, e: a.employee_id });
        guardian = "sent";
        if (DEV) guardian = signLink(gt);
      } else {
        await audit("guardian_missing_email", "system", null, { a: a.id, d: a.document_id, e: a.employee_id });
        guardian = "missing";
      }
      return { status: "awaiting_guardian", guardian };
    }
    await finalize(a.id);
    return { status: "signed" };
  }

  if (action === "s_decline") {
    if (party !== "employee" || !openFor(a, party)) throw bad("Nothing to decline.", 409);
    await sql`update public.hr_assignments set status = 'declined', declined_at = now(),
      decline_reason = ${clean(body.reason, 1000) || null}, completed_at = now() where id = ${a.id}`;
    await audit("declined", party, req, { a: a.id, d: a.document_id, e: a.employee_id });
    await finalize(a.id);
    return { status: "declined" };
  }

  if (action === "s_download") {
    if (!a.final_pdf_path) throw bad("The signed copy is not ready yet.", 409);
    const bytes = await store.get(a.final_pdf_path);
    await audit("downloaded", party, req, { a: a.id, d: a.document_id, e: a.employee_id });
    return { filename: `${a.ref_no}-signed.pdf`, pdf_base64: b64(bytes) };
  }

  throw bad("Unknown action");
}

// Build the locked final PDF (original + acknowledgment + audit page), store
// it once (no overwrite), record its hash, and email copies.
async function finalize(id: string) {
  const a = await loadAssignment(id);
  if (a.final_pdf_path) return;
  const sigs = await sql`select * from public.hr_signatures where assignment_id = ${id} order by signed_at`;
  const ev = await sql`select created_at, event, actor, ip, user_agent from public.hr_audit
    where assignment_id = ${id} and event not like 'email_%' order by id`;
  const original = await store.get(a.storage_path);
  const outcome = a.status === "signed" ? "signed" : a.status === "declined" ? "declined" : "refused_witnessed";
  const bytes = await buildFinalPdf({
    originalBytes: original,
    title: a.title,
    kindLabel: KIND_LABEL[a.kind],
    refNo: a.ref_no,
    version: a.version,
    docSha256: a.doc_sha256,
    employeeName: a.full_name,
    outcome,
    ackStatement: ACK_STATEMENT,
    signatures: sigs as any,
    decline: a.declined_at ? { at: a.declined_at, reason: a.decline_reason } : undefined,
    refusal: a.refused_at
      ? { at: a.refused_at, witness: a.refusal_witness, note: a.refusal_note, recordedBy: a.refusal_recorded_by }
      : undefined,
    audit: ev as any,
    generatedAt: new Date(),
  });
  const hash = await sha256(bytes);
  const path = `final/${a.employee_id}/${a.ref_no}-${hash.slice(0, 16)}.pdf`;
  await store.put(path, bytes);
  await sql`update public.hr_assignments set final_pdf_path = ${path}, final_pdf_sha256 = ${hash} where id = ${id}`;
  await audit("final_pdf_created", "system", null, { a: id, d: a.document_id, e: a.employee_id }, { sha256: hash });
  const att = { name: `${a.ref_no}-signed.pdf`, bytes };
  const msg = emailShell(
    "Your signed copy",
    `<p>Attached is your copy of <strong>${esc(a.title)}</strong> (ref ${
      esc(a.ref_no)
    }). You can also download it from the same link until it expires.</p>`,
  );
  if (outcome === "signed" && a.email) {
    await sendEmail(a.email, `Signed copy - ${a.title} (${a.ref_no})`, msg, { a: id, e: a.employee_id }, att);
  }
  if (outcome === "signed" && a.guardian_required && a.guardian_email) {
    await sendEmail(a.guardian_email, `Signed copy - ${a.title} (${a.ref_no})`, msg, { a: id, e: a.employee_id }, att);
  }
  if (COPY_EMAIL) {
    await sendEmail(
      COPY_EMAIL,
      `[HR] ${outcome} - ${a.full_name} - ${a.title} (${a.ref_no})`,
      msg,
      { a: id, e: a.employee_id },
      att,
    );
  }
}

// ---------------------------------------------------------------- entry
export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    if (action.startsWith("s_")) return json(await signer(action, body, req));
    const ctx = await adminCtx(req);
    return json(await admin(action, body, req, ctx));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("hr-docs error", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
