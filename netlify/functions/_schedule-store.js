// ============================================================================
// _schedule-store.js — private staff schedule storage + staff login helpers
// (import-only; the leading "_" keeps it from being deployed as an endpoint).
//
// Replaces schedule.json in the PUBLIC GitHub repo. Everything now lives in
// the Netlify Blobs store "staff-schedule" (site-private, never on the CDN):
//
//   staff-schedule/schedule     { employees[], schedules{}, timeOffRequests[],
//                                 lastUpdated }   -- NO password hashes
//   staff-schedule/credentials  { [employeeId]: { hash, mustChange, setAt } }
//   staff-schedule/backup-<ts>  copy of the previous schedule doc on each write
//
// Passwords: new ones use scrypt ("scrypt$N$r$p$salt$hash"). The legacy
// "salt:sha256(salt+password)" format is still accepted until the reset step
// drops it (scripts/migrate-schedule-to-blobs.js --drop-legacy-hashes).
//
// Employee sessions: "emp.<issuedMs>.<employeeId>.<hmac>" signed with a key
// derived from EMPLOYEE_SESSION_SECRET (or STAFF_SESSION_SECRET), so an
// employee token can never pass as an admin/staff token in _admin-auth.js.
// ============================================================================
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE = 'staff-schedule';
const DOC_KEY = 'schedule';
const CRED_KEY = 'credentials';
const SITE_ID_FALLBACK = process.env.NETLIFY_SITE_ID || 'd9496ae2-2b01-4229-b6d2-9203c3be7acb';
const EMP_TTL_HOURS = 12;

let _testStore = null; // local tests inject an in-memory store
function __setTestStore(s) { _testStore = s; }

function store() {
  if (_testStore) return _testStore;
  try {
    return getStore({ name: STORE, consistency: 'strong' });
  } catch (_) {
    return getStore({
      name: STORE,
      consistency: 'strong',
      siteID: SITE_ID_FALLBACK,
      token: process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || '',
    });
  }
}

const EMPTY = () => ({ employees: [], schedules: {}, timeOffRequests: [] });

// Throws on store errors (callers return 5xx; never fall back to GitHub).
async function readSchedule() {
  const doc = await store().get(DOC_KEY, { type: 'json' });
  if (!doc) {
    const e = new Error('Schedule not migrated to private storage yet');
    e.status = 503;
    throw e;
  }
  doc.employees = Array.isArray(doc.employees) ? doc.employees : [];
  doc.schedules = (doc.schedules && typeof doc.schedules === 'object') ? doc.schedules : {};
  doc.timeOffRequests = Array.isArray(doc.timeOffRequests) ? doc.timeOffRequests : [];
  for (const emp of doc.employees) delete emp.passwordHash; // belt + braces
  return doc;
}

async function writeSchedule(doc) {
  const s = store();
  const prev = await s.get(DOC_KEY, { type: 'json' });
  if (prev) await s.setJSON('backup-' + new Date().toISOString().replace(/[:.]/g, ''), prev);
  const clean = {
    employees: (doc.employees || []).map((e) => { const c = { ...e }; delete c.passwordHash; return c; }),
    schedules: doc.schedules || {},
    timeOffRequests: doc.timeOffRequests || [],
    lastUpdated: new Date().toISOString(),
  };
  await s.setJSON(DOC_KEY, clean);
  return clean;
}

async function readCredentials() {
  return (await store().get(CRED_KEY, { type: 'json' })) || {};
}
async function writeCredentials(creds) {
  await store().setJSON(CRED_KEY, creds || {});
}

// ---- passwords --------------------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt, h].join('$');
}

function safeEqHex(a, b) {
  const A = Buffer.from(String(a), 'hex');
  const B = Buffer.from(String(b), 'hex');
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

// returns { ok, legacy }
function verifyPassword(password, stored) {
  if (!stored || !password) return { ok: false };
  const s = String(stored);
  if (s.startsWith('scrypt$')) {
    const [, N, r, p, salt, h] = s.split('$');
    const test = crypto.scryptSync(String(password), salt, h.length / 2, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 }).toString('hex');
    return { ok: safeEqHex(test, h) };
  }
  if (s.includes(':')) { // legacy salt:sha256(salt+password)
    const [salt, h] = s.split(':');
    const test = crypto.createHash('sha256').update(salt + password).digest('hex');
    return { ok: safeEqHex(test, h), legacy: true };
  }
  return { ok: false };
}

// ---- employee session tokens -----------------------------------------------
function empKey() {
  const base = process.env.EMPLOYEE_SESSION_SECRET || process.env.STAFF_SESSION_SECRET || '';
  if (!base) return '';
  return crypto.createHmac('sha256', base).update('quarry-employee-session-v1').digest('hex');
}

function signEmployeeToken(employeeId) {
  const key = empKey();
  if (!key) throw Object.assign(new Error('Employee session secret not configured'), { status: 500 });
  const issued = String(Date.now());
  const id = Buffer.from(String(employeeId)).toString('base64url');
  const sig = crypto.createHmac('sha256', key).update('emp.' + issued + '.' + id).digest('hex');
  return ['emp', issued, id, sig].join('.');
}

// returns employeeId or null
function verifyEmployeeToken(token) {
  const key = empKey();
  const parts = String(token || '').split('.');
  if (!key || parts.length !== 4 || parts[0] !== 'emp' || !/^\d+$/.test(parts[1])) return null;
  const [, issued, id, sig] = parts;
  const want = crypto.createHmac('sha256', key).update('emp.' + issued + '.' + id).digest('hex');
  if (!safeEqHex(want, sig)) return null;
  if ((Date.now() - parseInt(issued, 10)) / 3.6e6 >= EMP_TTL_HOURS) return null;
  try { return Buffer.from(id, 'base64url').toString('utf8'); } catch (_) { return null; }
}

function employeeTokenFrom(event, body) {
  const h = (event && event.headers) || {};
  const auth = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return (m && m[1]) || h['x-employee-token'] || (body && body.employeeToken) || '';
}

// Only what one employee needs to see: their own shifts + own time-off.
function employeeView(doc, employeeId) {
  const me = (doc.employees || []).find((e) => e.id === employeeId);
  if (!me) return null;
  const schedules = {};
  for (const [week, w] of Object.entries(doc.schedules || {})) {
    const mine = w && w.shifts && w.shifts[employeeId];
    schedules[week] = { shifts: mine ? { [employeeId]: mine } : {}, submitted: !!(w && w.submitted), submittedAt: (w && w.submittedAt) || null };
  }
  const pub = { id: me.id, name: me.name, firstName: me.firstName, lastName: me.lastName, email: me.email, primaryRole: me.primaryRole, secondaryRoles: me.secondaryRoles || [] };
  return {
    employees: [pub],
    schedules,
    timeOffRequests: (doc.timeOffRequests || []).filter((r) => r.employeeId === employeeId),
    lastUpdated: doc.lastUpdated || null,
  };
}

module.exports = {
  readSchedule, writeSchedule, readCredentials, writeCredentials,
  hashPassword, verifyPassword,
  signEmployeeToken, verifyEmployeeToken, employeeTokenFrom, employeeView,
  EMPTY, __setTestStore,
};
