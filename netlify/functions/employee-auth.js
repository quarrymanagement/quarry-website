const https = require('https');
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

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const response = (statusCode, body) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(body),
});

const handleOptions = () => response(200, { message: 'OK' });

// GitHub API helper
const githubRequest = (method, path, token, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'Quarry-Admin-Panel',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
};

// Hash password with salt
const hashPassword = (password, salt = null) => {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `${salt}:${hash}`;
};

// Verify password
const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const testHash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return testHash === hash;
};

// Generate session token
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Handle login action
const handleLogin = async (body, token, clientIp) => {
  const { email, password } = body;
  if (!email || !password) {
    return response(400, { error: 'Email and password required' });
  }

  // Brute-force guard (login path only) — fails closed.
  const rlArgs = {
    scope: RL_SCOPE, email: String(email).toLowerCase(), ip: clientIp,
    emailLimit: RL_EMAIL_LIMIT, ipLimit: RL_IP_LIMIT,
    reason: RL_TOO_MANY_MESSAGE,
  };
  let rlGate;
  try {
    rlGate = await rlCheckFailures(rlArgs);
  } catch (e) {
    console.error('employee-auth: rate-limit store unavailable:', e && e.message);
    return response(503, { error: RL_STORE_DOWN_MESSAGE });
  }
  if (!rlGate.allowed) {
    return response(429, { error: rlGate.reason, rateLimit: true });
  }
  const rlFailedLogin = async () => {
    try {
      await rlRecordFailure(rlArgs);
    } catch (e) {
      console.error('employee-auth: could not record failed attempt:', e && e.message);
      return response(503, { error: RL_STORE_DOWN_MESSAGE });
    }
    return response(401, { error: 'Invalid email or password' });
  };

  try {
    // Fetch schedule.json to get employees list
    const res = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);

    if (res.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(res.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];

    // Find employee by email
    const employee = employees.find(emp => emp.email && emp.email.toLowerCase() === email.toLowerCase());
    if (!employee) {
      return rlFailedLogin();
    }

    // Verify password
    if (!employee.passwordHash || !verifyPassword(password, employee.passwordHash)) {
      return rlFailedLogin();
    }

    // Correct password — wipe this email's failed-attempt counter.
    await rlClearFailures(rlArgs);

    // Generate session token
    const sessionToken = generateToken();

    return response(200, {
      success: true,
      employee: {
        id: employee.id,
        name: employee.name,
        email: employee.email,
        primaryRole: employee.primaryRole,
      },
      token: sessionToken,
    });
  } catch (err) {
    console.error('Login error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle change password action
const handleChangePassword = async (body, token) => {
  const { employeeId, oldPassword, newPassword } = body;
  if (!employeeId || !oldPassword || !newPassword) {
    return response(400, { error: 'employeeId, oldPassword, and newPassword required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];
    const sha = shaRes.data.sha;

    // Find employee
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
      return response(404, { error: 'Employee not found' });
    }

    // Verify old password
    if (!employee.passwordHash || !verifyPassword(oldPassword, employee.passwordHash)) {
      return response(401, { error: 'Current password is incorrect' });
    }

    // Update password
    employee.passwordHash = hashPassword(newPassword);

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Update employee password',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      return response(200, { success: true, message: 'Password updated' });
    } else {
      return response(putRes.statusCode, { error: 'Failed to update password' });
    }
  } catch (err) {
    console.error('Change password error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

// Handle register first time action
const handleRegisterFirstTime = async (body, token) => {
  const { email, password } = body;
  if (!email || !password) {
    return response(400, { error: 'Email and password required' });
  }

  try {
    // Fetch schedule.json
    const shaRes = await githubRequest('GET', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token);
    if (shaRes.statusCode !== 200) {
      return response(500, { error: 'Could not fetch employee data' });
    }

    const scheduleContent = Buffer.from(shaRes.data.content, 'base64').toString('utf-8');
    const scheduleData = JSON.parse(scheduleContent);
    const employees = scheduleData.employees || [];
    const sha = shaRes.data.sha;

    // Find employee by email
    const employee = employees.find(emp => emp.email && emp.email.toLowerCase() === email.toLowerCase());
    if (!employee) {
      return response(404, { error: 'Employee not found in system' });
    }

    // Check if already has password
    if (employee.passwordHash) {
      return response(400, { error: 'Employee already has a password set' });
    }

    // Set password
    employee.passwordHash = hashPassword(password);

    // Save back to GitHub
    const updatedContent = JSON.stringify(scheduleData, null, 2);
    const encoded = Buffer.from(updatedContent, 'utf-8').toString('base64');

    const putData = {
      message: 'Set employee password on first-time registration',
      content: encoded,
      sha,
    };

    const putRes = await githubRequest('PUT', '/repos/quarrymanagement/quarry-website/contents/schedule.json', token, putData);

    if (putRes.statusCode === 200 || putRes.statusCode === 201) {
      const sessionToken = generateToken();
      return response(200, {
        success: true,
        message: 'Password set successfully',
        token: sessionToken,
        employee: {
          id: employee.id,
          name: employee.name,
          email: employee.email,
          primaryRole: employee.primaryRole,
        },
      });
    } else {
      return response(putRes.statusCode, { error: 'Failed to set password' });
    }
  } catch (err) {
    console.error('Register first time error:', err);
    return response(500, { error: 'Internal server error' });
  }
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return handleOptions();
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return response(500, { error: 'GitHub token not configured on server' });
  }

  // Read the source IP the same way request-code.js does.
  const clientIp = rlClientIp(event);

  try {
    const body = JSON.parse(event.body);
    const action = body.action;

    switch (action) {
      case 'login':
        return await handleLogin(body, token, clientIp);
      case 'change-password':
        return await handleChangePassword(body, token);
      case 'register-first-time':
        return await handleRegisterFirstTime(body, token);
      default:
        return response(400, { error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Auth error:', err);
    return response(500, { error: err.message || 'Internal server error' });
  }
};
