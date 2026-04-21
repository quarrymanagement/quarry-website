const Stripe = require('stripe');
const https = require('https');

function sendGridEmail(to, subject, htmlBody, fromEmail, fromName) {
  fromEmail = fromEmail || 'management@thequarrystl.com';
  fromName = fromName || 'The Quarry STL';
  var toArray = Array.isArray(to) ? to : [to];
  var payload = JSON.stringify({
    personalizations: [{ to: toArray.map(function(email) { return { email: email }; }) }],
    from: { email: fromEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: htmlBody }],
  });

  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.SENDGRID_API_KEY,
        'Content-Type': 'application/json',
      },
    }, function(res) {
      var body = '';
      res.on('data', function(chunk) { body += chunk; });
      res.on('end', function() {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: body });
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

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  try {
    const { name, email, tasting, date, time } = JSON.parse(event.body || '{}');
    if (!name || !email || !tasting) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name, email, and tasting are required.' }) };
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    // Search for customers with this email
    const customers = await stripe.customers.list({ email: email.toLowerCase().trim(), limit: 5 });

    if (!customers.data.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: false, reason: 'no_account' }) };
    }

    // Check if any customer has an active Rock & Vine subscription
    let hasActive = false;
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 10
      });
      // Check if any active sub is for the Rock & Vine product
      for (const sub of subs.data) {
        for (const item of sub.items.data) {
          if (item.price.product === 'prod_UEVv768MwZGkyb') {
            hasActive = true; break;
          }
        }
        if (hasActive) break;
      }
      if (hasActive) break;
    }

    if (!hasActive) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: false, reason: 'no_subscription' }) };
    }

    // Member is verified — store RSVP and notify owner
    const token = process.env.NETLIFY_AUTH_TOKEN;
    const siteId = 'roaring-pegasus-444826';

    // Store RSVP in Netlify Blobs
    const rsvpKey = 'wine-rsvp-' + (date || tasting).replace(/\//g, '-').replace(/\s/g, '-');
    const url = 'https://api.netlify.com/api/v1/blobs/' + siteId + '/wine-rsvps/' + rsvpKey;
    let rsvps = [];
    try {
      const existing = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (existing.ok) { const d = await existing.json(); rsvps = d.rsvps || []; }
    } catch(e) {}

    // Check if already RSVP'd
    if (rsvps.some(r => r.email.toLowerCase() === email.toLowerCase())) {
      return { statusCode: 200, headers, body: JSON.stringify({ authorized: true, alreadyRsvp: true }) };
    }

    rsvps.push({ name, email, tasting, date, time, rsvpAt: new Date().toISOString() });
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rsvps })
    });

    // Notify owner via Netlify Forms
    const formBody = new URLSearchParams({
      'form-name': 'wine-rsvp-notification',
      'memberName': name,
      'memberEmail': email,
      'tasting': tasting,
      'date': date || '',
      'time': time || ''
    }).toString();

    await fetch('https://roaring-pegasus-444826.netlify.app/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody
    });

    // Send confirmation email to the member
    await sendMemberEmail({ name, email, tasting, date, time });

    // Send notification email to the owner
    await sendOwnerRsvpEmail({ name, email, tasting, date, time });

    console.log('RSVP confirmed:', name, email, tasting);
    return { statusCode: 200, headers, body: JSON.stringify({ authorized: true, confirmed: true }) };

  } catch (err) {
    console.error('RSVP error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error. Please try again.' }) };
  }
};

async function sendMemberEmail(data) {
  try {
    await sendGridEmail(
      data.email,
      'RSVP Confirmed — ' + data.tasting,
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center">' +
      '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
      '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
      '<div style="padding:32px 24px">' +
      '<h2 style="color:#2C1A0E">RSVP Confirmed!</h2>' +
      '<p>Hi ' + data.name + ', you\'re all set.</p>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
      '<p style="margin:4px 0"><b>Tasting:</b> ' + data.tasting + '</p>' +
      (data.date ? '<p style="margin:4px 0"><b>Date:</b> ' + data.date + '</p>' : '') +
      (data.time ? '<p style="margin:4px 0"><b>Time:</b> ' + data.time + '</p>' : '') +
      '</div>' +
      '<p>Questions? Call <a href="tel:6362248257" style="color:#B8933A">636-224-8257</a> or email ' +
      '<a href="mailto:management@thequarrystl.com" style="color:#B8933A">management@thequarrystl.com</a></p></div>' +
      '<div style="background:#1A0E08;padding:16px;text-align:center">' +
      '<p style="color:rgba(255,255,255,0.4);font-size:0.75rem;margin:0">3960 Highway Z, New Melle, MO 63385</p></div></div>',
      'wineclub@thequarrystl.com',
      'The Quarry STL'
    );
    console.log('Member RSVP email sent via SendGrid');
  } catch (e) {
    console.error('sendMemberEmail error:', e.message);
  }
}

async function sendOwnerRsvpEmail(data) {
  try {
    await sendGridEmail(
      'management@thequarrystl.com',
      'New Wine RSVP — ' + data.tasting + ' — ' + data.name,
      '<div style="font-family:Arial,sans-serif;max-width:600px">' +
      '<div style="background:#1A0E08;padding:24px;text-align:center">' +
      '<h1 style="color:#B8933A;margin:0">The Quarry</h1>' +
      '<p style="color:#F5F0E8;font-size:0.8rem;letter-spacing:0.15em;margin:4px 0 0">NEW MELLE, MISSOURI</p></div>' +
      '<div style="padding:32px 24px">' +
      '<h2 style="color:#2C1A0E">New Wine Club RSVP</h2>' +
      '<div style="background:#FAF7F2;border-left:4px solid #B8933A;padding:16px 20px;margin:20px 0">' +
      '<p style="margin:4px 0"><b>Member:</b> ' + data.name + '</p>' +
      '<p style="margin:4px 0"><b>Email:</b> ' + data.email + '</p>' +
      '<p style="margin:4px 0"><b>Tasting:</b> ' + data.tasting + '</p>' +
      (data.date ? '<p style="margin:4px 0"><b>Date:</b> ' + data.date + '</p>' : '') +
      (data.time ? '<p style="margin:4px 0"><b>Time:</b> ' + data.time + '</p>' : '') +
      '</div></div></div>',
      'wineclub@thequarrystl.com',
      'The Quarry STL'
    );
    console.log('Owner RSVP email sent via SendGrid');
  } catch (e) {
    console.error('sendOwnerRsvpEmail error:', e.message);
  }
}