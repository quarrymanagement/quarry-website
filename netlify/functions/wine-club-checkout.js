// Rock & Vine Wine Club — online checkout hand-off (PLACEHOLDER until Square is set up).
//
// This function makes NO Square API calls. It only redirects to a checkout URL
// that someone creates by hand in the Square Dashboard:
//   Square Dashboard -> Subscriptions -> Rock & Vine plan -> Share / Checkout link
// and saves as the Netlify env var WINE_CLUB_CHECKOUT_URL.
//
// Until that env var is set, it shows a "coming soon" page and the member's
// profile (already submitted via the wine-club-registration form) is enrolled in
// person, exactly like today. Once Square subscriptions fire, square-webhook.js
// already writes the member into the wine-club-members blob.

const ALLOWED = /^https:\/\/(square\.link|checkout\.square\.site|[a-z0-9-]+\.square\.site)\//i;

exports.handler = async () => {
  const url = process.env.WINE_CLUB_CHECKOUT_URL || '';
  if (ALLOWED.test(url)) {
    return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' };
  }
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>Rock &amp; Vine Checkout | The Quarry</title></head>' +
    '<body style="margin:0;font-family:Arial,sans-serif;background:#FAF7F2;color:#2C1A0E">' +
    '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">Rock &amp; Vine Wine Club</h1></div>' +
    '<div style="max-width:560px;margin:40px auto;padding:0 20px;text-align:center">' +
    '<h2>Online checkout is coming soon</h2>' +
    '<p>Thanks for your interest! Secure online sign-up is being set up. If you already submitted your member profile, we have it, and we\'ll finish your enrollment on your next visit or reach out to you.</p>' +
    '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email <a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a>.</p>' +
    '<p><a href="/quarry-wineclub.html" style="color:#B8933A">&larr; Back to Rock &amp; Vine</a></p></div></body></html>';
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: html };
};
