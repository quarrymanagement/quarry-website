const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const https = require('https');

function sendEmail(to, subject, htmlBody) {
  const toArray = Array.isArray(to) ? to : [to];
  const payload = JSON.stringify({
    personalizations: [{ to: toArray.map(email => ({ email })) }],
    from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body });
        } else {
          reject(new Error('SendGrid error ' + res.statusCode + ': ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function githubRequest(method, path, token, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com', path, method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'Quarry-Forms',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function fetchBlobContent(repo, blobSha, token) {
  const res = await githubRequest('GET', '/repos/' + repo + '/git/blobs/' + blobSha, token);
  if (res.statusCode === 200 && res.data.content) {
    return Buffer.from(res.data.content, 'base64').toString('utf-8');
  }
  throw new Error('Could not fetch blob: ' + res.statusCode);
}

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { formId, submissionId, vendorEmail, vendorName, formName, amount } = JSON.parse(event.body);
    // amount is in dollars (default 150)
    const amountCents = Math.round((amount || 150) * 100);
    const amountDollars = (amountCents / 100).toFixed(2);

    if (!formId || !submissionId || !vendorEmail) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // 1. Create Stripe Checkout Session for vendor payment
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: vendorEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: 'Vendor Booth — ' + (formName || 'The Quarry Event'),
            description: 'Vendor spot reservation at The Quarry'
          }
        },
        quantity: 1
      }],
      metadata: {
        type: 'vendor_approval',
        formId: formId,
        submissionId: submissionId,
        vendorName: vendorName || '',
        vendorEmail: vendorEmail,
        formName: formName || ''
      },
      success_url: 'https://thequarrystl.com/quarry-events?vendor_payment=success',
      cancel_url: 'https://thequarrystl.com/quarry-events?vendor_payment=cancelled'
    });

    console.log('Stripe session created:', session.id, '— URL:', session.url);

    // Build vendor approval email HTML
    const vendorEmailHtml =
      '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center">' +
      '<h1 style="color:#B8933A;margin:0;font-size:28px">The Quarry</h1>' +
      '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
      '<div style="padding:32px 24px;background:#FFFFFF">' +
      '<h2 style="color:#2C1A0E;margin-top:0">You\'ve Been Accepted!</h2>' +
      '<p style="color:#444;line-height:1.7;">Hi ' + (vendorName || 'there') + ',</p>' +
      '<p style="color:#444;line-height:1.7;">Great news — your vendor application for <strong>' + (formName || 'our upcoming event') + '</strong> has been approved!</p>' +
      '<p style="color:#444;line-height:1.7;">Once your confirmation payment of <strong>$' + amountDollars + '</strong> is received, your spot will be officially reserved.</p>' +
      '<div style="text-align:center;margin:28px 0;">' +
      '<a href="' + session.url + '" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#B8933A,#d4af37);color:#1A0E08;text-decoration:none;font-weight:700;font-size:1rem;letter-spacing:0.05em;border-radius:8px;">Pay $' + amountDollars + ' to Reserve Your Spot</a>' +
      '</div>' +
      '<p style="color:#444;line-height:1.7;">We\'re extremely excited for this event and are happy that you get to be a part of it!</p>' +
      '<p style="color:#444;line-height:1.7;">We do recommend some type of giveaway at the event from our vendors — it\'s a great opportunity to generate leads from those who participate!</p>' +
      '<p style="color:#444;line-height:1.7;"><strong>Jacqueline</strong>, our wedding director, will be reaching out to you with more details.</p>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:24px 0;border-radius:4px">' +
      '<p style="margin:6px 0"><strong>Vendor Fee:</strong> $' + amountDollars + '</p>' +
      '<p style="margin:6px 0"><strong>Status:</strong> Approved — Pending Payment</p>' +
      '</div>' +
      '<p style="color:#444;">Questions? Contact Jacqueline at <a href="mailto:jacqueline@thequarrystl.com" style="color:#B8933A">jacqueline@thequarrystl.com</a> or call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a></p>' +
      '</div>' +
      '<div style="background:#1A0E08;padding:16px;text-align:center">' +
      '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">The Quarry &bull; 3960 Highway Z, New Melle, MO 63385</p></div></div>';

    // 2. Try to send approval email directly to vendor
    var vendorEmailSent = false;
    try {
      await sendEmail(vendorEmail, 'You\'re Approved! — ' + (formName || 'The Quarry Event'), vendorEmailHtml);
      vendorEmailSent = true;
      console.log('Approval email sent directly to', vendorEmail);
    } catch (e) {
      console.error('Could not send directly to vendor (SendGrid error):', e.message);
      // Will include payment link in management email so they can forward it
    }

    // 3. Notify management + Jacqueline (always send — include payment link so they can forward if vendor email failed)
    try {
      var mgmtNote = vendorEmailSent
        ? '<p style="color:#3cb464;margin-bottom:16px;">&#10003; Approval email with payment link was sent directly to the vendor.</p>'
        : '<p style="color:#dc2626;margin-bottom:16px;">&#9888; Could not send email directly to vendor (SendGrid error). Please forward this email or share the payment link below with the vendor.</p>';

      await sendEmail(
        ['management@thequarrystl.com', 'jacqueline@thequarrystl.com'],
        'Vendor Approved — ' + (vendorName || 'Unknown') + ' — ' + (formName || 'Event'),
        '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">' +
        '<div style="background:#1A0E08;padding:24px;text-align:center"><h1 style="color:#B8933A;margin:0">The Quarry</h1></div>' +
        '<div style="padding:32px 24px;background:#FFFFFF">' +
        '<h2 style="color:#2C1A0E;margin-top:0">Vendor Approved</h2>' +
        mgmtNote +
        '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0;border-radius:4px">' +
        '<p style="margin:6px 0"><strong>Vendor:</strong> ' + (vendorName || 'N/A') + '</p>' +
        '<p style="margin:6px 0"><strong>Email:</strong> ' + vendorEmail + '</p>' +
        '<p style="margin:6px 0"><strong>Form:</strong> ' + (formName || 'N/A') + '</p>' +
        '<p style="margin:6px 0"><strong>Amount:</strong> $' + amountDollars + '</p>' +
        '<p style="margin:6px 0"><strong>Status:</strong> Payment link sent — awaiting payment</p>' +
        '</div>' +
        '<div style="text-align:center;margin:24px 0;">' +
        '<a href="' + session.url + '" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#B8933A,#d4af37);color:#1A0E08;text-decoration:none;font-weight:700;font-size:0.9rem;border-radius:8px;">Vendor Payment Link ($' + amountDollars + ')</a>' +
        '</div>' +
        '<p style="color:#888;font-size:0.8rem;">Payment link: <a href="' + session.url + '" style="color:#B8933A;word-break:break-all;">' + session.url + '</a></p>' +
        '</div></div>'
      );
      console.log('Management notification sent');
    } catch (e) {
      console.error('Management email error:', e.message);
    }

    // 4. Update submission status in forms.json
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) {
      try {
        const repo = 'quarrymanagement/quarry-website';
        const metaRes = await githubRequest('GET', '/repos/' + repo + '/contents/forms.json', ghToken);
        if (metaRes.statusCode === 200 && metaRes.data.sha) {
          let formsData;
          try {
            formsData = JSON.parse(await fetchBlobContent(repo, metaRes.data.sha, ghToken));
          } catch (e) {
            if (metaRes.data.content) {
              formsData = JSON.parse(Buffer.from(metaRes.data.content, 'base64').toString('utf-8'));
            }
          }

          if (formsData && formsData.submissions && formsData.submissions[formId]) {
            var sub = formsData.submissions[formId].find(function(s) { return s.id === submissionId; });
            if (sub) {
              sub.status = 'approved';
              sub.paymentLink = session.url;
              sub.paymentSessionId = session.id;
              sub.approvedAt = new Date().toISOString();
            }

            const encoded = Buffer.from(JSON.stringify(formsData, null, 2), 'utf-8').toString('base64');
            await githubRequest('PUT', '/repos/' + repo + '/contents/forms.json', ghToken, {
              message: 'Vendor approved: ' + (vendorName || submissionId),
              content: encoded,
              sha: metaRes.data.sha
            });
          }
        }
      } catch (e) {
        console.error('GitHub update error:', e.message);
      }
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        success: true,
        checkoutUrl: session.url,
        vendorEmailSent: vendorEmailSent,
        message: vendorEmailSent
          ? 'Approval email sent with payment link'
          : 'Payment link created. Direct email to vendor failed (SendGrid error) — payment link included in management notification email.'
      })
    };

  } catch (err) {
    console.error('Approve vendor error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};
