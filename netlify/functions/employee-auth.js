const crypto = require('crypto');
const { readBlob, writeBlob } = require('./_blobs');

// Failed staff-login brute-force limits (sliding 15-minute window). These apply
// ONLY to the 'login' action below — not to change-password or first-time
// registration.
const RL_SCOPE = 'employee-login';
const RL_EMAIL_LIMIT = 10;  // failed logins per email per 15 min
const RL_IP_LIMIT = 50;     // failed logins per source IP per 15 min
const RL_TOO_MANY_MESSAGE = 'Too many failed sign-in attempts. Please wait a few minutes and try again.';

// ---- RL-BEGIN: failed-attempt limiter (sliding window, Netlify Blobs) -------
// Same storage + hashing style as request-code.js: counters live in Netlify
// Blobs and identifiers are hashed with rlSha256short() so raw emails and IPs
// never appear in a blob key. The difference is what is counted (failed auth
// attempts, not requests) and the failure mode.
//
// THIS LIMITER FAILS CLOSED. If the counter store is unavailable we reject the
// request (503) instead of letting it through. request-code.js deliberately
// fails OPEN because the worst case there is a few extra emails; here the
// counter is the only thing standing between an attacker and an account
// takeover, so an uncounted attempt is a free guess.
const RL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RL_STORE_DOWN_MESSAGE = 'We could not verify that right now. Please try again shortly.';

function rlSha256short(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}
// Read the source IP exactly the way request-code.js does.
function rlClientIp(event) {
  const h = (event && event.headers) || {};
  return String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
}
function rlEmailKey(scope, email) {
  return 'rate-limit/' + scope + '-fail-email-' + rlSha256short(String(email || '').toLowerCase());
}
function rlIpKey(scope, ip) {
  return 'rate-limit/' + scope + '-fail-ip-' + rlSha256short(ip || 'unknown');
}
// readBlob() swallows transport errors and returns null, so a null read means
// "no attempts recorded". The dependable store-health signal is the write path
// (writeBlob returns false on failure), which runs on every counted failure —
// so a broken store surfaces on the first bad guess and becomes a 503 rather
// than an unmetered retry.
async function rlLoad(key, now, windowMs) {
  const rec = await readBlob(key); // may throw -> caller fails closed
  const list = (rec && Array.isArray(rec.ts)) ? rec.ts : [];
  return list.filter((t) => typeof t === 'number' && (now - t) < windowMs);
}
async function rlSave(key, ts) {
  const ok = await writeBlob(key, { ts: ts });
  if (ok === false) throw new Error('rate-limit store write failed: ' + key);
  return true;
}
// Is this email/IP already over budget? Throws if the store is unreachable.
async function rlCheckFailures(o) {
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const windowMs = o.windowMs || RL_WINDOW_MS;
  const emailTs = await rlLoad(rlEmailKey(o.scope, o.email), now, windowMs);
  if (emailTs.length >= o.emailLimit) return { allowed: false, reason: o.reason, scopeHit: 'email' };
  const ipTs = await rlLoad(rlIpKey(o.scope, o.ip), now, windowMs);
  if (ipTs.length >= o.ipLimit) return { allowed: false, reason: o.reason, scopeHit: 'ip' };
  return { allowed: true };
}
// Record ONE failed attempt against both counters. Throws if the store is
// unreachable — callers must turn that into a 503, never into a pass.
async function rlRecordFailure(o) {
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const windowMs = o.windowMs || RL_WINDOW_MS;
  const ek = rlEmailKey(o.scope, o.email);
  const ik = rlIpKey(o.scope, o.ip);
  const emailTs = await rlLoad(ek, now, windowMs);
  const ipTs = await rlLoad(ik, now, windowMs);
  emailTs.push(now);
  ipTs.push(now);
  await rlSave(ek, emailTs);
  await rlSave(ik, ipTs);
  return true;
}
// Clear the email counter after a success. Never throws: a store hiccup must
// not turn a valid sign-in into an error (stale counters expire on their own).
async function rlClearFailures(o) {
  try {
    await writeBlob(rlEmailKey(o.scope, o.email), { ts: [] });
  } catch (e) {
    console.warn('rate-limit clear failed:', e && e.message);
  }
  return true;
}
// ---- RL-END ----------------------------------------------------------------

const {
  readSchedule, readCredentials, writeCredentials,
  hashPassword, verifyPassword, signEmployeeToken, verifyEmployeeToken, employeeTokenFrom,
} = require('./_schedule-store');
const { isAuthorized } = require('./_admin-auth');

// Staff data now lives in private Netlify Blobs (see _schedule-store.js), not
// in schedule.json in the public GitHub repo.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
};
const response = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
const handleOptions = () => response(200, { message: 'OK' });

const publicEmployee = (e, mustChange) => ({
  id: e.id, name: e.name, email: e.email, primaryRole: e.primaryRole,
  mustChangePassword: !!mustChange,
});

function lastNameOf(emp) {
  return String(emp.lastName || (emp.name || '').split(' ').pop() || '').toLowerCase().trim();
}

