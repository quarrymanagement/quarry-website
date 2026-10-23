// Supabase Edge Function: square-webhook
//
// Version 23 — 2026-10-02
// EXACTLY-ONCE FORWARDING + VENDOR REFUNDS. Square delivers each payment.updated
// several times within a second or two. The old isFirstCompletedPayment() check
// counted logged deliveries, and when 2+ copies landed before any of them counted,
// every copy saw count > 1 and NOTHING was forwarded (Sweep Dreams + Sherrys
// Sourdough vendor payments were missed this way). Forwarding to Netlify now
// takes a claim in public.square_forward_claims (primary key = payment id, or
// "<id>:refund"); exactly one delivery wins and forwards, and the claim is
// released if Netlify doesn't answer 2xx so a redelivery can retry. Used for
// golf and Quarry Fest vendor payments. Fully refunded vendor payments are now
// forwarded too (claim "<id>:refund") so Netlify marks the vendor Refunded.
// backfill-quarryfest forwards the LATEST logged state of each vendor payment
// (so refunds replay too); Netlify is idempotent for both paths.
//
// Version 22 — 2026-10-01
// QUARRY FEST VENDOR PAYMENTS. Vendor sign-ups (quarryfest-vendor-register.js)
// pay through Square, but this webhook only forwarded golf and subscription
// payments to Netlify, so the vendor's Netlify blob record stayed
// "pending_payment" forever. Completed payments whose note starts with
// "Quarry Fest Vendor - " are now forwarded (first completed delivery only)
// to the Netlify webhook, whose handleQuarryFestVendor marks the vendor
// booked and sends the confirmation emails. GET ?action=backfill-quarryfest
// forwards any already-logged vendor payments (one-time catch-up).
//
// Version 21 — 2026-10-01
// REFUNDS NOW RELEASE SEATS. When a ticket payment is refunded in Square, Square
// re-sends payment.updated with refunded_money set (status stays COMPLETED).
// Previously that looked like any other redelivery ("already_recorded"), so the
// refunded table/seats stayed counted as sold forever. Now:
//   - FULL refund (refunded_money >= amount_money): the registration is moved
//     from ev.registrations[] to ev.refundedRegistrations[] (kept for the
//     record, with refundedAt / refundedCents), registeredCount is recomputed,
//     a 'sold-out' event flips back to 'available' when space opened up, and
//     management gets a "seats released" email. Every seat counter on the site
//     (event-register.js, quarry-event-detail.html, admin) reads
//     ev.registrations[], so the spots reopen with no other changes.
//   - PARTIAL refund: the registration is stamped with refundedCents but keeps
//     its seats (a partial refund is usually a price adjustment, not a no-show).
//   - applyRegistrations() never re-adds a payment that is in
//     refundedRegistrations[], so a late redelivery can't resurrect it or send
//     a second "You're booked" email.
//   - GET ?action=backfill-refunds&key=... replays every refunded event payment
//     already in square_webhook_log (one-time catch-up for earlier refunds).
//
// Versions 13-20 (seating, waves, add-ons, emails, UTF-8 fix): full change history
// is in the Claude project doc supabase-square-webhook.index.ts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SIG_KEY = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY")!;

const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const GITHUB_REPO = "quarrymanagement/quarry-website";
const BACKFILL_KEY = "zesa-sync-2026-06";

// Forward golf + subscription events to the existing Netlify webhook (which has all
// the golf calendar / email / wine-club logic). We re-sign with Netlify's own Square
// signing key so its signature check passes. Set NETLIFY_SQUARE_SIG_KEY = the value of
// Netlify's SQUARE_WEBHOOK_SIGNATURE_KEY env var.
const NETLIFY_WEBHOOK_URL = "https://thequarrystl.com/.netlify/functions/square-webhook";
const NETLIFY_SIG_KEY = Deno.env.get("NETLIFY_SQUARE_SIG_KEY") || "";

// Transactional email (v16). SENDGRID_API_KEY is set on this project.
const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY") || "";
const FROM_EMAIL = "bookings@thequarrystl.com";
const FROM_NAME = "The Quarry STL";
const VENUE_EMAIL = "management@thequarrystl.com";
const VENUE_ADDRESS = "The Quarry, 3960 Highway Z, New Melle, MO 63385";
const VENUE_PHONE = "(636) 224-8257";
// v17: derived from VENUE_PHONE so the two can never drift apart.
const VENUE_PHONE_TEL = "+1" + VENUE_PHONE.replace(/\D/g, "");

const supa = createClient(SUPABASE_URL, SERVICE_KEY);

