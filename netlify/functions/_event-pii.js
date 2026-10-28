// ============================================================================
// _event-pii.js — keep ticket buyers' contact details OUT of events.json.
//
// (Import-only; the leading "_" keeps Netlify from deploying it as an endpoint.)
//
// events.json is committed to a PUBLIC GitHub repo and served raw to anyone.
// Since 2026-10-22 buyer name / email / phone / business fields live in the
// Supabase table public.event_registrant_pii, reached only through the edge
// function `event-pii` with the shared secret EVENT_PII_KEY (server-side only).
//
// Every code path that writes events.json must call `await vaultAndStrip(doc)`
// right before serialising it. That:
//   1. copies any PII still on a registration into the vault (upsert, never
//      blanks existing values), and THROWS if the vault write fails — the
//      caller must then abort its write rather than publish or lose the data;
//   2. deletes the PII fields from the row and stamps `ref` so it can be
//      re-joined later.
// Because it walks the whole document, any PII a stale writer re-introduces is
// vaulted and stripped again on the next write.
//
// Server-side readers that need contact details (admin endpoint, marketing
// sync, wine-club campaign) call `await hydrateDoc(doc)`.
//
// regRef() MUST stay identical to regRef() in
// supabase/functions/square-webhook/index.ts and scripts/migrate-event-pii.js.
// ============================================================================
const crypto = require('crypto');

const EDGE_URL = 'https://nkulhtalltbieicvmmad.supabase.co/functions/v1/event-pii';

// field on the registration -> column in the vault
const PII_MAP = {
  name: 'name',
  email: 'email',
  phone: 'phone',
  businessName: 'business_name',
  businessType: 'business_type',
  customerName: 'name',
  customerEmail: 'email',
  customerPhone: 'phone',
};
const PII_FIELDS = Object.keys(PII_MAP);
// vault column -> canonical registration field when hydrating
const COL_TO_FIELD = { name: 'name', email: 'email', phone: 'phone', business_name: 'businessName', business_type: 'businessType' };

function regRef(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.ref) return String(r.ref);
  const direct = r.paymentId || r.transactionId || r.orderNumber;
  if (direct) return String(direct);
  const basis = [
    r.email || r.customerEmail || '', r.name || r.customerName || '',
    r.registeredAt || r.created || '', r.qty || r.tickets || '',
  ].join('|');
  return 'h_' + crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 20);
}

function hasPii(r) {
  return !!r && typeof r === 'object' && PII_FIELDS.some((f) => r[f] !== undefined && r[f] !== null && r[f] !== '');
}

// Calls cb(reg, vaultEventId) for every registration object in the document.
function forEachReg(doc, cb) {
  if (!doc || typeof doc !== 'object') return;
  (Array.isArray(doc.events) ? doc.events : []).forEach((ev) => {
    if (!ev || !ev.id) return;
    ['registrations', 'refundedRegistrations'].forEach((k) => {
      if (Array.isArray(ev[k])) ev[k].forEach((r) => cb(r, String(ev.id)));
    });
  });
  const legacy = doc.registrations;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
    Object.keys(legacy).forEach((key) => {
      if (Array.isArray(legacy[key])) legacy[key].forEach((r) => cb(r, 'legacy:' + key));
    });
  }
}

function rowFor(r, eventId) {
  const row = { event_id: eventId, ref: regRef(r) };
  PII_FIELDS.forEach((f) => {
    const v = r[f];
    if (v === undefined || v === null || v === '') return;
    const col = PII_MAP[f];
    if (!row[col]) row[col] = String(v);
  });
  return row;
}

// Pure: returns vault rows for every registration still carrying PII.
function collectRows(doc) {
  const rows = [];
  forEachReg(doc, (r, eventId) => { if (hasPii(r)) rows.push(rowFor(r, eventId)); });
  return rows;
}

// Mutates: removes PII fields and stamps `ref`. Returns count stripped.
function stripDoc(doc) {
  let n = 0;
  forEachReg(doc, (r) => {
    if (!hasPii(r)) return;
    const ref = regRef(r);
    PII_FIELDS.forEach((f) => { delete r[f]; });
    r.ref = ref;
    n++;
  });
  return n;
}

// The vault key is DERIVED from ADMIN_PUSH_SECRET rather than stored as its
// own env var: this site's function env is at AWS Lambda's 4KB limit, and one
// more variable makes every deploy fail ("Failed to create function ... exceed
// the 4KB limit"). EVENT_PII_KEY, if set, still wins. NOTE: rotating
// ADMIN_PUSH_SECRET requires re-setting the Supabase secret EVENT_PII_KEY to
// HMAC-SHA256(ADMIN_PUSH_SECRET, 'quarry-event-pii-v1') hex.
function vaultKey() {
  if (process.env.EVENT_PII_KEY) return process.env.EVENT_PII_KEY;
  const base = process.env.ADMIN_PUSH_SECRET || '';
  if (!base) return '';
  return require('crypto').createHmac('sha256', base).update('quarry-event-pii-v1').digest('hex');
}

