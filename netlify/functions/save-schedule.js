// ============================================================================
// save-schedule.js — admin panel save for the staff schedule (OWNER only).
// Writes private Netlify Blobs (_schedule-store.js), not schedule.json on
// GitHub. MERGES: any field the client leaves out keeps its stored value
// (the April-21 data-loss fix). Password hashes are never accepted from the
// browser; they live in a separate credentials key.
// ============================================================================
const { readSchedule, writeSchedule } = require('./_schedule-store');
const { isAuthorized } = require('./_admin-auth');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
};
const response = (statusCode, body) => ({ statusCode, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { message: 'OK' });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return response(400, { error: 'Bad JSON' }); }
  if (!isAuthorized(event, body, [])) return response(401, { error: 'Admin session required' });
  try {
    const existing = await readSchedule();
    const strip = (emps) => emps.map((e) => { const c = { ...e }; delete c.passwordHash; delete c.hasPassword; return c; });
    const merged = {
      employees: Array.isArray(body.employees) ? strip(body.employees) : existing.employees,
      schedules: (body.schedules && typeof body.schedules === 'object') ? body.schedules : existing.schedules,
      timeOffRequests: existing.timeOffRequests,
    };
    if (Array.isArray(body.timeOffRequests)) {
      // Keep any request an employee filed after the admin panel loaded.
      const sent = new Set(body.timeOffRequests.map((r) => r && r.id));
      merged.timeOffRequests = body.timeOffRequests.concat(existing.timeOffRequests.filter((r) => !sent.has(r.id)));
    }
    // Guard against the April-21 failure mode: a save that would wipe staff.
    if (existing.employees.length >= 5 && merged.employees.length === 0) {
      return response(409, { error: 'Refusing to save an empty employee list' });
    }
    await writeSchedule(merged);
    return response(200, { success: true, message: 'Schedule saved' });
  } catch (err) {
    console.error('Save schedule error:', err && err.message);
    return response(err && err.status === 503 ? 503 : 500, { error: 'Save failed' });
  }
};
