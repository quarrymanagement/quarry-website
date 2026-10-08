// ============================================================================
// receipt-review-digest.js
//
// Scheduled daily (see netlify.toml). Emails management@ one digest of customer
// receipts the system couldn't match to a POS ticket (3+ days old). Sends
// nothing when the queue is clear. Netlify blocks direct HTTP calls to
// scheduled functions, so to send on demand use receipt-review-admin
// (action: 'digest') with an owner token.
// ============================================================================
const { sendDigest } = require('./_receipt-review-shared');

exports.handler = async () => {
  try {
    const result = await sendDigest();
    console.log('receipt-review-digest:', JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (e) {
    console.error('receipt-review-digest failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e.message || e) }) };
  }
};