async function callEdge(payload) {
  const key = vaultKey();
  if (!key) throw new Error('vault key not configured — refusing to write events.json with buyer PII');
  const r = await fetch(EDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-key': key },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { throw new Error('event-pii returned non-JSON (' + r.status + ')'); }
  if (!r.ok || !body.ok) throw new Error('event-pii ' + payload.action + ' failed (' + r.status + '): ' + (body.message || body.error || ''));
  return body;
}

async function upsertRows(rows, source) {
  for (let i = 0; i < rows.length; i += 1000) {
    await callEdge({ action: 'upsert', rows: rows.slice(i, i + 1000), source: source || 'netlify' });
  }
  return rows.length;
}

// The one call every events.json writer makes before serialising.
async function vaultAndStrip(doc, source) {
  const rows = collectRows(doc);
  if (rows.length) await upsertRows(rows, source);   // throws -> caller aborts the write
  const stripped = stripDoc(doc);
  return { vaulted: rows.length, stripped };
}

async function listRows(eventIds) {
  const body = await callEdge({ action: 'list', event_ids: eventIds && eventIds.length ? eventIds : undefined });
  return body.rows || [];
}

function indexRows(rows) {
  const m = new Map();
  (rows || []).forEach((row) => { if (row && row.event_id && row.ref) m.set(row.event_id + '\u0000' + row.ref, row); });
  return m;
}

// Re-attach vault PII onto a (server-side) copy of the document. Values
// already present on the row win. Returns number of rows hydrated.
async function hydrateDoc(doc, rows) {
  const idx = indexRows(rows || await listRows());
  let n = 0;
  forEachReg(doc, (r, eventId) => {
    if (!r || typeof r !== 'object') return;
    const row = idx.get(eventId + '\u0000' + regRef(r));
    if (!row) return;
    Object.keys(COL_TO_FIELD).forEach((col) => {
      const f = COL_TO_FIELD[col];
      if (row[col] && !r[f]) r[f] = row[col];
    });
    n++;
  });
  return n;
}

// For public responses: a copy of one event with every PII field removed.
// 2026-10-27: public projection. Browsers only need enough of each sale to
// count seats/waves (qty + which seating option + which arrival wave), so the
// public feed drops everything else: Square/Stripe payment + order ids, refs,
// amounts, coupon codes, refund records and the legacy top-level map.
// Server-side code that needs the real rows reads the repo directly
// (_github-data) or through an admin session, never this projection.
const PUBLIC_REG_FIELDS = ['qty', 'seatingOptionId', 'seatType', 'arrivalSlot'];

function publicReg(r) {
  if (!r || typeof r !== 'object') return null;
  const c = {};
  PUBLIC_REG_FIELDS.forEach((f) => {
    if (r[f] !== undefined && r[f] !== null && r[f] !== '') c[f] = r[f];
  });
  return c;
}

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return ev;
  const out = Object.assign({}, ev);
  if (Array.isArray(ev.registrations)) out.registrations = ev.registrations.map(publicReg).filter(Boolean);
  delete out.refundedRegistrations;
  delete out.bookedBy;
  return out;
}

// Whole-document public projection of events.json (data-read, data-store
// anonymous GET, /events.json). Keeps the document shape so every reader works.
// 2026-10-28: status 'draft' = hidden (not announced / not on sale). Drafts
// never leave the server for anonymous callers: not in /events.json, not in
// get-event-public, not sellable through event-register, not promoted by the
// social/email generators. Admin sessions still get the full file (data-read,
// admin-event-pii). 'inactive' (= cancelled) is NOT hidden here on purpose:
// pages show those as "cancelled".
function isDraftEvent(e) {
  return !!e && String(e.status || '').toLowerCase() === 'draft';
}

function publicEventsDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc;
  const out = Object.assign({}, doc);
  if (Array.isArray(doc.events)) out.events = doc.events.filter((e) => !isDraftEvent(e)).map(sanitizeEvent);
  if (doc.registrations !== undefined) out.registrations = {};
  if (doc.subscribers !== undefined) out.subscribers = [];
  return out;
}

module.exports = {
  PII_FIELDS, regRef, hasPii, forEachReg, collectRows, stripDoc,
  vaultAndStrip, upsertRows, listRows, hydrateDoc, sanitizeEvent, indexRows,
  publicReg, publicEventsDoc, isDraftEvent,
};
