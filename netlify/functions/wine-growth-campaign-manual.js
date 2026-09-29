// ============================================================================
// wine-growth-campaign-manual.js
//
// Identical logic to wine-growth-campaign.js, deployed as a second,
// UN-scheduled function on purpose: Netlify blocks direct public requests to
// any function registered with a `schedule` in netlify.toml (403), so the
// cron-driven one can'''t be hit by URL for manual testing or on-demand
// sends. This twin has no schedule entry, so it stays callable any time via
// dry_run=1 / test=1 / force=<milestone> -- exactly the on-demand control
// staff wanted ("today" for this cycle, "whenever" for the next), with the
// scheduled twin as the automatic daily backstop if nobody triggers it by
// hand. Keep both files in sync if the send logic changes.
//
// Runs the 3-email Rock & Vine growth cadence off the real tasting schedule
// in wine_tastings.json, instead of any hardcoded winery/date:
//
//   - "invite"    -- ~3 weeks (21 days) before the tasting
//   - "lastcall"  -- the Monday of tasting week
//   - "thankyou"  -- the day after the tasting
//
// Audience:
//   invite / lastcall -> every Subscribed contact in subscribers.json who is
//                         NOT a current Active Wine Club member (blob
//                         "wine-club-members") -- this is what keeps someone
//                         who joins mid-campaign from still getting "join us"
//                         pitches; the moment they're in that roster, this
//                         exclusion drops them out on the very next send.
//   thankyou           -> the full Subscribed list, members included -- it's
//                         a recap/thank-you, not a pitch, so nobody needs to
//                         be excluded from it.
//
// Idempotent per (tasting id, milestone) via the "wine-growth-sent-log" blob,
// same pattern as wedding_tour_reminders_sent -- safe to run more than once
// on the same day.
//
// Cron: once daily. See netlify.toml.
// GET ?dry_run=1 -- reports what WOULD send today without sending or logging.
// ============================================================================

const https = require('https');
const { readBlob, writeBlob } = require('./_blobs');

const REPO_RAW = 'https://raw.githubusercontent.com/quarrymanagement/quarry-website/main';
const SENT_LOG_BLOB = 'wine-growth-sent-log';
const TZ = 'America/Chicago';
const LOGO_URL = 'https://thequarrystl.com/assets/quarry-q-logo.png';

function todayCT() {
  const now = new Date();
  return now.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}
function addDays(yyyymmdd, n) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
// Monday of the same calendar week as the given date (weeks run Mon-Sun).
function mondayOfWeek(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(yyyymmdd, -back);
}
function fmtLongDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}
function fmtTime(hhmm) {
  const [h, m] = (hhmm || '18:00').split(':').map(Number);
  const dt = new Date(Date.UTC(2000, 0, 1, h, m));
  return dt.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: m ? '2-digit' : undefined }).replace(':00', '');
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else reject(new Error('fetch ' + url + ' -> ' + res.statusCode));
      });
    }).on('error', reject);
  });
}

function sendGridBulk(personalizations, subject, htmlBody) {
  const payload = JSON.stringify({
    personalizations,
    from: { email: 'management@thequarrystl.com', name: 'The Quarry STL' },
    subject,
    content: [{ type: 'text/html', value: htmlBody }],
    categories: ['quarry-wine-growth-campaign'],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ statusCode: res.statusCode });
        else reject(new Error('SendGrid ' + res.statusCode + ': ' + body.slice(0, 300)));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function sendBulkEmail(recipients, subject, htmlBody) {
  const BATCH_SIZE = 900;
  let sent = 0, failed = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);
    const personalizations = chunk.map((r) => ({
      to: [{ email: r.email }],
      substitutions: { '{firstName}': r.firstName || '' },
    }));
    try {
      await sendGridBulk(personalizations, subject, htmlBody);
      sent += chunk.length;
    } catch (e) {
      console.error('wine-growth-campaign batch failed:', e.message);
      failed += chunk.length;
    }
  }
  return { sent, failed };
}

function heroHtml() {
  return `<div style="background:#1A0E08;padding:28px 20px;text-align:center;margin:0 0 22px;border-radius:6px;">
<img src="${LOGO_URL}" alt="The Quarry" style="width:56px;height:56px;display:block;margin:0 auto 10px;">
<div style="font-family:Georgia,serif;color:#D4AF6A;font-size:22px;letter-spacing:2px;">THE QUARRY</div>
<div style="font-family:Georgia,serif;color:#F5F0E8;font-size:10px;letter-spacing:3px;text-transform:uppercase;opacity:0.8;margin-top:2px;">New Melle, Missouri</div>
</div>`;
}
function wrap(inner) {
  return `<div style="max-width:600px;margin:0 auto;">${heroHtml()}${inner}</div>`;
}
const P = 'font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#2C1A0E;';
const H2 = 'font-family:Georgia,serif;color:#2C1A0E;margin:0 0 14px;';
const BTN_GOLD = 'display:inline-block;background:#B8933A;color:#1A0E08;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:Georgia,serif;';
const BTN_OUTLINE = 'display:inline-block;background:transparent;border:2px solid #B8933A;color:#9A6B2E;padding:11px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:Georgia,serif;';

