// ============================================================================
// scan-receipt.js — credit a member by scanning a Toast receipt (v1.3)
//
// POST { token, image }
//
// v1.3: pending-queue when Toast hasn't synced yet.
//   - Self-heal: every scan first retries this user's pending queue
//     (in case Toast caught up since last attempt)
//   - On Toast-miss: queue to pending-scans.json instead of rejecting
//   - Customer sees friendly "Queued — credited within a few hours"
//   - Cron (process-pending-scans.js) walks the queue hourly
//   - 6-hour TTL: queued scans expire and notify member
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
const SCAN_WINDOW_HOURS = 12;
const PENDING_TTL_HOURS = 6;
const MIN_TAB_USD       = 20;
const TOTAL_TOLERANCE   = 1.0;
const RESTAURANT_KEYWORDS = [
  'quarry',
  'the quarry',
  'new melle',
  '63365',
  'highway z',
  'hwy z',
  '3960',          // street number
  '17a quarry',    // common Toast restaurant code prefix variants
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const reply = (s, b) => ({ statusCode: s, headers: CORS, body: JSON.stringify(b) });

// ─── Session token ─────────────────────────────────────────────────────────
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

// ─── HTTPS helper ──────────────────────────────────────────────────────────
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

// ─── GitHub helpers ────────────────────────────────────────────────────────
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
  const r = await httpsRequest({
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  }, {
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: `Extract structured data from this restaurant receipt photo.
Reply with ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "check_number": string|null,
  "transaction_date": string|null,
  "transaction_time": string|null,
  "subtotal_amount": number|null,
  "tax_amount": number|null,
  "tip_amount": number|null,
  "total_amount": number|null,
  "restaurant_name": string|null,
  "restaurant_address": string|null,
  "cardholder_name": string|null,
  "payment_type": string|null
}

If a field is unclear, set it to null. Do not invent data. The subtotal_amount is critical — pre-tax line, NOT including tax or tip. The restaurant_name and restaurant_address should capture WHATEVER is printed at the top of the receipt as the establishment header.` }
      ]
    }]
  });
  if (r.status !== 200) throw new Error('OCR API: HTTP ' + r.status);
  const txt = (r.data.content && r.data.content[0] && r.data.content[0].text || '').trim();
  return JSON.parse(txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
}

// ─── Toast OAuth + lookup ──────────────────────────────────────────────────
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

