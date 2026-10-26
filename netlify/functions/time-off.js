// ============================================================================
// time-off.js — time-off requests for the employee portal (/employee/).
//   action 'request'          employee token; employee id taken from the token
//   action 'approve' | 'deny' OWNER admin token
// Stored in private Netlify Blobs (_schedule-store.js), not GitHub.
// ============================================================================
const crypto = require('crypto');
const { readSchedule, writeSchedule, verifyEmployeeToken, employeeTokenFrom } = require('./_schedule-store');
const { isAuthorized } = require('./_admin-auth');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
};
const response = (statusCode, body) => ({ statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

const handleRequest = async (event, body) => {
  const employeeId = verifyEmployeeToken(employeeTokenFrom(event, body));
  if (!employeeId) return response(401, { error: 'Please sign in again' });
  const { dates, reason } = body;
  if (!Array.isArray(dates) || dates.length === 0 || dates.length > 31) {
    return response(400, { error: 'dates array and reason required' });
  }
  const doc = await readSchedule();
  if (!doc.employees.some((e) => e.id === employeeId)) return response(401, { error: 'Please sign in again' });
  const requestId = `timeoff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  doc.timeOffRequests.push({
    id: requestId, employeeId, dates: dates.map(String), reason: String(reason || '').slice(0, 500),
    status: 'pending', requestedAt: new Date().toISOString(),
  });
  await writeSchedule(doc);
  return response(200, { success: true, message: 'Time-off request submitted', requestId });
};

const handleDecision = async (event, body, status) => {
  if (!isAuthorized(event, body, [])) return response(401, { error: 'Admin session required' });
  const { requestId, reason } = body;
  if (!requestId) return response(400, { error: 'requestId required' });
  const doc = await readSchedule();
  const request = doc.timeOffRequests.find((r) => r.id === requestId);
  if (!request) return response(404, { error: 'Request not found' });
  request.status = status;
  if (status === 'approved') request.approvedAt = new Date().toISOString();
  else { request.denialReason = reason || ''; request.deniedAt = new Date().toISOString(); }
  await writeSchedule(doc);
  return response(200, { success: true, message: `Time-off request ${status}` });
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { message: 'OK' });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    switch (body.action) {
      case 'request': return await handleRequest(event, body);
      case 'approve': return await handleDecision(event, body, 'approved');
      case 'deny': return await handleDecision(event, body, 'denied');
      default: return response(400, { error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Time-off error:', err && err.message);
    return response(err && err.status === 503 ? 503 : 500, { error: 'Internal server error' });
  }
};
