// ============================================================================
// scan-receipt.js — credit a member by scanning a Toast receipt
//
// POST { token, image }
//   token: session token from verify-code.js
//   image: data URL ("data:image/jpeg;base64,...")
//
// Flow:
//   1. Verify session token → resolve member
//   2. Run Claude Vision OCR on image → extract check#, date, total, etc.
//   3. Cross-validate against Toast Open API (real check, total matches)
//   4. Dedupe via credited-orders.json (first-claim-wins)
//   5. Daily scan cap (2/day per member)
//   6. Soft-flag cardholder name mismatch → push to scanned-flagged.json
//   7. Award points (10 × total + 10 visit bonus, × tier multiplier)
//   8. Append to member history + credited-orders.json
//
// ENV:
//   MEMBER_AUTH_SECRET, GITHUB_TOKEN          — auth + storage
//   ANTHROPIC_API_KEY                         — Claude Vision OCR
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET      — Toast OAuth
//   TOAST_RESTAURANT_GUID                     — restaurant ID (Toast-Restaurant-External-ID header)
// ============================================================================

const crypto = require('crypto');
const https = require('https');

const SECRET            = process.env.MEMBER_AUTH_SECRET || '';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO       = 'quarrymanagement/quarry-website';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const TOAST_CLIENT_ID   = process.env.TOAST_CLIENT_ID || '';
const TOAST_SECRET      = process.env.TOAST_CLIENT_SECRET || '';
const TOAST_REST_GUID   = process.env.TOAST_RESTAURANT_GUID || '';

const SESSION_TTL_DAYS  = 30;
const MAX_SCANS_PER_DAY = 2;
const SCAN_WINDOW_HOURS = 24;
const MIN_TAB_USD       = 20;
const TOTAL_TOLERANCE   = 1.0;
const RESTAURANT_KEYWORDS = ['quarry'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ─── Session token (matches verify-code.js exactly) ────────────────────────
function verifySessionToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [email, issuedStr, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update(email + ':' + issuedStr).digest('hex');
    if (sig !== expected) return null;
    const ageMs = Date.now() - parseInt(issuedStr, 10);
    if (ageMs > SESSION_TTL_DAYS * 24 * 3600 * 1000) return null;
    return email.toLowerCase();
  } catch (_) { return null; }
}

// ─── Generic HTTPS helper ──────────────────────────────────────────────────
function httpsRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}'), raw: d }); }
        catch (_) { resolve({ status: res.statusCode, data: d, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── GitHub helpers (match toast-order-webhook.js pattern) ─────────────────
function gh(method, path, body) {
  return httpsRequest({
    hostname: 'api.github.com', path, method,
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'User-Agent': 'Quarry-Receipt-Scan',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
  }, body);
}

async function loadJson(filePath) {
  const r = await gh('GET', '/repos/' + GITHUB_REPO + '/contents/' + filePath);
  if (r.status === 404) return { sha: null, json: null };
  if (r.status !== 200) throw new Error('GitHub load ' + filePath + ': HTTP ' + r.status);
  return { sha: r.data.sha, json: JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8')) };
}

async function saveJson(filePath, json, sha, message) {
  const content = Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64');
  const body = sha ? { message, content, sha } : { message, content };
  const r = await gh('PUT', '/repos/' + GITHUB_REPO + '/contents/' + filePath, body);
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub save ' + filePath + ': HTTP ' + r.status + ' ' + (r.raw || ''));
  return r.data.content && r.data.content.sha;
}

// ─── Claude Vision OCR ─────────────────────────────────────────────────────
async function ocrReceipt(imageBase64, mediaType) {
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        {
          type: 'text',
          text: `Extract structured data from this restaurant receipt photo.
Reply with ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "check_number": string|null,        // the check/order number (e.g., "1247")
  "transaction_date": string|null,    // ISO date "YYYY-MM-DD"
  "transaction_time": string|null,    // 24-hour "HH:MM"
  "total_amount": number|null,        // final paid amount, including tax+tip
  "restaurant_name": string|null,     // name as printed on receipt
  "cardholder_name": string|null,     // ONLY if credit card receipt; null otherwise
  "payment_type": string|null         // "credit" | "cash" | "gift" | "other"
}

If a field is unclear, set it to null. Do not invent data.`
        }
      ]
    }]
  };

  const r = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  }, payload);

  if (r.status !== 200) throw new Error('OCR API: HTTP ' + r.status);
  const txt = (r.data.content && r.data.content[0] && r.data.content[0].text || '').trim();
  const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// ─── Toast OAuth + order lookup ────────────────────────────────────────────
