// ============================================================================
// create-checkout.js  -  RETIRED (old Stripe golf checkout)
//
// Golf bay checkout moved to Square (square-checkout.js). No page on the site
// calls this endpoint any more. The old version still accepted a hardcoded
// public 100%-off coupon and wrote $0 "comp" bookings, so it is disabled.
// Full prior source is in git history if it is ever needed again.
// ============================================================================
exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'This checkout is no longer available. Please book at https://thequarrystl.com/quarry-golf.html' })
});