async function findToastOrder(checkNumber, businessDateYYYYMMDD, token) {
  if (!token) token = await getToastToken();
  const target = String(checkNumber).replace(/^#?/, '');
  // Toast ordersBulk paginates at max 100 orders/page. Walk up to 10 pages.
  for (let page = 1; page <= 10; page++) {
    const r = await httpsRequest({
      hostname: 'ws-api.toasttab.com',
      path: '/orders/v2/ordersBulk?businessDate=' + businessDateYYYYMMDD + '&pageSize=100&page=' + page,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Toast-Restaurant-External-ID': TOAST_REST_GUID,
        'Accept': 'application/json',
      },
    });
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error('Toast lookup: HTTP ' + r.status);
    if (r.data.length === 0) return null;
    for (const order of r.data) {
      for (const check of (order.checks || [])) {
        const dn = String(check.displayNumber || check.tabName || '').replace(/^#?/, '');
        if (dn === target) return { order, check };
      }
    }
    if (r.data.length < 100) return null;
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

function checkSubtotal(check) {
  if (!check) return 0;
  if (typeof check.amount === 'number') return check.amount;
  if (typeof check.subtotal === 'number') return check.subtotal;
  return 0;
}

function checkPreTipTotal(check) {
  if (!check) return 0;
  const sub = checkSubtotal(check);
  const tax = (typeof check.taxAmount === 'number') ? check.taxAmount : (check.tax || 0);
  if (sub) return sub + tax;
  if (typeof check.totalAmount === 'number') {
    return check.totalAmount - (check.tipAmount || 0);
  }
  return 0;
}

function checkTotal(check) {
  if (!check) return 0;
  return check.totalAmount || ((checkSubtotal(check) + (check.taxAmount || 0) + (check.tipAmount || 0))) || 0;
}

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

// ─── Self-heal: process this member's pending queue first ──────────────────
async function processMemberPending(memberEmail, toastToken) {
  const pendingFile = await loadJson('pending-scans.json');
  if (!pendingFile.json) return { credited: 0, expired: 0 };
  const items = pendingFile.json.items || [];
  const myItems = items.filter((it) =>
    it.status === 'pending' && (it.memberEmail || '').toLowerCase() === memberEmail.toLowerCase()
  );
  if (!myItems.length) return { credited: 0, expired: 0 };

  let credited = 0, expired = 0;
  let pendingDirty = false;
  let creditedFile = null, creditedJson = null;
  let membersFile = null, membersJson = null;

  for (const it of myItems) {
    const ageHours = (Date.now() - new Date(it.transactionAt).getTime()) / 3600000;

    // Check if expired
    if (ageHours > PENDING_TTL_HOURS + SCAN_WINDOW_HOURS) {
      it.status = 'expired';
      it.decidedAt = new Date().toISOString();
      pendingDirty = true;
      expired++;
      continue;
    }

    // Try Toast lookup
    let match;
    try { match = await findToastOrder(it.checkNumber, it.businessDate, toastToken); }
    catch (_) { continue; } // Toast failure → leave for next retry

    if (!match) {
      it.tryCount = (it.tryCount || 1) + 1;
      it.lastTriedAt = new Date().toISOString();
      pendingDirty = true;
      continue;
    }

    // Found! Validate + credit
    const toastSubtotal = checkSubtotal(match.check);
    const toastPreTip = checkPreTipTotal(match.check);
    const toastTotal = checkTotal(match.check);
    if (it.ocrSubtotal != null && Math.abs(toastSubtotal - it.ocrSubtotal) > TOTAL_TOLERANCE) {
      it.status = 'mismatch';
      it.decidedAt = new Date().toISOString();
      pendingDirty = true;
      continue;
    }
    if (toastPreTip < MIN_TAB_USD) {
      it.status = 'below-minimum';
      it.decidedAt = new Date().toISOString();
      pendingDirty = true;
      continue;
    }

    // Dedupe + credit (load on first hit)
    if (!creditedFile) {
      creditedFile = await loadJson('credited-orders.json');
      creditedJson = creditedFile.json || { orders: [] };
    }
    if (creditedJson.orders.some((o) => o.orderId === match.order.guid)) {
      it.status = 'duplicate';
      it.decidedAt = new Date().toISOString();
      pendingDirty = true;
      continue;
    }
    if (!membersFile) {
      membersFile = await loadJson('members.json');
      membersJson = membersFile.json;
    }
    const member = (membersJson.members || []).find((x) => (x.email || '').toLowerCase() === memberEmail.toLowerCase());
    if (!member) continue;

    const tier = member.tier || 'standard';
    const mult = tierMult(tier);
    const earnBasis = toastPreTip;
    const basePts = Math.round(earnBasis * 10);
    const visitBonus = earnBasis >= MIN_TAB_USD ? 10 : 0;
    const totalPts = Math.round((basePts + visitBonus) * mult);

    member.currentPoints = (member.currentPoints || 0) + totalPts;
    member.lifetimePoints = (member.lifetimePoints || 0) + totalPts;
    member.lastVisitAt = new Date().toISOString();
    member.history = member.history || [];
    member.history.push({
      at: new Date().toISOString(),
      action: 'earn',
      source: 'receipt-scan-retry',
      delta: totalPts,
      orderId: match.order.guid,
      checkNumber: it.checkNumber,
      spendUsd: earnBasis,
      finalTotalUsd: toastTotal,
      subtotalUsd: toastSubtotal,
      tier, multiplier: mult,
      note: 'Receipt scan (queued ' + (it.tryCount || 1) + ' retries)',
    });

    creditedJson.orders.push({
      orderId: match.order.guid,
      checkNumber: it.checkNumber,
      memberEmail: memberEmail,
      subtotal: toastSubtotal,
      preTipTotal: earnBasis,
      finalTotal: toastTotal,
      points: totalPts,
      creditedAt: new Date().toISOString(),
      fromQueue: true,
    });

    it.status = 'credited';
    it.decidedAt = new Date().toISOString();
    it.creditedPoints = totalPts;
    pendingDirty = true;
    credited++;
  }

  // Save all dirty files (do members + credited first, then pending)
  if (credited > 0) {
    await saveJson('members.json', membersJson, membersFile.sha,
      `+pts via queue retry — ${memberEmail}`);
    await saveJson('credited-orders.json', creditedJson, creditedFile.sha,
      `credit (queue retry) → ${memberEmail}`);
  }
  if (pendingDirty) {
    await saveJson('pending-scans.json', pendingFile.json, pendingFile.sha,
      `process pending: ${credited} credited, ${expired} expired (${memberEmail})`);
  }
  return { credited, expired };
}



// Parse a wide range of date formats from OCR. Returns ISO YYYY-MM-DD or null.
function parseFlexibleDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  // ISO already
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) return str.substring(0, 10);
  // US M/D/Y or M-D-Y
  let m = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return y.toString().padStart(4, '0') + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  }
  // "May 4, 2026" or "May 4 2026" or "Mar. 22, 2025"
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
  m = str.match(/^([a-z]+)\.?\s+(\d{1,2})[,\s]+(\d{4})/i);
  if (m) {
    const mn = months[m[1].toLowerCase().slice(0, 4)] || months[m[1].toLowerCase().slice(0, 3)];
    if (mn) return m[3] + '-' + String(mn).padStart(2, '0') + '-' + m[2].padStart(2, '0');
  }
  // Last-resort native parse
  const d = new Date(str);
  if (!isNaN(d)) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return null;
}

