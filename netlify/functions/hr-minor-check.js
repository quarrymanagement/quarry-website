/* =========================================================================
   HR docs: daily "minor turns 18" check (The Quarry only)
   Asks the hr-docs edge function to log every minor whose turns-18 month
   has arrived (one hr_audit row per person per month, actor "system").
   The admin view (Personnel Docs) always shows the live list; this run only
   leaves a dated record. It sends no email and changes no employee record:
   an HR admin unticks Minor by hand.

   Scheduled from netlify.toml. Does nothing until HR_CRON_KEY is set here
   AND as the hr-docs edge-function secret (same value, 32+ characters).
   Env used: HR_CRON_KEY, SUPABASE_ANON_KEY
   ========================================================================== */
const SB = "https://nkulhtalltbieicvmmad.supabase.co";

exports.handler = async () => {
  const key = process.env.HR_CRON_KEY || "";
  if (key.length < 32) return { statusCode: 200, body: JSON.stringify({ skipped: "HR_CRON_KEY not set" }) };
  const anon = process.env.SUPABASE_ANON_KEY || "";
  const res = await fetch(`${SB}/functions/v1/hr-docs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hr-cron-key": key,
      ...(anon ? { apikey: anon, authorization: `Bearer ${anon}` } : {}),
    },
    body: JSON.stringify({ action: "cron_minor_check" }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) console.error("hr-minor-check failed", res.status, out && out.error);
  // counts only; never names or dates
  return { statusCode: res.ok ? 200 : 502, body: JSON.stringify({ due: out.due, flagged: out.flagged }) };
};