async function getToastToken() {
  const r = await httpsRequest({
    hostname: 'ws-api.toasttab.com',
    path: '/authentication/v1/authentication/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    clientId: TOAST_CLIENT_ID,
    clientSecret: TOAST_SECRET,
    userAccessType: 'TOAST_MACHINE_CLIENT',
  });
  if (r.status !== 200 || !r.data.token) throw new Error('Toast auth: HTTP ' + r.status);
  return r.data.token.accessToken;
}

async function findToastOrder(checkNumber, businessDateYYYYMMDD) {
  const token = await getToastToken();
  // Toast uses ordersBulk for date-range fetch; businessDate=yyyyMMdd
  const r = await httpsRequest({
    hostname: 'ws-api.toasttab.com',
    path: '/orders/v2/ordersBulk?businessDate=' + businessDateYYYYMMDD + '&pageSize=100',
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Toast-Restaurant-External-ID': TOAST_REST_GUID,
      'Accept': 'application/json',
    },
  });
  if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('Toast lookup: HTTP ' + r.status);

  for (const order of r.data) {
    for (const check of (order.checks || [])) {
      const dn = String(check.displayNumber || check.tabName || '').replace(/^#?/, '');
      if (dn === String(checkNumber).replace(/^#?/, '')) {
        return { order, check };
      }
    }
  }
  return null;
}

function extractCardholder(check) {
  if (!check || !check.payments) return null;
  for (const p of check.payments) {
    if (p.cardHolderFirstName || p.cardHolderLastName) {
      return ((p.cardHolderFirstName || '') + ' ' + (p.cardHolderLastName || '')).trim();
    }
    if (p.cardHolderName) return p.cardHolderName;
  }
  return null;
}

function checkTotal(check) {
  if (!check) return 0;
  return check.totalAmount || check.amount ||
    ((check.subtotal || 0) + (check.tax || 0) + (check.tipAmount || 0)) || 0;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function namesOverlap(a, b) {
  if (!a || !b) return true;
  const tok = (s) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
  const aTok = new Set(tok(a));
  for (const t of tok(b)) if (aTok.has(t)) return true;
  return false;
}

function tierMult(tier) {
  return ({ standard: 1.0, silver: 1.1, gold: 1.25, elite: 1.5, platinum: 1.5 }[tier]) || 1.0;
}

// ─── Main handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });

  if (!SECRET || !GITHUB_TOKEN || !ANTHROPIC_API_KEY || !TOAST_CLIENT_ID || !TOAST_SECRET || !TOAST_REST_GUID) {
    return reply(500, { ok: false, error: 'Server not fully configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return reply(400, { ok: false, error: 'Invalid JSON' }); }

  const { token, image } = body;
  if (!token || !image) return reply(400, { ok: false, error: 'Missing token or image' });

  const email = verifySessionToken(token);
  if (!email) return reply(401, { ok: false, error: 'Session expired — please sign in again' });

  const m = String(image).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return reply(400, { ok: false, error: 'Invalid image format' });
  const mediaType = m[1];
  const imageBase64 = m[2];

  // ── 1. OCR ──
  let ocr;
  try { ocr = await ocrReceipt(imageBase64, mediaType); }
  catch (e) { return reply(500, { ok: false, error: 'Could not read receipt — please try a clearer photo' }); }

  if (!ocr.check_number || !ocr.transaction_date || !ocr.total_amount) {
    return reply(400, { ok: false, error: 'Could not extract receipt details. Please use a clearer, well-lit photo.' });
  }

  // ── 2. Restaurant must include "Quarry" ──
  const restName = (ocr.restaurant_name || '').toLowerCase();
  if (!RESTAURANT_KEYWORDS.some((k) => restName.includes(k))) {
    return reply(400, { ok: false, error: 'This receipt does not appear to be from The Quarry.' });
  }

  // ── 3. Receipt freshness (24-hour window) ──
  const receiptIso = ocr.transaction_date + 'T' + (ocr.transaction_time || '23:59') + ':00';
  const receiptTs = new Date(receiptIso).getTime();
  if (isNaN(receiptTs)) return reply(400, { ok: false, error: 'Could not parse receipt date.' });
  const ageHours = (Date.now() - receiptTs) / 3600000;
  if (ageHours > SCAN_WINDOW_HOURS) {
    return reply(400, { ok: false, error: `This receipt is more than ${SCAN_WINDOW_HOURS} hours old — the scan window has expired.` });
  }
  if (ageHours < -2) return reply(400, { ok: false, error: 'Receipt date is in the future.' });

  // ── 4. Min tab ──
  if (ocr.total_amount < MIN_TAB_USD) {
    return reply(400, { ok: false, error: `Receipts under $${MIN_TAB_USD} are not eligible for points.` });
  }

  // ── 5. Cross-validate with Toast ──
  const businessDate = ocr.transaction_date.replace(/-/g, '');
  let toastMatch;
  try { toastMatch = await findToastOrder(ocr.check_number, businessDate); }
  catch (e) { return reply(502, { ok: false, error: 'Could not verify with Toast right now. Please try again in a few minutes.' }); }
  if (!toastMatch) {
    return reply(400, { ok: false, error: 'We could not find this check in our records. Double-check the photo and try again.' });
  }
  const toastTotal = checkTotal(toastMatch.check);
  if (Math.abs(toastTotal - ocr.total_amount) > TOTAL_TOLERANCE) {
    return reply(400, { ok: false, error: 'Receipt total does not match our records.' });
  }
  const toastOrderId = toastMatch.order.guid;
  const cardholder = extractCardholder(toastMatch.check);

  // ── 6. Dedupe ──
  let creditedFile = await loadJson('credited-orders.json');
  let credited = creditedFile.json || { orders: [] };
  if (credited.orders.some((o) => o.orderId === toastOrderId)) {
    return reply(400, { ok: false, error: 'This receipt has already been credited.' });
  }

  // ── 7. Member + daily scan cap ──
  const membersFile = await loadJson('members.json');
  if (!membersFile.json) return reply(500, { ok: false, error: 'Members file missing' });
  const member = (membersFile.json.members || []).find((x) => (x.email || '').toLowerCase() === email);
  if (!member) return reply(404, { ok: false, error: 'Member record not found.' });

  const todayIso = new Date().toISOString().split('T')[0];
  const todayScans = (member.history || []).filter(
    (h) => h.action === 'earn' && h.source === 'receipt-scan' && h.at && h.at.startsWith(todayIso)
  ).length;
  if (todayScans >= MAX_SCANS_PER_DAY) {
    return reply(429, { ok: false, error: `You've reached today's limit of ${MAX_SCANS_PER_DAY} receipt scans. Try again tomorrow.` });
  }

  // ── 8. Cardholder soft check ──
  if (cardholder && member.name && !namesOverlap(cardholder, member.name)) {
    let flaggedFile = await loadJson('scanned-flagged.json');
    let flagged = flaggedFile.json || { items: [] };
    flagged.items.push({
      id: 'flag-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
      memberEmail: member.email,
      memberName: member.name,
      orderId: toastOrderId,
      checkNumber: ocr.check_number,
      total: toastTotal,
      cardholder,
      reason: 'Cardholder name mismatch',
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
    await saveJson('scanned-flagged.json', flagged, flaggedFile.sha,
      'flag scan: ' + ocr.check_number + ' for ' + member.email);
    return reply(200, {
      ok: false,
      flagged: true,
      error: "This receipt's card name doesn't match your account. We've flagged it for review — we'll email you within a day if it's approved.",
    });
  }

  // ── 9. Compute points ──
  const tier = member.tier || 'standard';
  const mult = tierMult(tier);
  const basePts = Math.round(toastTotal * 10);
  const visitBonus = toastTotal >= MIN_TAB_USD ? 10 : 0;
  const totalPts = Math.round((basePts + visitBonus) * mult);

  // ── 10. Update member ──
  member.currentPoints = (member.currentPoints || 0) + totalPts;
  member.lifetimePoints = (member.lifetimePoints || 0) + totalPts;
  member.lastVisitAt = new Date().toISOString();
  member.history = member.history || [];
  member.history.push({
    at: new Date().toISOString(),
    action: 'earn',
    source: 'receipt-scan',
    delta: totalPts,
    orderId: toastOrderId,
    checkNumber: ocr.check_number,
    spendUsd: toastTotal,
    tier,
    multiplier: mult,
    note: 'Receipt scan',
  });

  await saveJson('members.json', membersFile.json, membersFile.sha,
    `+${totalPts} pts (receipt scan) — ${member.email}`);

  // ── 11. Append to credited-orders ledger ──
  credited.orders.push({
    orderId: toastOrderId,
    checkNumber: ocr.check_number,
    memberEmail: member.email,
    total: toastTotal,
    points: totalPts,
    creditedAt: new Date().toISOString(),
  });
  await saveJson('credited-orders.json', credited, creditedFile.sha,
    `credit ${ocr.check_number} → ${member.email}`);

  return reply(200, {
    ok: true,
    points: totalPts,
    basePoints: basePts,
    visitBonus,
    multiplier: mult,
    newBalance: member.currentPoints,
    spendUsd: toastTotal,
    checkNumber: ocr.check_number,
  });
};