function inviteEmail(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  const subject = 'Fall + Wine Deserve Each Other';
  const html = wrap(`
<h2 style="${H2}">There's no better time to join Rock &amp; Vine than right now.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Fall at The Quarry means cozy nights, great company, and honestly &mdash; the best wine lineup we run all year. If you've ever thought about joining the Rock &amp; Vine Wine Club, this is the season to do it.</p>
<div style="background:#FAF3E7;border-left:4px solid #B8933A;padding:16px 20px;margin:18px 0;font-family:Georgia,serif;font-size:15px;color:#2C1A0E;">
<p style="margin:0 0 10px;line-height:1.6;"><strong>For a discounted $29.99/month, you get:</strong></p>
<p style="margin:0;line-height:1.9;">🍇 Priority RSVP to every tasting, before they open to the public<br>
🥂 A discount on wine purchases, every visit<br>
🍷 A curated wine selection you won't find elsewhere<br>
👥 One guest included at every tasting, on us<br>
🏡 A community of regulars who show up for the same reason you do &mdash; good wine, good people</p>
</div>
<p style="text-align:center;margin:22px 0;"><a href="https://thequarrystl.com/quarry-wineclub#member-form" style="${BTN_GOLD}">Join Rock &amp; Vine &mdash; $29.99/mo →</a></p>
<p style="${P}">Not ready to commit? No pressure &mdash; come try it first. Our next tasting features <strong>${t.winery}, ${dateStr} at ${timeStr}</strong>. One $44.99 admission covers you and a guest &mdash; wine tasting, food pairings, and bottles available to buy at the end of the night.</p>
<p style="text-align:center;margin:18px 0;"><a href="${t.ticketUrl}" style="${BTN_OUTLINE}">Grab a Ticket for Two &mdash; $44.99 →</a></p>
<p style="${P}">Cheers to the season,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function lastCallEmail(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  const subject = `Last Call: ${t.winery} This Week`;
  const html = wrap(`
<h2 style="${H2}">This week's the week.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Just a heads-up &mdash; ${t.winery} is ${dateStr} at ${timeStr}, and seats are going fast. If fall wine nights have been on your mind, this is your sign.</p>
<div style="background:#FAF3E7;border-left:4px solid #B8933A;padding:16px 20px;margin:18px 0;font-family:Georgia,serif;font-size:15px;color:#2C1A0E;">
<p style="margin:0 0 10px;line-height:1.6;"><strong>Join Rock &amp; Vine, or just trying us out?</strong> Either way, we'd love to see you.</p>
<p style="margin:0;line-height:1.7;">🍇 <strong>Join now &mdash; $29.99/mo:</strong> priority seating, a wine discount, and a guest included every month.<br>
🎟️ <strong>Just trying us out &mdash; $44.99:</strong> covers you and a guest for this tasting only.</p>
</div>
<p style="text-align:center;margin:24px 0 14px;"><a href="https://thequarrystl.com/quarry-wineclub#member-form" style="${BTN_GOLD}">Join Rock &amp; Vine &mdash; $29.99/mo →</a></p>
<p style="text-align:center;margin:0 0 14px;font-family:Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9A8B7A;">or</p>
<p style="text-align:center;margin:0 0 24px;"><a href="${t.ticketUrl}" style="${BTN_OUTLINE}">Just Trying Us Out &mdash; $44.99 →</a></p>
<p style="${P}">See you soon,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function thankYouEmail(t) {
  const subject = 'Another Successful Night at The Quarry';
  const html = wrap(`
<h2 style="${H2}">What a night.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Last night's tasting was another great one in the books &mdash; thank you to everyone who came out, and a huge thank you to <strong>${t.winery}</strong> for putting on such a great night of wine.</p>
<p style="${P}">If you were there, we hope you had as much fun as we did. And if you missed this one, don't worry &mdash; there's always next month.</p>
<p style="text-align:center;margin:22px 0;"><a href="https://thequarrystl.com/quarry-wineclub#member-form" style="${BTN_GOLD}">Join Rock &amp; Vine &mdash; $29.99/mo →</a></p>
<p style="${P}">Members get priority seating, a discount on wine, and a guest included at every tasting &mdash; so you're never on the outside looking in again.</p>
<p style="${P}">Cheers,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

async function readSentLog() {
  const data = await readBlob(SENT_LOG_BLOB);
  if (!data || !Array.isArray(data.sent)) return { sent: [] };
  return data;
}
async function markSent(log, key) {
  log.sent.push({ key, at: new Date().toISOString() });
  await writeBlob(SENT_LOG_BLOB, log);
}

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl || ('https://x' + event.path + '?' + (event.rawQuery || '')));
    const dryRun = url.searchParams.get('dry_run') === '1';

    const [tastingsData, subscribers, wineClub, log] = await Promise.all([
      fetchJson(REPO_RAW + '/wine_tastings.json?t=' + Date.now()),
      fetchJson(REPO_RAW + '/subscribers.json?t=' + Date.now()),
      readBlob('wine-club-members'),
      readSentLog(),
    ]);

    const today = todayCT();
    const allTastings = tastingsData.tastings || [];
    if (allTastings.length === 0) {
      return json({ ok: true, message: 'no tastings in wine_tastings.json', today });
    }

    // Compute every tasting's 3 milestone dates. Deliberately NOT filtered to
    // "date >= today" here -- thank-you fires the day AFTER the tasting, so
    // by the time that milestone is due, the tasting's own date has already
    // passed. Filtering it out here would mean thank-you could never fire.
    // This also lets several tastings be queued up in advance: each one's
    // milestones are checked independently every day, so nothing needs the
    // others to finish first.
    const withMilestones = allTastings.map((t) => ({
      t,
      milestones: {
        invite: addDays(t.date, -21),
        lastcall: mondayOfWeek(t.date),
        thankyou: addDays(t.date, 1),
      },
    }));

    const force = url.searchParams.get('force'); // 'invite' | 'lastcall' | 'thankyou' -- manual override, applies to the single soonest upcoming tasting. Idempotency below still applies.
    const testMode = url.searchParams.get('test') === '1';

    let dueList;
    if (force) {
      const upcoming = withMilestones
        .filter((x) => x.t.date >= today)
        .sort((a, b) => a.t.date.localeCompare(b.t.date));
      if (upcoming.length === 0) return json({ ok: true, message: 'no upcoming tasting to force', today });
      dueList = [{ t: upcoming[0].t, milestone: force }];
    } else {
      dueList = [];
      for (const x of withMilestones) {
        for (const [name, date] of Object.entries(x.milestones)) {
          if (date === today) dueList.push({ t: x.t, milestone: name });
        }
      }
    }

    if (dueList.length === 0) {
      return json({ ok: true, message: 'nothing due today', today, milestonesByTasting: withMilestones.map((x) => ({ id: x.t.id, ...x.milestones })) });
    }

    const activeMemberEmails = new Set(
      ((wineClub && wineClub.members) || [])
        .filter((m) => (m.status || '').toLowerCase() === 'active')
        .map((m) => (m.email || '').toLowerCase())
    );
    const subscribedContacts = (subscribers || [])
      .filter((s) => s.email && s.emailStatus === 'Subscribed')
      .map((s) => ({ email: s.email, firstName: s.firstName || '' }));

    const results = [];
    for (const { t, milestone } of dueList) {
      const sentKey = t.id + ':' + milestone;
      if (!testMode && log.sent.some((s) => s.key === sentKey)) {
        results.push({ tasting: t.id, milestone, skipped: 'already sent' });
        continue;
      }

      let recipients, builder;
      if (milestone === 'invite') { builder = inviteEmail; recipients = subscribedContacts.filter((r) => !activeMemberEmails.has(r.email.toLowerCase())); }
      else if (milestone === 'lastcall') { builder = lastCallEmail; recipients = subscribedContacts.filter((r) => !activeMemberEmails.has(r.email.toLowerCase())); }
      else { builder = thankYouEmail; recipients = subscribedContacts; }

      const { subject, html } = builder(t);

      if (dryRun) {
        results.push({ tasting: t.id, milestone, dryRun: true, recipientCount: recipients.length, subject });
        continue;
      }

      // ?test=1 -- exercises the REAL SendGrid call end-to-end, but only to
      // management@thequarrystl.com, and does NOT mark the milestone as
      // sent (so the real campaign send afterward still goes out normally).
      if (testMode) {
        const result = await sendBulkEmail([{ email: 'management@thequarrystl.com', firstName: 'Matthew' }], '[TEST] ' + subject, html);
        results.push({ tasting: t.id, milestone, testMode: true, subject, ...result });
        continue;
      }

      const result = await sendBulkEmail(recipients, subject, html);
      await markSent(log, sentKey);
      results.push({ tasting: t.id, milestone, recipientCount: recipients.length, ...result });
    }

    return json({ ok: true, today, results });
  } catch (e) {
    console.error('wine-growth-campaign error:', e);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 2) };
}