async function hmacB64(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

async function verify(rawBody: string, notificationUrl: string, signatureB64: string): Promise<boolean> {
  const expected = await hmacB64(SIG_KEY, notificationUrl + rawBody);
  if (expected.length !== signatureB64.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureB64.charCodeAt(i);
  return diff === 0;
}

// Re-sign a webhook body for Netlify and POST it. Returns the HTTP status.
async function forwardToNetlify(rawBody: string): Promise<number> {
  if (!NETLIFY_SIG_KEY) return 0;
  const sig = await hmacB64(NETLIFY_SIG_KEY, NETLIFY_WEBHOOK_URL + rawBody);
  const res = await fetch(NETLIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-square-hmacsha256-signature": sig },
    body: rawBody,
  });
  return res.status;
}

// Only forward the FIRST completed delivery of a given payment id (Square delivers
// payment.updated several times) so golf calendar events / emails aren't duplicated.
async function isFirstCompletedPayment(paymentId: string): Promise<boolean> {
  const { data } = await supa.from("square_webhook_log").select("payload")
    .eq("payload->data->object->payment->>id", paymentId);
  let completed = 0;
  for (const r of (data || [])) {
    const st = (r as any)?.payload?.data?.object?.payment?.status;
    if (st === "COMPLETED" || st === "APPROVED") completed++;
  }
  return completed <= 1;
}

// v23: exactly-once forwarding guard. Returns true for the one caller that wins.
async function claimForward(key: string): Promise<boolean> {
  const { error } = await supa.from("square_forward_claims").insert({ claim_key: key });
  if (!error) return true;
  if ((error as any).code === "23505") return false; // someone else already forwarded it
  console.error("claimForward error (forwarding anyway):", error.message);
  return true; // fail open: a duplicate is better than a lost booking
}
async function releaseClaim(key: string): Promise<void> {
  await supa.from("square_forward_claims").delete().eq("claim_key", key).then(() => {}, () => {});
}
async function forwardOnce(key: string, rawBody: string, label: string): Promise<void> {
  if (!(await claimForward(key))) { console.log(label + " forward: already claimed", key); return; }
  let st = 0;
  try { st = await forwardToNetlify(rawBody); } catch (e) { console.error(label + " forward error:", (e as Error).message); }
  console.log(label + " forward:", key, st);
  if (!(st >= 200 && st < 300)) await releaseClaim(key);
}

async function checkPaymentMilestones(weddingId: string) {
  const [{ data: w }, { data: pays }] = await Promise.all([
    supa.from("weddings").select("total_contract_amount").eq("id", weddingId).single(),
    supa.from("wedding_payments").select("amount, paid, label").eq("wedding_id", weddingId),
  ]);
  if (!pays) return;
  const paidTotal = pays.filter((p: any) => p.paid).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
  if (paidTotal <= 0) return;
  const scheduledTotal = pays.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
  const contractTotal = Number(w?.total_contract_amount || scheduledTotal || 0);
  const titlesToTick: string[] = ["Collect initial deposit"];
  if (contractTotal > 0) {
    const pct = paidTotal / contractTotal;
    if (pct >= 0.5 - 1e-6) titlesToTick.push("50% payment received");
    if (pct >= 0.75 - 1e-6) titlesToTick.push("75% payment received");
    if (pct >= 1.0 - 1e-6) titlesToTick.push("Final payment (100%) received");
  }
  await supa.from("wedding_tasks").update({ completed: true, completed_at: new Date().toISOString() })
    .eq("wedding_id", weddingId).in("title", titlesToTick).eq("completed", false);
}

function gh(method: string, path: string, body?: unknown) {
  return fetch("https://api.github.com" + path, {
    method,
    headers: { "Authorization": "token " + GITHUB_TOKEN, "User-Agent": "Quarry-Square-Webhook", "Accept": "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Authenticated raw-media read of events.json (works when the repo is private;
// the anonymous raw.githubusercontent.com URL 404s then). Same body as before.
async function ghRawEvents(): Promise<Response> {
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/events.json?ref=main`, {
    headers: { "Authorization": "token " + GITHUB_TOKEN, "User-Agent": "Quarry-Square-Webhook", "Accept": "application/vnd.github.raw" },
  });
  if (!r.ok) throw new Error("events.json raw read failed: " + r.status);
  return r;
}

function parseEventPayment(p: any): { eventName: string; qty: number; email: string; paymentId: string; amountCents: number; currency: string } | null {
  const note: string = p?.note || "";
  if (!note.startsWith("Event - ")) return null;
  const m = note.match(/x(\d+)\s*$/);
  const qty = m ? parseInt(m[1], 10) : 1;
  const eventName = note.replace(/^Event - /, "").replace(/\s*x\d+\s*$/, "").trim();
  // v17: what the guest actually paid, for the receipt line in the confirmation email.
  const amountCents = Number(p?.amount_money?.amount) || 0;
  const currency = String(p?.amount_money?.currency || "USD");
  return { eventName, qty: qty > 0 ? qty : 1, email: p?.buyer_email_address || "", paymentId: p?.id || "", amountCents, currency };
}

// --- Note matchers (v16) -----------------------------------------------------
// Square drops order metadata at payment time, so the seating option and the arrival
// wave are recovered from payment.note by matching the event's own known values against
// it. Longest candidate first so e.g. "10:00 AM" is not shadowed by "0:00 AM"-style
// substrings. Returns null (never throws) when nothing matches — older notes and
// non-table events simply carry no such text.
function matchSeatingOption(note: string, options: any[]): { seatingOptionId: string; seatingOptionName: string; seats: number } | null {
  const n = String(note || "").toLowerCase();
  if (!n) return null;
  const cands = (Array.isArray(options) ? options : [])
    .filter((o: any) => o && String(o.name || "").trim())
    .slice()
    .sort((a: any, b: any) => String(b.name).length - String(a.name).length);
  for (const o of cands) {
    const nm = String(o.name).trim();
    if (n.includes(nm.toLowerCase())) {
      return { seatingOptionId: String(o.id || ""), seatingOptionName: nm, seats: Number(o.seats) || 0 };
    }
  }
  return null;
}

function matchArrivalSlot(note: string, slots: any[]): { arrivalSlot: string; arrivalLabel: string } | null {
  const n = String(note || "").toLowerCase();
  if (!n) return null;
  const cands = (Array.isArray(slots) ? slots : [])
    .filter((s: any) => s && String(s.label || "").trim())
    .slice()
    .sort((a: any, b: any) => String(b.label).length - String(a.label).length);
  for (const s of cands) {
    const lb = String(s.label).trim();
    if (n.includes(lb.toLowerCase())) return { arrivalSlot: String(s.id || ""), arrivalLabel: lb };
  }
  return null;
}

// --- Add-on matcher (v18) -----------------------------------------------------
// Add-ons (e.g. merch) ride as EXTRA Square line items beyond the main ticket
// line(s), added by event-register.js. Order line items (unlike order.metadata)
// survive payment, so — unlike seating/arrival — these are read directly from
// the order rather than recovered from payment.note. Matched by exact name
// against the event's own known addOns[], so a line item that happens to be
// the main ticket (named "<tier/seating> - <event name>") never matches.
type MatchedAddOn = { name: string; qty: number; sizes: string[] };

function matchAddOns(lineItems: LineItemInfo[], addOnDefs: any[]): MatchedAddOn[] {
  const defs = Array.isArray(addOnDefs) ? addOnDefs : [];
  if (!defs.length || !Array.isArray(lineItems) || !lineItems.length) return [];
  const nameSet = new Map<string, string>();
  for (const d of defs) {
    const nm = String(d?.name || "").trim();
    if (nm) nameSet.set(nm.toLowerCase(), nm);
  }
  const out: MatchedAddOn[] = [];
  for (const li of lineItems) {
    const liName = String(li?.name || "").trim();
    const canonical = nameSet.get(liName.toLowerCase());
    if (!canonical) continue;
    const qty = Math.max(1, parseInt(String(li?.quantity || "1"), 10) || 1);
    const sizesMatch = /^Sizes:\s*(.+)$/i.exec(String(li?.note || "").trim());
    const sizes = sizesMatch ? sizesMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    out.push({ name: canonical, qty, sizes });
  }
  return out;
}

// --- Email (v16, reworked v17) -----------------------------------------------
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "2026-08-30" -> "Sunday, August 30, 2026". Anything else is passed through unchanged.
function formatEventDate(d: unknown): string {
  const raw = String(d || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return raw;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(dt.getTime())) return raw;
  return `${DAY_NAMES[dt.getUTCDay()]}, ${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

// v17: ev.time is a 24-hour "HH:MM" string. "09:00" -> "9:00 AM", "12:30" -> "12:30 PM",
// "00:30" -> "12:30 AM". Returns "" for anything missing or unparseable so the caller
// can omit the row rather than print a raw value at a paying guest.
function formatEventTime(t: unknown): string {
  const raw = String(t == null ? "" : t).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return "";
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mins)) return "";
  if (h < 0 || h > 23 || mins < 0 || mins > 59) return "";
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

// v17: integer cents -> "$100.00". Empty string when there is nothing to show, so the
// Paid row is omitted rather than reading "$0.00".
function formatAmount(cents: unknown): string {
  const c = Number(cents);
  if (!Number.isFinite(c) || c <= 0) return "";
  return "$" + (Math.round(c) / 100).toFixed(2);
}

// v17: qty is a SEAT count, so tables = qty / seats.
//   1 x 4-Top Table (4 seats) | 3 x 4-Top Table (12 seats total) | 2 x Bar Seat | 4 seats
function formatBooked(qty: number, seatingOptionName: string, seats: number): string {
  const q = Number(qty) > 0 ? Number(qty) : 1;
  const s = Number(seats) > 0 ? Number(seats) : 0;
  const name = String(seatingOptionName || "").trim();
  if (name && s > 1) {
    const units = Math.max(1, Math.round(q / s));
    const totalSeats = units * s;
    return units === 1
      ? `1 x ${name} (${s} seats)`
      : `${units} x ${name} (${totalSeats} seats total)`;
  }
  if (name) return `${q} x ${name}`;
  return `${q} ${q === 1 ? "seat" : "seats"}`;
}

function esc(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// v17: SendGrid requires content parts in ascending order of richness, so text/plain
// must come before text/html. A plain-text alternative materially helps deliverability.
async function sendEmail(to: string, subject: string, html: string, replyTo?: string, text?: string): Promise<void> {
  if (!SENDGRID_API_KEY) { console.warn("sendgrid: no API key set, skipping email"); return; }
  if (!to) return;
  const content: Array<{ type: string; value: string }> = [];
  if (text && String(text).trim()) content.push({ type: "text/plain", value: String(text) });
  content.push({ type: "text/html", value: html });
  const body: Record<string, unknown> = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content,
  };
  if (replyTo) body.reply_to = { email: replyTo };
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": "Bearer " + SENDGRID_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("sendgrid_" + res.status + " " + t.slice(0, 300));
  }
}

type PendingEmail = {
  ev: any; email: string; qty: number; paymentId: string;
  seatingOptionName: string; seats: number; arrivalLabel: string;
  amountCents?: number; currency?: string;
  addOns?: MatchedAddOn[];
};

// v18: renders "2 x Witch Kit - T-Shirt (M, XL); 1 x Witch Kit - Headband" —
// sizes only appear when the add-on actually carried any.
function formatAddOns(addOns: MatchedAddOn[] | undefined): string {
  if (!addOns || !addOns.length) return "";
  return addOns.map((a) => a.sizes.length ? `${a.qty} x ${a.name} (${a.sizes.join(", ")})` : `${a.qty} x ${a.name}`).join("; ");
}

// Guest confirmation + venue alert. Only ever called for a newly added, non-backfilled
// registration AFTER the GitHub write succeeded. Each send is isolated so a failure
// can never prevent — or undo — the registration being recorded.
async function sendRegistrationEmails(pe: PendingEmail): Promise<void> {
  const ev = pe.ev || {};
  const eventName = String(ev.name || "");
  const dateLine = formatEventDate(ev.date);
  const timeLine = formatEventTime(ev.time);
  const booked = formatBooked(pe.qty, pe.seatingOptionName, pe.seats);
  const paidLine = formatAmount(pe.amountCents);
  const reference = String(pe.paymentId || "");
  const addOnLine = formatAddOns(pe.addOns);

  const rows: string[] = [];
  if (dateLine) rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Date</td><td style="padding:6px 0;"><strong>${esc(dateLine)}</strong></td></tr>`);
  if (timeLine) rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Time</td><td style="padding:6px 0;"><strong>${esc(timeLine)}</strong></td></tr>`);
  rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Booked</td><td style="padding:6px 0;"><strong>${esc(booked)}</strong></td></tr>`);
  if (addOnLine) rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Add-ons</td><td style="padding:6px 0;"><strong>${esc(addOnLine)}</strong></td></tr>`);
  if (paidLine) rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Paid</td><td style="padding:6px 0;"><strong>${esc(paidLine)}</strong></td></tr>`);
  if (reference) rows.push(`<tr><td style="padding:6px 12px 6px 0;color:#666;">Reference</td><td style="padding:6px 0;"><span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;">${esc(reference)}</span></td></tr>`);

  const guestHtml = `<!doctype html><html><body style="margin:0;padding:0;background:#f5f4f2;">
<div style="max-width:560px;margin:0 auto;padding:24px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#222;">
  <h1 style="margin:0 0 6px;font-size:22px;line-height:1.3;">You're booked!</h1>
  <p style="margin:0 0 18px;font-size:18px;"><strong>${esc(eventName)}</strong></p>
  ${pe.arrivalLabel ? `<p style="margin:0 0 18px;padding:12px 14px;background:#fff;border-left:4px solid #7a6a55;border-radius:4px;font-size:17px;"><strong>Please arrive at ${esc(pe.arrivalLabel)}</strong></p>` : ""}
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;padding:4px 14px;margin:0 0 8px;font-size:16px;">
    ${rows.join("")}
  </table>
  <p style="margin:0 0 18px;color:#666;font-size:14px;">Keep this email as your receipt.</p>
  <p style="margin:0 0 6px;color:#666;">Where to find us</p>
  <p style="margin:0 0 18px;"><strong>${esc(VENUE_ADDRESS)}</strong><br><a href="tel:${esc(VENUE_PHONE_TEL)}" style="color:#7a6a55;">${esc(VENUE_PHONE)}</a></p>
  <p style="margin:0 0 18px;">Questions, or need to change something? Just reply to this email and we'll take care of it.</p>
  <p style="margin:0;color:#666;">See you soon,<br>The Quarry</p>
</div></body></html>`;

  const guestTextLines: string[] = [];
  guestTextLines.push("You're booked!");
  guestTextLines.push("");
  if (eventName) { guestTextLines.push(eventName); guestTextLines.push(""); }
  if (pe.arrivalLabel) { guestTextLines.push(`Please arrive at ${pe.arrivalLabel}`); guestTextLines.push(""); }
  if (dateLine) guestTextLines.push(`Date: ${dateLine}`);
  if (timeLine) guestTextLines.push(`Time: ${timeLine}`);
  guestTextLines.push(`Booked: ${booked}`);
  if (addOnLine) guestTextLines.push(`Add-ons: ${addOnLine}`);
  if (paidLine) guestTextLines.push(`Paid: ${paidLine}`);
  if (reference) guestTextLines.push(`Reference: ${reference}`);
  guestTextLines.push("");
  guestTextLines.push("Keep this email as your receipt.");
  guestTextLines.push("");
  guestTextLines.push("Where to find us");
  guestTextLines.push(VENUE_ADDRESS);
  guestTextLines.push(VENUE_PHONE);
  guestTextLines.push("");
  guestTextLines.push("Questions, or need to change something? Just reply to this email and we'll take care of it.");
  guestTextLines.push("");
  guestTextLines.push("See you soon,");
  guestTextLines.push("The Quarry");
  const guestText = guestTextLines.join("\n");

  const venueHtml = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;">
  <h2 style="margin:0 0 12px;font-size:18px;">New registration — ${esc(eventName)}</h2>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px;">
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Guest email</td><td style="padding:4px 0;">${esc(pe.email)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Quantity</td><td style="padding:4px 0;">${esc(pe.qty)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Seating option</td><td style="padding:4px 0;">${esc(pe.seatingOptionName || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Arrival wave</td><td style="padding:4px 0;">${esc(pe.arrivalLabel || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Add-ons</td><td style="padding:4px 0;">${esc(addOnLine || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Paid</td><td style="padding:4px 0;">${esc(paidLine || "—")}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Payment id</td><td style="padding:4px 0;">${esc(pe.paymentId)}</td></tr>
    <tr><td style="padding:4px 14px 4px 0;color:#666;">Running total</td><td style="padding:4px 0;"><strong>${esc(ev.registeredCount ?? "?")} / ${esc(ev.totalCapacity ?? "?")}</strong></td></tr>
  </table>
</body></html>`;

  const venueText = [
    `New registration — ${eventName}`,
    "",
    `Guest email: ${pe.email}`,
    `Quantity: ${pe.qty}`,
    `Seating option: ${pe.seatingOptionName || "—"}`,
    `Arrival wave: ${pe.arrivalLabel || "—"}`,
    `Add-ons: ${addOnLine || "—"}`,
    `Paid: ${paidLine || "—"}`,
    `Payment id: ${pe.paymentId}`,
    `Running total: ${ev.registeredCount ?? "?"} / ${ev.totalCapacity ?? "?"}`,
  ].join("\n");

  try {
    await sendEmail(pe.email, `You're booked — ${eventName}`, guestHtml, VENUE_EMAIL, guestText);
  } catch (e) {
    console.error("guest confirmation email failed:", pe.paymentId, (e as Error).message);
  }
  try {
    await sendEmail(VENUE_EMAIL, `New registration — ${eventName} (${pe.qty} seats)`, venueHtml, pe.email || undefined, venueText);
  } catch (e) {
    console.error("venue alert email failed:", pe.paymentId, (e as Error).message);
  }
}

// Order metadata written by netlify/functions/event-register.js. NOTE (v16): Square
// discards this metadata once the order is paid, so in practice these come back empty
// for real registrations — see the note matchers above.
type LineItemInfo = { name: string; quantity: string; note: string };

type OrderInfo = { name: string; phone: string; seatingOptionId: string; seatingOptionName: string; seatType: string; eventId: string; arrivalSlot: string; arrivalLabel: string; lineItems: LineItemInfo[] };

const EMPTY_ORDER_INFO: OrderInfo = { name: "", phone: "", seatingOptionId: "", seatingOptionName: "", seatType: "", eventId: "", arrivalSlot: "", arrivalLabel: "", lineItems: [] };

async function lookupOrderInfo(orderId: string): Promise<OrderInfo> {
  const tok = Deno.env.get("SQUARE_ACCESS_TOKEN");
  if (!tok || !orderId) return EMPTY_ORDER_INFO;
  try {
    const env = (Deno.env.get("SQUARE_ENVIRONMENT") || "production").toLowerCase();
    const host = env === "sandbox" ? "connect.squareupsandbox.com" : "connect.squareup.com";
    const res = await fetch(`https://${host}/v2/orders/${orderId}`, { headers: { "Authorization": "Bearer " + tok, "Square-Version": "2024-08-21" } });
    if (!res.ok) return EMPTY_ORDER_INFO;
    const j = await res.json();
    const md = j?.order?.metadata || {};
    // v18: order.line_items — unlike order.metadata — survive payment, so this
    // is how add-ons (matched below via matchAddOns) get recovered post-payment.
    const lineItems: LineItemInfo[] = Array.isArray(j?.order?.line_items)
      ? j.order.line_items.map((li: any) => ({ name: String(li?.name || ""), quantity: String(li?.quantity || "1"), note: String(li?.note || "") }))
      : [];
    return {
      name: md.customerName || "",
      phone: md.customerPhone || "",
      seatingOptionId: md.seatingOptionId || "",
      seatingOptionName: md.seatingOptionName || "",
      arrivalSlot: md.arrivalSlot || "",
      arrivalLabel: md.arrivalLabel || "",
      seatType: md.seatType || "",
      eventId: md.eventId || "",
      lineItems,
    };
  } catch { return EMPTY_ORDER_INFO; }
}

type Reg = {
  eventName: string; qty: number; email: string; paymentId: string;
  name?: string; phone?: string; backfilled?: boolean;
  eventId?: string; seatingOptionId?: string; seatingOptionName?: string; seatType?: string;
  arrivalSlot?: string; arrivalLabel?: string;
  // v17: what Square captured, for the receipt lines in the guest email. Never stored
  // on the registration itself.
  amountCents?: number; currency?: string;
  // Raw payment.note — the post-payment source of truth. Used to derive the seating
  // option and arrival wave; never stored on the registration itself.
  note?: string;
  // v18: raw order line items, used to recover add-on/merch selections (e.g.
  // shirt sizes) that ride as extra Square line items. Never stored as-is —
  // matchAddOns() turns these into the addOns[] actually saved on the reg.
  lineItems?: LineItemInfo[];
};

async function applyRegistrations(regs: Reg[]): Promise<any[]> {
  if (!GITHUB_TOKEN) return regs.map((r) => ({ payment: r.paymentId, status: "no_github_token" }));
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const metaRes = await gh("GET", `/repos/${GITHUB_REPO}/contents/events.json`);
    if (!metaRes.ok) { lastErr = "events_meta_fetch_failed_" + metaRes.status; break; }
    const meta = await metaRes.json();
    const sha = meta.sha;
    let data: any;
    if (meta.content && meta.encoding === "base64" && meta.content.length > 0) {
      // atob() alone yields a "binary string" (one JS char per byte, Latin-1
      // style) — it does NOT UTF-8-decode multi-byte characters. Passing that
      // straight to JSON.parse silently mangled every em-dash/emoji/smart-quote
      // in the file, and re-mangled it FURTHER on every subsequent registration
      // sync (the write path below already round-trips UTF-8 correctly via
      // encodeURIComponent/unescape/btoa, so it faithfully re-saved whatever
      // corruption this read step had just introduced). Re-interpret the
      // binary string as UTF-8 bytes before parsing, mirroring the write side.
      const binary = atob(meta.content.replace(/\n/g, ""));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } else {
      const raw = await ghRawEvents(); // private-repo safe (was anonymous raw.githubusercontent.com)
      data = JSON.parse(await raw.text());
    }
    const list = data.events || [];
    const statuses: any[] = [];
    const touched = new Set<string>();
    const pendingEmails: PendingEmail[] = [];
    let changed = false;
    for (const reg of regs) {
      if (!reg.paymentId) { statuses.push({ payment: reg.paymentId, status: "no_payment_id" }); continue; }
      // Prefer an exact id match from the order metadata. Fall back to the legacy
      // fuzzy name match for older payments whose orders carry no eventId.
      let ev = reg.eventId ? list.find((e: any) => e.id === reg.eventId) : null;
      if (!ev) {
        const nameLc = reg.eventName.toLowerCase();
        ev = list.find((e: any) => e.name && reg.eventName && (e.name.toLowerCase() === nameLc || nameLc.includes(e.name.toLowerCase()) || e.name.toLowerCase().includes(nameLc)));
      }
      if (!ev) { statuses.push({ payment: reg.paymentId, status: "event_not_found", event: reg.eventName }); continue; }

      // v16: derive seating option + arrival wave from the raw note by matching the
      // event's own known values. Metadata wins whenever it actually supplied something.
      const seatMatch = matchSeatingOption(reg.note || "", ev.seatingOptions || []);
      const slotMatch = matchArrivalSlot(reg.note || "", ev.arrivalSlots || []);
      const seatingOptionId = reg.seatingOptionId || (seatMatch ? seatMatch.seatingOptionId : "");
      const seatingOptionName = reg.seatingOptionName || (seatMatch ? seatMatch.seatingOptionName : "");
      const arrivalSlot = reg.arrivalSlot || (slotMatch ? slotMatch.arrivalSlot : "");
      let arrivalLabel = reg.arrivalLabel || (slotMatch ? slotMatch.arrivalLabel : "");
      if (arrivalSlot && !arrivalLabel) {
        const s = (ev.arrivalSlots || []).find((x: any) => x && String(x.id) === arrivalSlot);
        if (s && s.label) arrivalLabel = String(s.label);
      }
      const optForEmail = seatingOptionId ? (ev.seatingOptions || []).find((o: any) => o && String(o.id) === seatingOptionId) : null;
      const seats = Number(optForEmail && optForEmail.seats) || (seatMatch ? seatMatch.seats : 0) || 0;

      // v18: add-ons (e.g. merch) recovered from the order's own line items —
      // see matchAddOns above. [] for every event that doesn't define addOns.
      const addOnMatches = matchAddOns(reg.lineItems || [], ev.addOns || []);

      // v21: a refunded payment must never be re-added (Square redelivers payment.updated).
      if (Array.isArray(ev.refundedRegistrations) && ev.refundedRegistrations.some((r: any) => r && r.paymentId === reg.paymentId)) { statuses.push({ payment: reg.paymentId, status: "already_refunded", event: ev.name }); continue; }
      ev.registrations = ev.registrations || [];
      if (ev.registrations.some((r: any) => r.paymentId === reg.paymentId)) { statuses.push({ payment: reg.paymentId, status: "already_recorded", event: ev.name }); continue; }
      ev.registrations.push({
        name: reg.name || reg.email || "",
        email: reg.email || "",
        qty: reg.qty,
        // Collected by the booking form; omitted when the order has no phone.
        ...(reg.phone ? { phone: reg.phone } : {}),
        paymentId: reg.paymentId,
        registeredAt: new Date().toISOString(),
        source: "square",
        // Only present for table-style events; omitted entirely otherwise so the
        // shape of existing registrations does not change.
        ...(seatingOptionId ? { seatingOptionId } : {}),
        ...(seatingOptionName ? { seatingOptionName } : {}),
        ...(reg.seatType ? { seatType: reg.seatType } : {}),
        // Staggered arrival wave, when the event offers one.
        ...(arrivalSlot ? { arrivalSlot } : {}),
        ...(arrivalLabel ? { arrivalLabel } : {}),
        ...(addOnMatches.length ? { addOns: addOnMatches } : {}),
        ...(reg.backfilled ? { backfilled: true } : {}),
      });
      touched.add(ev.id);
      changed = true;
      statuses.push({ payment: reg.paymentId, status: "added", event: ev.name, seating: seatingOptionName || seatingOptionId || "" });
      // Queue the emails: newly added only (never "already_recorded" — Square redelivers
      // payment.updated), and never on a backfill run.
      if (!reg.backfilled && reg.email) {
        pendingEmails.push({ ev, email: reg.email, qty: reg.qty, paymentId: reg.paymentId, seatingOptionName, seats, arrivalLabel, amountCents: Number(reg.amountCents) || 0, currency: reg.currency || "USD", addOns: addOnMatches });
      }
    }
    if (!changed) return statuses;
    for (const id of touched) {
      const ev = list.find((e: any) => e.id === id);
      if (!ev) continue;
      const total = ev.registrations.reduce((s: number, r: any) => s + (Number(r.qty) || Number(r.tickets) || 1), 0);
      ev.registeredCount = total; ev.registered = total;
      if (ev.totalCapacity && total >= ev.totalCapacity) ev.status = "sold-out";
    }
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const putRes = await gh("PUT", `/repos/${GITHUB_REPO}/contents/events.json`, { message: `Registration sync (${statuses.filter((s) => s.status === "added").length})`, content: encoded, sha });
    if (putRes.ok) {
      for (const id of touched) {
        const ev = list.find((e: any) => e.id === id);
        for (const s of statuses) if (s.status === "added" && s.event === ev?.name) s.count = ev?.registeredCount;
      }
      // Emails go out only once the booking is safely saved, and can never fail the write.
      for (const pe of pendingEmails) {
        try { await sendRegistrationEmails(pe); }
        catch (e) { console.error("registration email error:", pe.paymentId, (e as Error).message); }
      }
      return statuses;
    }
    if (putRes.status === 409) { lastErr = "conflict"; await new Promise((r) => setTimeout(r, 400 + attempt * 300)); continue; }
    lastErr = "github_put_failed_" + putRes.status;
    break;
  }
  return regs.map((r) => ({ payment: r.paymentId, status: lastErr || "failed" }));
}

// --- Refunds (v21) -----------------------------------------------------------
type RefundReq = { paymentId: string; refundedCents: number; amountCents: number; backfilled?: boolean };

async function readEventsFile(): Promise<{ data: any; sha: string } | null> {
  const metaRes = await gh("GET", `/repos/${GITHUB_REPO}/contents/events.json`);
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  let data: any;
  if (meta.content && meta.encoding === "base64" && meta.content.length > 0) {
    const binary = atob(meta.content.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    data = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } else {
    const raw = await ghRawEvents(); // private-repo safe (was anonymous raw.githubusercontent.com)
    data = JSON.parse(await raw.text());
  }
  return { data, sha: meta.sha };
}

function recomputeEventCounts(ev: any) {
  const regs = Array.isArray(ev.registrations) ? ev.registrations : [];
  const total = regs.reduce((s: number, r: any) => s + (Number(r.qty) || Number(r.tickets) || 1), 0);
  ev.registeredCount = total; ev.registered = total;
  // Only undo an automatic/real sell-out; never touch inactive/cancelled/draft.
  if (ev.status === "sold-out" && (!ev.totalCapacity || total < Number(ev.totalCapacity))) ev.status = "available";
}

async function applyRefunds(refunds: RefundReq[]): Promise<any[]> {
  if (!GITHUB_TOKEN) return refunds.map((r) => ({ payment: r.paymentId, status: "no_github_token" }));
  let lastErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const file = await readEventsFile();
    if (!file) { lastErr = "events_meta_fetch_failed"; break; }
    const { data, sha } = file;
    const list = data.events || [];
    const statuses: any[] = [];
    const released: { ev: any; reg: any; refundedCents: number }[] = [];
    let changed = false;
    for (const rf of refunds) {
      if (!rf.paymentId || !(rf.refundedCents > 0)) { statuses.push({ payment: rf.paymentId, status: "nothing_refunded" }); continue; }
      const full = rf.amountCents > 0 ? rf.refundedCents >= rf.amountCents : true;
      let hit = false;
      for (const ev of list) {
        if (!ev) continue;
        const regs = Array.isArray(ev.registrations) ? ev.registrations : [];
        const idx = regs.findIndex((r: any) => r && r.paymentId === rf.paymentId);
        if (idx === -1) {
          if (Array.isArray(ev.refundedRegistrations) && ev.refundedRegistrations.some((r: any) => r && r.paymentId === rf.paymentId)) {
            statuses.push({ payment: rf.paymentId, status: "already_refunded", event: ev.name }); hit = true; break;
          }
          continue;
        }
        hit = true;
        if (!full) {
          if (Number(regs[idx].refundedCents || 0) !== rf.refundedCents) { regs[idx].refundedCents = rf.refundedCents; changed = true; }
          statuses.push({ payment: rf.paymentId, status: "partial_refund_noted", event: ev.name });
          break;
        }
        const reg = regs.splice(idx, 1)[0];
        reg.refundedAt = new Date().toISOString();
        reg.refundedCents = rf.refundedCents;
        ev.refundedRegistrations = Array.isArray(ev.refundedRegistrations) ? ev.refundedRegistrations : [];
        ev.refundedRegistrations.push(reg);
        // Legacy top-level map (pre-June registrations) — drop the same payment there too.
        if (data.registrations && Array.isArray(data.registrations[ev.id])) {
          data.registrations[ev.id] = data.registrations[ev.id].filter((r: any) => !(r && r.paymentId === rf.paymentId));
        }
        recomputeEventCounts(ev);
        changed = true;
        released.push({ ev, reg, refundedCents: rf.refundedCents });
        statuses.push({ payment: rf.paymentId, status: "released", event: ev.name, qty: reg.qty, count: ev.registeredCount });
        break;
      }
      if (!hit) statuses.push({ payment: rf.paymentId, status: "registration_not_found" });
    }
    if (!changed) return statuses;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const putRes = await gh("PUT", `/repos/${GITHUB_REPO}/contents/events.json`, { message: `Refund sync (${released.length} released)`, content: encoded, sha });
    if (putRes.ok) {
      for (const x of released) {
        if (refunds.find((r) => r.paymentId === x.reg.paymentId)?.backfilled) continue;
        const nm = String(x.ev.name || "");
        const who = String(x.reg.email || x.reg.name || "");
        const seat = String(x.reg.seatingOptionName || "");
        const html = `<h2 style="font-family:sans-serif;font-size:18px;">Refund processed — seats released</h2>
<p style="font-family:sans-serif;">${esc(nm)}<br>Guest: ${esc(who)}<br>Released: ${esc(x.reg.qty)} seat(s)${seat ? " (" + esc(seat) + ")" : ""}<br>Refunded: ${esc(formatAmount(x.refundedCents) || "-")}<br>Now registered: <strong>${esc(x.ev.registeredCount)}</strong></p>
<p style="font-family:sans-serif;color:#666;">Those spots are back on sale on the website automatically.</p>`;
        const text = `Refund processed — seats released\n${nm}\nGuest: ${who}\nReleased: ${x.reg.qty} seat(s)${seat ? " (" + seat + ")" : ""}\nRefunded: ${formatAmount(x.refundedCents) || "-"}\nNow registered: ${x.ev.registeredCount}\nThose spots are back on sale on the website automatically.`;
        try { await sendEmail(VENUE_EMAIL, `Refund — ${nm} (${x.reg.qty} seats released)`, html, undefined, text); }
        catch (e) { console.error("refund email failed:", x.reg.paymentId, (e as Error).message); }
      }
      return statuses;
    }
    if (putRes.status === 409) { lastErr = "conflict"; await new Promise((r) => setTimeout(r, 400 + attempt * 300)); continue; }
    lastErr = "github_put_failed_" + putRes.status;
    break;
  }
  return refunds.map((r) => ({ payment: r.paymentId, status: lastErr || "failed" }));
}

async function backfillRefunds() {
  let rows: any[];
  try { rows = await fetchAllWebhookLogRows(); }
  catch (e) { return { error: (e as Error).message }; }
  // Keep the largest refunded amount seen per payment.
  const best = new Map<string, RefundReq>();
  for (const row of (rows || [])) {
    const p = (row as any)?.payload?.data?.object?.payment;
    if (!p || !p.id) continue;
    if (!String(p.note || "").startsWith("Event - ")) continue;
    const refundedCents = Number(p?.refunded_money?.amount) || 0;
    if (refundedCents <= 0) continue;
    const prev = best.get(p.id);
    if (!prev || refundedCents > prev.refundedCents) best.set(p.id, { paymentId: p.id, refundedCents, amountCents: Number(p?.amount_money?.amount) || 0, backfilled: true });
  }
  const queue = [...best.values()];
  if (!queue.length) return { processed: 0, results: [] };
  return { processed: queue.length, results: await applyRefunds(queue) };
}

// Paginates through the full square_webhook_log rather than one unbounded
// select — the table passed 1000 rows a while back, and an unbounded query
// silently caps at PostgREST's default 1000-row limit, so backfillEvents()
// was quietly never reaching the most recent ~160 rows (i.e. exactly the
// newest registrations, the ones most likely to actually need recovering).
async function fetchAllWebhookLogRows(): Promise<any[]> {
  const rows: any[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supa.from("square_webhook_log").select("payload")
      .order("received_at", { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function backfillEvents() {
  let rows: any[];
  try { rows = await fetchAllWebhookLogRows(); }
  catch (e) { return { error: (e as Error).message }; }
  const seen = new Set<string>();
  const queue: Reg[] = [];
  for (const row of (rows || [])) {
    const p = (row as any)?.payload?.data?.object?.payment;
    if (!p) continue;
    if (p.status !== "COMPLETED" && p.status !== "APPROVED") continue;
    const parsed = parseEventPayment(p);
    if (!parsed) continue;
    if (seen.has(parsed.paymentId)) continue;
    seen.add(parsed.paymentId);
    const info = await lookupOrderInfo(p.order_id);
    // parsed already carries amountCents / currency (v17); backfills never email, but
    // the shape stays identical to the live path.
    queue.push({ ...parsed, ...info, amountCents: parsed.amountCents, currency: parsed.currency, note: p.note || "", backfilled: true });
  }
  const results = await applyRegistrations(queue);
  return { processed: queue.length, results };
}

// v22: forward every completed, unrefunded Quarry Fest vendor payment already in the
// log to Netlify once. Netlify skips vendors already booked with the same payment id.
async function backfillQuarryFest() {
  if (!NETLIFY_SIG_KEY) return { error: "NETLIFY_SQUARE_SIG_KEY not set" };
  let rows: any[];
  try { rows = await fetchAllWebhookLogRows(); }
  catch (e) { return { error: (e as Error).message }; }
  // v23: keep the LATEST logged state per payment (rows are oldest-first), so a
  // refunded payment replays as a refund.
  const latest = new Map<string, any>();
  for (const row of (rows || [])) {
    const p = (row as any)?.payload?.data?.object?.payment;
    if (!p || !p.id) continue;
    if (p.status !== "COMPLETED" && p.status !== "APPROVED") continue;
    if (!String(p.note || "").startsWith("Quarry Fest Vendor - ")) continue;
    latest.set(p.id, (row as any).payload);
  }
  const results: unknown[] = [];
  for (const [id, payload] of latest) {
    const p = payload?.data?.object?.payment || {};
    const status = await forwardToNetlify(JSON.stringify(payload));
    results.push({ payment: id, note: p.note, email: p.buyer_email_address, refunded: Number(p?.refunded_money?.amount) || 0, status: "forwarded_" + status });
  }
  return { forwarded: results.length, results };
}

// Backfill golf: replay (forward to Netlify) completed golf payments whose booking
// date is today or later, so they land on the Google Calendar + get a confirmation email.
async function backfillGolf() {
  if (!NETLIFY_SIG_KEY) return { error: "NETLIFY_SQUARE_SIG_KEY not set" };
  let rows: any[];
  try { rows = await fetchAllWebhookLogRows(); }
  catch (e) { return { error: (e as Error).message }; }
  const todayStr = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const results: unknown[] = [];
  for (const row of (rows || [])) {
    const p = (row as any)?.payload?.data?.object?.payment;
    if (!p) continue;
    if (p.status !== "COMPLETED" && p.status !== "APPROVED") continue;
    const note: string = p.note || "";
    if (!note.startsWith("Hole-In-One Golf")) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const dm = note.match(/(\d{4}-\d{2}-\d{2})/);
    const bookingDate = dm ? dm[1] : "";
    if (!bookingDate || bookingDate < todayStr) { results.push({ payment: p.id, note, status: "skipped_past" }); continue; }
    const status = await forwardToNetlify(JSON.stringify((row as any).payload));
    results.push({ payment: p.id, note, email: p.buyer_email_address, status: "forwarded_" + status });
  }
  return { forwarded: results.filter((r: any) => String(r.status).startsWith("forwarded")).length, results };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("action") === "backfill-events") {
    if (url.searchParams.get("key") !== BACKFILL_KEY) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify(await backfillEvents(), null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET" && url.searchParams.get("action") === "backfill-refunds") {
    if (url.searchParams.get("key") !== BACKFILL_KEY) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify(await backfillRefunds(), null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET" && url.searchParams.get("action") === "backfill-quarryfest") {
    if (url.searchParams.get("key") !== BACKFILL_KEY) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify(await backfillQuarryFest(), null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (req.method === "GET" && url.searchParams.get("action") === "backfill-golf") {
    if (url.searchParams.get("key") !== BACKFILL_KEY) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify(await backfillGolf(), null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const rawBody = await req.text();
  const sig = req.headers.get("x-square-hmacsha256-signature") || "";
  const notificationUrl = `${SUPABASE_URL}/functions/v1/square-webhook`;
  if (!(await verify(rawBody, notificationUrl, sig))) { console.warn("Bad signature"); return new Response("bad signature", { status: 401 }); }
  let evt: any;
  try { evt = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400 }); }
  const type = evt.type as string;
  const data = evt.data?.object || {};
  const now = new Date().toISOString();
  await supa.from("square_webhook_log").insert({ event_type: type, payload: evt }).then(() => {}, () => {});
  try {
    if (type === "invoice.payment_made" || type === "invoice.updated" || type === "invoice.canceled" || type === "invoice.scheduled_charge_failed") {
      const inv = data.invoice || {};
      const invoiceId = inv.id;
      if (!invoiceId) return new Response("no invoice id", { status: 200 });
      const status = inv.status || "";
      const paidNow = status === "PAID" || type === "invoice.payment_made";
      const updates: Record<string, any> = { square_invoice_status: status, square_last_event_at: now };
      if (paidNow) { updates.paid = true; updates.paid_date = new Date().toISOString().slice(0, 10); updates.payment_method = "Square"; }
      if (status === "CANCELED") updates.square_invoice_status = "CANCELED";
      const { data: matched } = await supa.from("wedding_payments").select("id, wedding_id").eq("square_invoice_id", invoiceId).maybeSingle();
      const { error } = await supa.from("wedding_payments").update(updates).eq("square_invoice_id", invoiceId);
      if (error) console.error("update fail", error);
      if (paidNow && matched?.wedding_id) await checkPaymentMilestones(matched.wedding_id);

      // v19: venue booking invoices (Penny's private events, booked from the admin
      // calendar) — same event stream, matched by square_invoice_id like weddings
      // above, but recompute deposit_paid/balance_due on venue_bookings instead of
      // ticking wedding_tasks milestones.
      const { data: venueMatched } = await supa.from("venue_booking_payments").select("id, booking_id").eq("square_invoice_id", invoiceId).maybeSingle();
      if (venueMatched) {
        const { error: venueErr } = await supa.from("venue_booking_payments").update(updates).eq("square_invoice_id", invoiceId);
        if (venueErr) console.error("venue payment update fail", venueErr);
        if (paidNow) {
          const { error: rpcErr } = await supa.rpc("venue_booking_recompute_payment_totals", { p_booking_id: venueMatched.booking_id });
          if (rpcErr) console.error("venue payment totals recompute fail", rpcErr);
        }
      }
    } else if (type === "payment.updated" || type === "payment.created") {
      const p = data.payment || {};
      // Match on square_order_id, NOT square_payment_id. The previous version filtered on the
      // same column it was setting, so it could only ever match a row that already had the id —
      // which nothing else writes. It silently matched zero rows on every event.
      if (p.id && p.order_id) {
        await supa.from("wedding_payments").update({ square_payment_id: p.id, square_last_event_at: now }).eq("square_order_id", p.order_id);
        await supa.from("venue_booking_payments").update({ square_payment_id: p.id, square_last_event_at: now }).eq("square_order_id", p.order_id);
      }
      if (p.status === "COMPLETED" || p.status === "APPROVED") {
        const note: string = p.note || "";
        if (note.startsWith("Event - ")) {
          const parsed = parseEventPayment(p);
          // v21: a refund arrives as payment.updated with refunded_money set.
          const refundedCents = Number(p?.refunded_money?.amount) || 0;
          if (parsed && refundedCents > 0) {
            try { console.log("event refund sync:", JSON.stringify(await applyRefunds([{ paymentId: parsed.paymentId, refundedCents, amountCents: parsed.amountCents }]))); }
            catch (e) { console.error("event refund sync error:", (e as Error).message); }
            // Full refund: nothing else to do. Partial refund falls through so a
            // not-yet-recorded payment still gets its registration.
            if (parsed.amountCents <= 0 || refundedCents >= parsed.amountCents) parsed.paymentId = "";
          }
          if (parsed && parsed.paymentId) {
            try { const info = await lookupOrderInfo(p.order_id); console.log("event reg sync:", JSON.stringify(await applyRegistrations([{ ...parsed, ...info, amountCents: parsed.amountCents, currency: parsed.currency, note }]))); }
            catch (e) { console.error("event reg sync error:", (e as Error).message); }
          }
        } else if (note.startsWith("Quarry Fest Vendor - ")) {
          // v22/v23: vendor fee -> Netlify (booked + confirmation emails). A full refund
          // is forwarded once more under its own claim so Netlify marks them Refunded.
          const refunded = Number(p?.refunded_money?.amount) || 0;
          const amt = Number(p?.amount_money?.amount) || 0;
          if (refunded > 0 && refunded >= amt) await forwardOnce(p.id + ":refund", rawBody, "quarryfest refund");
          else if (refunded <= 0) await forwardOnce(p.id, rawBody, "quarryfest");
        } else if (note.startsWith("Hole-In-One Golf")) {
          if (!(Number(p?.refunded_money?.amount) > 0)) await forwardOnce(p.id, rawBody, "golf");
        }
      }
    } else if (type.startsWith("subscription.")) {
      try { const st = await forwardToNetlify(rawBody); console.log("subscription forward:", st); }
      catch (e) { console.error("subscription forward error:", (e as Error).message); }
    }
  } catch (e) { console.error("handler error", e); }
  return new Response("ok", { status: 200 });
});
