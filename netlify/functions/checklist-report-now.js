/* =========================================================================
   Manual trigger for the nightly checklist report.
   Netlify refuses HTTP calls to scheduled functions, so this un-scheduled
   twin exists purely so a manager can fire or re-send a report on demand:

     /.netlify/functions/checklist-report-now?key=<VENUE_AVAILABILITY_KEY>
     ...&date=2026-09-11      (optional — defaults to today, Chicago)

   All the logic lives in checklist-nightly-report.js; this only guards the
   key and hands off, so the two can never drift apart.
   ========================================================================== */
const report = require("./checklist-nightly-report");

exports.handler = async (event) => {
  const key = event && event.queryStringParameters && event.queryStringParameters.key;
  if (!key || key !== process.env.VENUE_AVAILABILITY_KEY) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "unauthorized" }) };
  }
  return report.handler(event);
};
