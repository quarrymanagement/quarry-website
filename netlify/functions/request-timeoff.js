// ============================================================================
// request-timeoff.js — staff time-off request from schedule.html.
// Needs an employee token (employee-auth.js); the employee id comes from the
// token, never from the request body. Stored in private Netlify Blobs.
// ============================================================================
const { readSchedule, writeSchedule, verifyEmployeeToken, employeeTokenFrom } = require('./_schedule-store');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const response = (statusCode, body) => ({ statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { message: 'OK' });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const employeeId = verifyEmployeeToken(employeeTokenFrom(event, body));
    if (!employeeId) return response(401, { error: 'Please sign in again' });
    const { dates, reason } = body;
    if (!Array.isArray(dates) || !dates.length || dates.length > 31 || !reason) {
      return response(400, { error: 'Missing required fields: dates, reason' });
    }
    const doc = await readSchedule();
    if (!doc.employees.some((e) => e.id === employeeId)) return response(401, { error: 'Please sign in again' });
    const newRequest = {
      id: 'to-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6),
      employeeId,
      dates: dates.map(String).slice(0, 31),
      reason: String(reason).slice(0, 500),
      status: 'pending',
      requestedAt: new Date().toISOString(),
    };
    doc.timeOffRequests.push(newRequest);
    await writeSchedule(doc);
    return response(200, { success: true, message: 'Time-off request submitted successfully', request: newRequest });
  } catch (err) {
    console.error('Request timeoff error:', err && err.message);
    return response(err && err.status === 503 ? 503 : 500, { error: 'Internal server error' });
  }
};
