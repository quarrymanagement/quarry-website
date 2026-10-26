// ============================================================================
// staff-schedule.js — the one read path for the staff schedule.
//
// GET /.netlify/functions/staff-schedule
//   Authorization: Bearer <employee token>  -> that employee's own shifts and
//                                              time-off only (employee-auth.js
//                                              issues the token)
//   x-admin-token: <OWNER admin token>       -> full doc for the admin panel
//                                              (names/emails/phones, never
//                                              password hashes; adds hasPassword)
//   anything else                            -> 401
// Data lives in private Netlify Blobs (_schedule-store.js), not GitHub.
// ============================================================================
const { readSchedule, readCredentials, verifyEmployeeToken, employeeTokenFrom, employeeView } = require('./_schedule-store');
const { isAuthorized } = require('./_admin-auth');

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
};
const out = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return out(405, { error: 'Method not allowed' });
  try {
    if (isAuthorized(event, null, [])) {
      const doc = await readSchedule();
      const creds = await readCredentials();
      doc.employees = doc.employees.map((e) => ({ ...e, hasPassword: !!(creds[e.id] && creds[e.id].hash) }));
      return out(200, doc);
    }
    const empId = verifyEmployeeToken(employeeTokenFrom(event, null));
    if (!empId) return out(401, { error: 'Please sign in' });
    const view = employeeView(await readSchedule(), empId);
    if (!view) return out(401, { error: 'Please sign in' });
    return out(200, view);
  } catch (e) {
    console.error('staff-schedule:', e && e.message);
    return out(e && e.status === 503 ? 503 : 502, { error: 'Schedule unavailable' });
  }
};