function parseFlexibleTime(s) {
  if (!s) return null;
  const str = String(s).trim();
  // "17:30" or "5:30 PM" or "5:30PM" or "5 PM" or "1730"
  let m = str.match(/^(\d{1,2}):?(\d{2})\s*(am|pm)?/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const ampm = (m[3] || '').toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  }
  m = str.match(/^(\d{1,2})\s*(am|pm)/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const ampm = m[2].toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':00';
  }
  return null;
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
  if (!token) return reply(400, { ok: false, error: 'Missing token' });

  const email = verifySessionToken(token);
  if (!email) return reply(401, { ok: false, error: 'Session expired — please sign in again' });

  // ── Always self-heal this member's pending queue first (cheap, often credits something)
  let pendingResult = { credited: 0, expired: 0 };
  try { pendingResult = await processMemberPending(email); } catch (_) { /* ignore */ }

  // If no image was sent, this was a "retry-only" call. Return the result.
  if (!image) {
    return reply(200, {
      ok: true,
      retryOnly: true,
      credited: pendingResult.credited,
      expired: pendingResult.expired,
    });
  }

  const m = String(image).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return reply(400, { ok: false, error: 'Invalid image format' });
  const mediaType = m[1];
  const imageBase64 = m[2];

  // ── 1. OCR ──
  let ocr;
  try { ocr = await ocrReceipt(imageBase64, mediaType); }
  catch (e) { return reply(500, { ok: false, error: 'Could not read receipt — please try a clearer photo' }); }

  if (!ocr.check_number || !ocr.transaction_date) {
    return reply(400, { ok: false, error: 'Could not extract the check number or date from this receipt. Please use a clearer photo with the check #/order # and date visible.' });
  }
  // total_amount is helpful for fallback validation but not strictly required —
  // we'll cross-check subtotal against Toast in the lookup step.

  // ── 1b. Gift card receipts don't earn points (recipient earns when they spend it) ──
  if (ocr.payment_type && /gift/i.test(ocr.payment_type)) {
    return reply(400, { ok: false, error: 'Gift card receipts don\'t earn points — points are credited when the gift card is used.' });
  }

  // ── 2. (Restaurant name check removed) ──
  // Toast cross-check below uses our TOAST_RESTAURANT_GUID, so Toast will ONLY
  // return checks from THIS restaurant. That's the authoritative filter; OCR
  // header parsing was creating false negatives on email/online receipts whose
  // headers differ from the printed POS slip.

  // ── 3. Receipt freshness (12-hour submission window) ──
  const dateIso = parseFlexibleDate(ocr.transaction_date);
  if (!dateIso) return reply(400, { ok: false, error: 'We could not read the date on your receipt. Make sure the date line is visible and try another photo.' });
  const timeIso = parseFlexibleTime(ocr.transaction_time) || '23:59';
  const receiptIso = dateIso + 'T' + timeIso + ':00';
  const receiptTs = new Date(receiptIso).getTime();
  if (isNaN(receiptTs)) return reply(400, { ok: false, error: 'Could not parse receipt date/time.' });
  // Normalize the date on the OCR object so downstream code uses the parsed value
  ocr.transaction_date = dateIso;
  const ageHours = (Date.now() - receiptTs) / 3600000;
  if (ageHours > SCAN_WINDOW_HOURS) {
    return reply(400, { ok: false, error: `This receipt is more than ${SCAN_WINDOW_HOURS} hours old — the scan window has expired.` });
  }
  if (ageHours < -2) return reply(400, { ok: false, error: 'Receipt date is in the future.' });

  // ── 4. Cross-validate with Toast ──
  const businessDate = ocr.transaction_date.replace(/-/g, '');
  let toastMatch;
  let toastDown = false;
  try { toastMatch = await findToastOrder(ocr.check_number, businessDate); }
  catch (e) { toastDown = true; toastMatch = null; }

  // ── 4a. If Toast doesn't have it yet, queue for retry ──
  if (!toastMatch) {
    // Check daily scan cap before queuing (so abusers can't fill the queue)
    const membersCheck = await loadJson('members.json');
    const member = (membersCheck.json.members || []).find((x) => (x.email || '').toLowerCase() === email);
    if (member) {
      const todayIso = new Date().toISOString().split('T')[0];
      const todayScans = (member.history || []).filter(
        (h) => h.action === 'earn' && /receipt-scan/.test(h.source) && h.at && h.at.startsWith(todayIso)
      ).length;
      // Also count pending items submitted today
      const pendingFile = await loadJson('pending-scans.json');
      const todayPending = ((pendingFile.json && pendingFile.json.items) || []).filter(
        (it) => it.memberEmail.toLowerCase() === email && it.status === 'pending' &&
                it.submittedAt && it.submittedAt.startsWith(todayIso)
      ).length;
      if (todayScans + todayPending >= MAX_SCANS_PER_DAY) {
        return reply(429, { ok: false, error: `You've reached today's limit of ${MAX_SCANS_PER_DAY} receipt scans. Try again tomorrow.` });
      }

      // Append to queue
      const pending = pendingFile.json || { items: [] };
      pending.items.push({
        id: 'p-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex'),
        memberEmail: member.email,
        memberName: member.name || '',
        checkNumber: ocr.check_number,
        businessDate,
        transactionAt: receiptIso,
        ocrSubtotal: ocr.subtotal_amount,
        ocrTax: ocr.tax_amount,
        ocrTip: ocr.tip_amount,
        ocrTotal: ocr.total_amount,
        ocrCardholder: ocr.cardholder_name,
        submittedAt: new Date().toISOString(),
        lastTriedAt: new Date().toISOString(),
        tryCount: 1,
        status: 'pending',
      });
      await saveJson('pending-scans.json', pending, pendingFile.sha,
        `queue scan: ${ocr.check_number} for ${member.email}`);
    }
    return reply(202, {
      ok: true,
      queued: true,
      message: toastDown
        ? "Toast is taking a moment to sync — we'll keep checking and credit your points shortly."
        : "We can't see your check in Toast yet — sometimes it takes a few minutes to sync. We'll keep checking and credit your points within a few hours.",
      checkNumber: ocr.check_number,
    });
  }

  const toastSubtotal = checkSubtotal(toastMatch.check);
  const toastPreTip = checkPreTipTotal(toastMatch.check);
  const toastTotal = checkTotal(toastMatch.check);

  const ocrSubtotal = (typeof ocr.subtotal_amount === 'number') ? ocr.subtotal_amount : null;
  if (ocrSubtotal != null && Math.abs(toastSubtotal - ocrSubtotal) > TOTAL_TOLERANCE) {
    return reply(400, { ok: false, error: 'Receipt subtotal does not match our records.' });
  }
  if (ocrSubtotal == null && Math.abs(toastTotal - ocr.total_amount) > TOTAL_TOLERANCE) {
    return reply(400, { ok: false, error: 'Receipt total does not match our records.' });
  }
  const toastOrderId = toastMatch.order.guid;
  const cardholder = extractCardholder(toastMatch.check);

  if (toastPreTip < MIN_TAB_USD) {
    return reply(400, { ok: false, error: `Pre-tip total under $${MIN_TAB_USD} — not eligible for points.` });
  }

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
    (h) => h.action === 'earn' && /receipt-scan/.test(h.source) && h.at && h.at.startsWith(todayIso)
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
      total: toastPreTip,
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

  // ── 9. Compute points (on PRE-TIP TOTAL) ──
  const tier = member.tier || 'standard';
  const mult = tierMult(tier);
  const earnBasis = toastPreTip;
  const basePts = Math.round(earnBasis * 10);
  const visitBonus = earnBasis >= MIN_TAB_USD ? 10 : 0;
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
    spendUsd: earnBasis,
    finalTotalUsd: toastTotal,
    subtotalUsd: toastSubtotal,
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
    subtotal: toastSubtotal,
    preTipTotal: earnBasis,
    finalTotal: toastTotal,
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
    spendUsd: earnBasis,
    finalTotal: toastTotal,
    subtotal: toastSubtotal,
    checkNumber: ocr.check_number,
    queueProcessed: pendingResult.credited > 0 ? pendingResult : undefined,
  });
};