// Shared brute-force wrapper for login + lookup (fails closed).
async function withLimiter(scope, email, clientIp, fn) {
  const rlArgs = {
    scope, email: String(email).toLowerCase(), ip: clientIp,
    emailLimit: RL_EMAIL_LIMIT, ipLimit: RL_IP_LIMIT, reason: RL_TOO_MANY_MESSAGE,
  };
  let gate;
  try { gate = await rlCheckFailures(rlArgs); } catch (e) {
    console.error('employee-auth: rate-limit store unavailable:', e && e.message);
    return response(503, { error: RL_STORE_DOWN_MESSAGE });
  }
  if (!gate.allowed) return response(429, { error: gate.reason, rateLimit: true });
  const fail = async (msg) => {
    try { await rlRecordFailure(rlArgs); } catch (e) {
      console.error('employee-auth: could not record failed attempt:', e && e.message);
      return response(503, { error: RL_STORE_DOWN_MESSAGE });
    }
    return response(401, { error: msg });
  };
  const ok = async () => { await rlClearFailures(rlArgs); };
  return fn(fail, ok);
}

// action: login  { email, password }  (employee portal /employee/)
const handleLogin = async (body, clientIp) => {
  const { email, password } = body;
  if (!email || !password) return response(400, { error: 'Email and password required' });
  return withLimiter(RL_SCOPE, email, clientIp, async (fail, ok) => {
    const doc = await readSchedule();
    const creds = await readCredentials();
    const employee = doc.employees.find((emp) => emp.email && emp.email.toLowerCase() === String(email).toLowerCase());
    const cred = employee && creds[employee.id];
    const v = cred ? verifyPassword(password, cred.hash) : { ok: false };
    if (!employee || !v.ok || employee.status === 'inactive') return fail('Invalid email or password');
    await ok();
    if (v.legacy) { // upgrade the weak legacy hash in place
      creds[employee.id] = { ...cred, hash: hashPassword(password), setAt: new Date().toISOString() };
      await writeCredentials(creds);
    }
    return response(200, {
      success: true,
      employee: publicEmployee(employee, cred.mustChange),
      token: signEmployeeToken(employee.id),
    });
  });
};

// action: lookup  { email, lastName }  (schedule.html — same check it used to
// do in the browser, now server-side + rate-limited, so the staff list is
// never downloaded).
const handleLookup = async (body, clientIp) => {
  const { email, lastName } = body;
  if (!email || !lastName) return response(400, { error: 'Email and last name required' });
  return withLimiter('employee-lookup', email, clientIp, async (fail, ok) => {
    const doc = await readSchedule();
    const employee = doc.employees.find((emp) => emp.email && emp.email.toLowerCase() === String(email).toLowerCase().trim()
      && lastNameOf(emp) === String(lastName).toLowerCase().trim());
    if (!employee || employee.status === 'inactive') return fail('Invalid email or last name');
    await ok();
    return response(200, { success: true, employee: publicEmployee(employee, false), token: signEmployeeToken(employee.id) });
  });
};

// action: change-password  { oldPassword, newPassword }  + employee token
const handleChangePassword = async (event, body) => {
  const empId = verifyEmployeeToken(employeeTokenFrom(event, body));
  if (!empId) return response(401, { error: 'Please sign in again' });
  const { oldPassword, newPassword } = body;
  if (!oldPassword || !newPassword) return response(400, { error: 'oldPassword and newPassword required' });
  if (String(newPassword).length < 8) return response(400, { error: 'Password must be at least 8 characters' });
  const creds = await readCredentials();
  const cred = creds[empId];
  if (!cred || !verifyPassword(oldPassword, cred.hash).ok) return response(401, { error: 'Current password is incorrect' });
  creds[empId] = { hash: hashPassword(newPassword), mustChange: false, setAt: new Date().toISOString() };
  await writeCredentials(creds);
  return response(200, { success: true, message: 'Password updated' });
};

// action: admin-set-password  { employeeId, tempPassword }  + OWNER admin token.
// The only way a password gets set now (resets + new hires). The employee must
// change it at next sign-in.
const handleAdminSetPassword = async (event, body) => {
  if (!isAuthorized(event, body, [])) return response(401, { error: 'Admin session required' });
  const { employeeId, tempPassword } = body;
  if (!employeeId || !tempPassword || String(tempPassword).length < 8) {
    return response(400, { error: 'employeeId and a temporary password of 8+ characters required' });
  }
  const doc = await readSchedule();
  if (!doc.employees.some((e) => e.id === employeeId)) return response(404, { error: 'Employee not found' });
  const creds = await readCredentials();
  creds[employeeId] = { hash: hashPassword(tempPassword), mustChange: true, setAt: new Date().toISOString() };
  await writeCredentials(creds);
  return response(200, { success: true });
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  const clientIp = rlClientIp(event);
  try {
    const body = JSON.parse(event.body || '{}');
    switch (body.action) {
      case 'login': return await handleLogin(body, clientIp);
      case 'lookup': return await handleLookup(body, clientIp);
      case 'change-password': return await handleChangePassword(event, body);
      case 'admin-set-password': return await handleAdminSetPassword(event, body);
      case 'register-first-time':
        // Disabled: anyone who knew a staff email could claim an account
        // that had no password yet. A manager now sets a temporary password.
        return response(410, { error: 'Ask a manager for a temporary password.' });
      default: return response(400, { error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Auth error:', err && err.message);
    return response(err && err.status === 503 ? 503 : 500, { error: 'Internal server error' });
  }
};
