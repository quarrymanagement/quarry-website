// ============================================================================
// wine-growth-campaign.js
//
// Runs three parallel, per-tasting email cadences off the real schedule in
// wine_tastings.json -- no hardcoded winery/date anywhere:
//
//   GUEST GROWTH (non-members, non-ticket-buyers -- the "join us" pitch)
//     - "invite"    -- ~3 weeks (21 days) before the tasting
//     - "lastcall"  -- the Monday of tasting week
//     - "thankyou"  -- the day after the tasting
//
//   TICKET BUYER (people who already bought a $44.99 one-off ticket for THIS
//   tasting -- pulled from that ticketed event's registrant list, no separate
//   data store needed)
//     - "ticket_monday"    -- the Monday of tasting week (logistics only,
//                              replaces "lastcall" for this audience)
//     - "ticket_dayafter"  -- the day after the tasting (the membership
//                              conversion ask, replaces "thankyou")
//
//   MEMBER CADENCE (active Wine Club members -- encourages bringing/sharing
//   their included guest, never a sales pitch at the member themselves)
//     - "member_dayafter" -- day after THIS tasting, thanks it + teases next
//                             (only fires once a next tasting exists)
//     - "member_halfway"  -- midpoint between this tasting and the next one
//                             (only fires once a next tasting exists)
//     - "member_monday"   -- the Monday of tasting week
//     - "member_dayof"    -- the morning of the tasting
//
// Audience exclusions (all re-checked fresh at send time, so someone who
// joins mid-campaign or buys a ticket immediately drops out of the wrong
// track on the very next run):
//   invite / lastcall / thankyou -> excludes active Wine Club members AND
//                                    this tasting's ticket buyers (those two
//                                    groups get their own dedicated tracks
//                                    instead of the generic guest pitch).
//   ticket_monday / ticket_dayafter -> this tasting's ticket buyers, minus
//                                        anyone who has since become an
//                                        active member.
//   member_* -> active Wine Club members only.
//
// Idempotent per (tasting id, milestone) via the "wine-growth-sent-log" blob.
// Cron: once daily. See netlify.toml.
// GET ?dry_run=1 -- reports what WOULD send today without sending or logging.
// GET ?force=<milestone>&test=1 -- builds+sends one milestone for the
//   soonest qualifying upcoming tasting, to management@thequarrystl.com only,
//   without marking it sent. Milestones: invite, lastcall, thankyou,
//   ticket_monday, ticket_dayafter, member_monday, member_dayof,
//   member_dayafter, member_halfway.
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
function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function midpoint(a, b) {
  return addDays(a, Math.round(daysBetween(a, b) / 2));
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

// ---------------------------------------------------------------------------
// GitHub read/write -- same GITHUB_TOKEN + Contents API pattern already used
// by save-github-file.js, used here so the automation can commit a new
// ticketed event page itself instead of needing one hand-built per tasting.
// ---------------------------------------------------------------------------
const REPO = 'quarrymanagement/quarry-website';

function githubRequest(method, path, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return Promise.reject(new Error('GITHUB_TOKEN not configured'));
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'Quarry-Wine-Growth-Automation',
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function githubGetFile(path) {
  const res = await githubRequest('GET', `/repos/${REPO}/contents/${path}`);
  if (res.status !== 200) throw new Error(`GitHub GET ${path} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  const content = Buffer.from(res.data.content, 'base64').toString('utf-8');
  return { content: JSON.parse(content), sha: res.data.sha };
}

async function githubPutFile(path, dataObj, sha, message) {
  const encoded = Buffer.from(JSON.stringify(dataObj, null, 2), 'utf-8').toString('base64');
  const res = await githubRequest('PUT', `/repos/${REPO}/contents/${path}`, { message, content: encoded, sha });
  if (res.status !== 200 && res.status !== 201) throw new Error(`GitHub PUT ${path} -> ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  return res.data;
}

// Builds the same shape of ticketed event used for the Oct 15 Trademark
// Winery tasting -- $44.99 admission-for-two, no flyer image (so nothing
// needs to be created by hand per cycle), 15 admissions / 30 people.
function buildTicketedEvent(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  return {
    id: t.id + '-ticket',
    name: 'Rock & Vine Wine Club - ' + t.winery,
    date: t.date,
    time: t.time,
    location: 'The Quarry, New Melle MO',
    description: `Rock & Vine Wine Club presents ${t.winery}. $44.99 admission covers two people -- a guided wine tasting, food pairings, and bottles available to purchase at the end of the night.`,
    detailDescription: `Rock & Vine Wine Club at The Quarry\n\nFeatured Winery: ${t.winery}\n\n${dateStr}\n${timeStr}\n$44.99 per admission\nThe Quarry, 3960 Highway Z, New Melle, MO\n\nJoin us for an evening with ${t.winery} -- five to six wines, a food pairing with each, and bottles available to buy at the end of the night.\n\nEach $44.99 admission includes:\n\nWine tasting for 2 people\nFood pairings with each tasting\nA guided tasting experience overlooking The Quarry\n\nBring a partner, a friend, or a date -- your admission covers both of you. Reserve your spot below; we'll have your names on the list at the door.\n\nLimited to 15 admissions (30 people).\n\nAlready a Rock & Vine member? Your $29.99/mo membership already includes priority RSVP and a guest at every tasting -- RSVP through the member portal instead of buying a ticket here.`,
    additionalInfo: 'Limited to 15 admissions (30 people). One ticket = two people. Please enter your partner / +1 name when registering.',
    capacity: 15,
    totalCapacity: 15,
    status: 'available',
    pricingType: 'individual',
    collectGuestName: true,
    registeredCount: 0,
    registered: 0,
    eventType: 'ticketed',
    registrationType: 'paid',
    category: 'Ticketed',
    tags: ['Ticketed', 'Wine Tasting', 'Wine Club'],
    imageGradient: 'wine',
    imageText: 'Wine',
    imageAlt: t.winery + ' Wine Tasting at The Quarry, ' + dateStr,
    title: t.winery + ' Wine Tasting',
    pricePerPerson: 4499,
    tiers: [{ name: 'Admission for Two', pricePerPerson: 4499, priceLabel: '$44.99', priceUnit: '', description: 'One $44.99 ticket - includes wine tasting + food pairings for two people.' }],
    seatingOptions: [],
    arrivalSlots: [],
    highlights: [
      'Featured: ' + t.winery,
      'Wine tasting for two - $44.99 admission',
      'Food pairings with each wine',
      'Guided experience overlooking The Quarry',
      'Members: priority RSVP + 1 guest included, no extra charge',
    ],
    slug: t.id + '-ticket',
  };
}

// Creates a dedicated ticketed event (and points the tasting's ticketUrl at
// it) for any upcoming tasting that doesn't have one yet. Runs on every
// invocation, independent of whether any email milestone is due today, so a
// tasting gets its checkout page as soon as it's added to the schedule
// rather than waiting until its invite is about to fire.
async function ensureTicketEvents(tastingsData, today) {
  const needsOne = tastingsData.tastings.filter((t) => !t.eventId && t.date >= today);
  if (needsOne.length === 0) return { created: [] };

  const created = [];
  let eventsFile = await githubGetFile('events.json');
  let tastingsFile = await githubGetFile('wine_tastings.json');

  for (const t of needsOne) {
    const newEvent = buildTicketedEvent(t);
    if (eventsFile.content.events.some((e) => e.id === newEvent.id)) continue; // already exists, just wasn't linked back yet
    eventsFile.content.events.push(newEvent);
    const match = tastingsFile.content.tastings.find((x) => x.id === t.id);
    if (match) {
      match.eventId = newEvent.id;
      match.ticketUrl = 'https://thequarrystl.com/quarry-event-detail.html?id=' + newEvent.id;
    }
    created.push({ tastingId: t.id, eventId: newEvent.id });
  }

  if (created.length > 0) {
    await githubPutFile('events.json', eventsFile.content, eventsFile.sha,
      'Auto-create ticketed event(s) for upcoming wine tasting(s)\n\n' + created.map((c) => c.tastingId + ' -> ' + c.eventId).join('\n') + '\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
    // events.json sha changed; re-fetch tastings sha is still valid since we haven't written it yet
    await githubPutFile('wine_tastings.json', tastingsFile.content, tastingsFile.sha,
      'Link auto-created ticket event(s) back to wine_tastings.json\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>');
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Ticket-buyer audience -- pulled straight from the ticketed event's own
// registrant list in events.json, which the Square checkout webhook already
// keeps up to date (see event-register.js / square-webhook.js). Merges in
// the older Stripe-era top-level `registrations` map for completeness, since
// a handful of past events only recorded buyers there.
// ---------------------------------------------------------------------------
function findTicketedEvent(t, eventsData) {
  if (!t.eventId || !eventsData) return null;
  return (eventsData.events || []).find((e) => e.id === t.eventId) || null;
}

function ticketBuyerRecords(t, eventsData) {
  const ev = findTicketedEvent(t, eventsData);
  const byEmail = new Map();
  if (ev && Array.isArray(ev.registrations)) {
    for (const r of ev.registrations) {
      if (r.email) byEmail.set(r.email.toLowerCase(), r.name || '');
    }
  }
  const legacy = eventsData && eventsData.registrations && eventsData.registrations[t.eventId];
  if (Array.isArray(legacy)) {
    for (const r of legacy) {
      if (r.email && (!r.status || String(r.status).toUpperCase() === 'PAID')) {
        byEmail.set(r.email.toLowerCase(), r.name || '');
      }
    }
  }
  return byEmail; // Map<lowercaseEmail, displayName>
}

function ticketBuyerEmailSet(t, eventsData) {
  return new Set(ticketBuyerRecords(t, eventsData).keys());
}

function ticketBuyerContacts(t, eventsData, subscribedContacts) {
  const records = ticketBuyerRecords(t, eventsData);
  if (records.size === 0) return [];
  const subFirstNameByEmail = new Map(subscribedContacts.map((s) => [s.email.toLowerCase(), s.firstName]));
  const contacts = [];
  for (const [email, name] of records) {
    const firstName = subFirstNameByEmail.get(email) || (name || '').trim().split(/\s+/)[0] || '';
    contacts.push({ email, firstName });
  }
  return contacts;
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
const CALLOUT = 'background:#FAF3E7;border-left:4px solid #B8933A;padding:16px 20px;margin:18px 0;font-family:Georgia,serif;font-size:15px;color:#2C1A0E;';
const BTN_GOLD = 'display:inline-block;background:#B8933A;color:#1A0E08;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:Georgia,serif;';
const BTN_OUTLINE = 'display:inline-block;background:transparent;border:2px solid #B8933A;color:#9A6B2E;padding:11px 28px;border-radius:6px;text-decoration:none;font-weight:bold;font-family:Georgia,serif;';

// ---------------------------------------------------------------------------
// GUEST GROWTH: invite / lastcall / thankyou
// ---------------------------------------------------------------------------
function inviteEmail(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  const subject = 'Fall + Wine Deserve Each Other';
  const html = wrap(`
<h2 style="${H2}">There's no better time to join Rock &amp; Vine than right now.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Fall at The Quarry means cozy nights, great company, and honestly &mdash; the best wine lineup we run all year. If you've ever thought about joining the Rock &amp; Vine Wine Club, this is the season to do it.</p>
<div style="${CALLOUT}">
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
<div style="${CALLOUT}">
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

// ---------------------------------------------------------------------------
// TICKET BUYER: ticket_monday / ticket_dayafter
// ---------------------------------------------------------------------------
function ticketMondayEmail(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  const subject = `You're All Set for This Week — ${t.winery}`;
  const html = wrap(`
<h2 style="${H2}">You're all set for this week.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Just a friendly reminder &mdash; your spot for <strong>${t.winery}</strong> is confirmed for <strong>${dateStr} at ${timeStr}</strong>. Your ticket covers you and one guest, so bring them along.</p>
<div style="${CALLOUT}">
<strong>Date:</strong> ${dateStr}<br>
<strong>Time:</strong> ${timeStr}<br>
<strong>Where:</strong> The Quarry, 3960 Highway Z, New Melle, MO
</div>
<p style="${P}">Expect five to six wines, a food pairing with each, and bottles available to buy at the end of the night if something catches your palate.</p>
<p style="${P}">Questions before then? Just reply to this email.</p>
<p style="${P}">See you soon,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function ticketDayAfterEmail(t) {
  const subject = `Loved ${t.winery}? Here's How to Never Miss One`;
  const html = wrap(`
<h2 style="${H2}">Glad you came out.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">Thank you for coming out to <strong>${t.winery}</strong> last night &mdash; we hope you and your guest had a great time.</p>
<p style="${P}">If you liked what you tasted, here's the easiest way to make sure you never miss the next one: join Rock &amp; Vine for $29.99/month and get</p>
<div style="${CALLOUT}">
<p style="margin:0;line-height:1.9;">🍇 Priority RSVP to every tasting, before it opens to the public<br>
🥂 A discount on wine purchases, every visit<br>
👥 One guest included at every tasting, on us &mdash; no extra ticket needed<br>
🏡 A community of regulars who show up for the same reason you did last night</p>
</div>
<p style="${P}">At $29.99/mo, you're basically covered for the next tasting already &mdash; and every one after that.</p>
<p style="text-align:center;margin:22px 0;"><a href="https://thequarrystl.com/quarry-wineclub#member-form" style="${BTN_GOLD}">Join Rock &amp; Vine &mdash; $29.99/mo →</a></p>
<p style="${P}">Hope to see you again soon,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

// ---------------------------------------------------------------------------
// MEMBER CADENCE: member_dayafter / member_halfway / member_monday / member_dayof
// ---------------------------------------------------------------------------
function memberDayAfterEmail(t, next) {
  const subject = 'Thank You for an Unforgettable Night';
  const html = wrap(`
<h2 style="${H2}">Thank you for an unforgettable night.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">${t.winery} was such a great one &mdash; thank you for being part of it. Nights like that are exactly what Rock &amp; Vine is about.</p>
<div style="${CALLOUT}">Mark your calendar: <strong>${next.winery}</strong> is up next, and we're already excited about this lineup.</div>
<p style="${P}">If last night reminded you why you joined, do us a favor and bring that lineup to life for someone else too &mdash; your membership already includes a guest at every tasting, so there's no reason not to.</p>
<p style="${P}">Cheers,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function memberHalfwayEmail(t, next) {
  const subject = `Halfway to ${next.winery} — Who Are You Bringing?`;
  const shareUrl = next.ticketUrl || 'https://thequarrystl.com/quarry-wineclub';
  const html = wrap(`
<h2 style="${H2}">Halfway there already.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">We're partway to <strong>${next.winery}</strong>, and we're already looking forward to it. Now's the perfect time to start planning who you're bringing.</p>
<div style="${CALLOUT}">Your membership includes one guest at no extra charge &mdash; the earlier you invite them, the better the odds they can make it.</div>
<p style="${P}">Know a few people who'd love a night like this? Copy the link below and send it their way &mdash; it takes them straight to a ticket for this tasting, no membership required.</p>
<div style="background:#FFFFFF;border:1px solid #E4DACB;border-radius:6px;padding:12px 14px;margin:0 0 14px;">
<p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.5;color:#5C3A17;word-break:break-all;">${shareUrl}</p>
</div>
<p style="${P}">Or if they're ready to skip straight to membership &mdash; priority RSVP, a wine discount, and their own guest included every month &mdash; send them here instead:</p>
<div style="background:#FFFFFF;border:1px solid #E4DACB;border-radius:6px;padding:12px 14px;margin:0 0 18px;">
<p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.5;color:#5C3A17;word-break:break-all;">https://thequarrystl.com/quarry-wineclub#member-form</p>
</div>
<p style="${P}">Can't wait,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function memberMondayEmail(t) {
  const dateStr = fmtLongDate(t.date), timeStr = fmtTime(t.time);
  const subject = "We Can't Wait to See You This Week";
  const html = wrap(`
<h2 style="${H2}">We can't wait to see you this week.</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}">${dateStr} is <strong>${t.winery}</strong> night at The Quarry. Doors at ${timeStr} &mdash; come hungry, come thirsty, come ready to talk wine.</p>
<div style="${CALLOUT}">Bringing your guest? Perfect &mdash; your membership covers you both. Haven't invited anyone yet? There's still time.</div>
<p style="${P}">And if your guest has a great time, they don't have to wait for an invite next time &mdash; they can join Rock &amp; Vine themselves, or grab their own ticket for a future tasting.</p>
<p style="text-align:center;margin:22px 0 10px;"><a href="https://thequarrystl.com/quarry-wineclub#member-form" style="${BTN_GOLD}">Share Rock &amp; Vine &mdash; $29.99/mo →</a></p>
<p style="text-align:center;margin:0 0 10px;font-family:Georgia,serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#9A8B7A;">or</p>
<p style="text-align:center;margin:0 0 22px;"><a href="${t.ticketUrl}" style="${BTN_OUTLINE}">Share a Ticket for Two &mdash; $44.99 →</a></p>
<p style="${P}">See you soon,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

function memberDayOfEmail(t) {
  const timeStr = fmtTime(t.time);
  const subject = "Tonight's the Night!";
  const html = wrap(`
<h2 style="${H2}">Tonight's the night!</h2>
<p style="${P}">Hi {firstName},</p>
<p style="${P}"><strong>${t.winery}</strong> is on-site tonight at ${timeStr}. The glasses are out, the pairings are plated, and we're ready for you.</p>
<div style="${CALLOUT}">Running late or bringing your guest at the last minute? No problem &mdash; just give us a call, we'll have your names at the door either way.</div>
<p style="${P}">See you at The Quarry tonight &mdash; can't wait.</p>
<p style="${P}">Cheers,<br>The Quarry Wine Team</p>`);
  return { subject, html };
}

const BUILDERS = {
  invite: (x) => inviteEmail(x.t),
  lastcall: (x) => lastCallEmail(x.t),
  thankyou: (x) => thankYouEmail(x.t),
  ticket_monday: (x) => ticketMondayEmail(x.t),
  ticket_dayafter: (x) => ticketDayAfterEmail(x.t),
  member_monday: (x) => memberMondayEmail(x.t),
  member_dayof: (x) => memberDayOfEmail(x.t),
  member_dayafter: (x) => memberDayAfterEmail(x.t, x.next),
  member_halfway: (x) => memberHalfwayEmail(x.t, x.next),
};
const NEEDS_NEXT = new Set(['member_dayafter', 'member_halfway']);

function recipientsFor(kind, t, ctx) {
  const { subscribedContacts, activeMemberEmails, activeMemberContacts, eventsData } = ctx;
  switch (kind) {
    case 'invite':
    case 'lastcall':
    case 'thankyou': {
      const ticketBuyers = ticketBuyerEmailSet(t, eventsData);
      return subscribedContacts.filter((r) => {
        const e = r.email.toLowerCase();
        return !activeMemberEmails.has(e) && !ticketBuyers.has(e);
      });
    }
    case 'ticket_monday':
    case 'ticket_dayafter':
      return ticketBuyerContacts(t, eventsData, subscribedContacts).filter((r) => !activeMemberEmails.has(r.email.toLowerCase()));
    case 'member_monday':
    case 'member_dayof':
    case 'member_dayafter':
    case 'member_halfway':
      return activeMemberContacts;
    default:
      return [];
  }
}

// Builds every scheduled send across all three cadences for the full
// tasting list, sorted ascending. member_dayafter/member_halfway only exist
// once a next tasting is known (nothing to tease before it's on the schedule).
function buildScheduleItems(allTastingsSorted) {
  const items = [];
  for (let i = 0; i < allTastingsSorted.length; i++) {
    const t = allTastingsSorted[i];
    const next = allTastingsSorted[i + 1];

    items.push({ key: t.id + ':invite', date: addDays(t.date, -21), kind: 'invite', t });
    items.push({ key: t.id + ':lastcall', date: mondayOfWeek(t.date), kind: 'lastcall', t });
    items.push({ key: t.id + ':thankyou', date: addDays(t.date, 1), kind: 'thankyou', t });
    items.push({ key: t.id + ':ticket_monday', date: mondayOfWeek(t.date), kind: 'ticket_monday', t });
    items.push({ key: t.id + ':ticket_dayafter', date: addDays(t.date, 1), kind: 'ticket_dayafter', t });
    items.push({ key: t.id + ':member_monday', date: mondayOfWeek(t.date), kind: 'member_monday', t });
    items.push({ key: t.id + ':member_dayof', date: t.date, kind: 'member_dayof', t });
    if (next) {
      items.push({ key: t.id + ':member_dayafter', date: addDays(t.date, 1), kind: 'member_dayafter', t, next });
      items.push({ key: t.id + ':member_halfway', date: midpoint(t.date, next.date), kind: 'member_halfway', t, next });
    }
  }
  return items;
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

    let [tastingsData, subscribers, eventsData, wineClub, log] = await Promise.all([
      fetchJson(REPO_RAW + '/wine_tastings.json?t=' + Date.now()),
      fetchJson(REPO_RAW + '/subscribers.json?t=' + Date.now()),
      fetchJson(REPO_RAW + '/events.json?t=' + Date.now()),
      readBlob('wine-club-members'),
      readSentLog(),
    ]);

    const today = todayCT();

    // Auto-create a ticketed checkout page for any upcoming tasting that
    // doesn't have one yet (skipped in dry-run, which must stay read-only).
    let provisioned = { created: [] };
    if (!dryRun) {
      try {
        provisioned = await ensureTicketEvents(tastingsData, today);
        if (provisioned.created.length > 0) {
          // Our in-memory copies are now stale (ticketUrl/eventId, new events.json rows) -- re-fetch both.
          [tastingsData, eventsData] = await Promise.all([
            fetchJson(REPO_RAW + '/wine_tastings.json?t=' + Date.now()),
            fetchJson(REPO_RAW + '/events.json?t=' + Date.now()),
          ]);
        }
      } catch (e) {
        console.error('ensureTicketEvents failed (continuing with email sends anyway):', e.message);
      }
    }
    const allTastings = tastingsData.tastings || [];
    if (allTastings.length === 0) {
      return json({ ok: true, message: 'no tastings in wine_tastings.json', today });
    }
    const sortedTastings = [...allTastings].sort((a, b) => a.date.localeCompare(b.date));

    // Every scheduled send across all three cadences, for every tasting,
    // independent of "next upcoming only" -- so several tastings can be
    // queued in advance and each one's milestones are checked on their own.
    const scheduleItems = buildScheduleItems(sortedTastings);

    const force = url.searchParams.get('force'); // one of BUILDERS' keys -- manual override, applies to the soonest qualifying upcoming tasting. Idempotency below still applies.
    const testMode = url.searchParams.get('test') === '1';

    let dueList;
    if (force) {
      if (!BUILDERS[force]) return json({ ok: false, error: 'unknown force milestone: ' + force, validMilestones: Object.keys(BUILDERS) }, 400);
      const upcoming = sortedTastings.filter((t) => t.date >= today);
      let chosen = null;
      for (const t of upcoming) {
        const idx = sortedTastings.indexOf(t);
        const next = sortedTastings[idx + 1];
        if (NEEDS_NEXT.has(force) && !next) continue;
        chosen = { t, next };
        break;
      }
      if (!chosen) return json({ ok: true, message: 'no qualifying upcoming tasting to force ' + force, today });
      dueList = [{ key: chosen.t.id + ':' + force, date: today, kind: force, t: chosen.t, next: chosen.next }];
    } else {
      dueList = scheduleItems.filter((x) => x.date === today);
    }

    if (dueList.length === 0) {
      return json({ ok: true, message: 'nothing due today', today, provisioned, scheduleItems: scheduleItems.map((x) => ({ key: x.key, date: x.date })) });
    }

    const activeMemberEmails = new Set(
      ((wineClub && wineClub.members) || [])
        .filter((m) => (m.status || '').toLowerCase() === 'active')
        .map((m) => (m.email || '').toLowerCase())
    );
    const activeMemberContacts = ((wineClub && wineClub.members) || [])
      .filter((m) => (m.status || '').toLowerCase() === 'active' && m.email)
      .map((m) => ({ email: m.email, firstName: m.firstName || m.first_name || (m.name || '').split(' ')[0] || '' }));
    const subscribedContacts = (subscribers || [])
      .filter((s) => s.email && s.emailStatus === 'Subscribed')
      .map((s) => ({ email: s.email, firstName: s.firstName || '' }));

    const ctx = { subscribedContacts, activeMemberEmails, activeMemberContacts, eventsData };

    const results = [];
    for (const item of dueList) {
      const { t, kind, key } = item;
      if (!testMode && log.sent.some((s) => s.key === key)) {
        results.push({ tasting: t.id, milestone: kind, skipped: 'already sent' });
        continue;
      }

      const recipients = recipientsFor(kind, t, ctx);
      const { subject, html } = BUILDERS[kind](item);

      if (dryRun) {
        results.push({ tasting: t.id, milestone: kind, dryRun: true, recipientCount: recipients.length, subject });
        continue;
      }

      // ?test=1 -- exercises the REAL SendGrid call end-to-end, but only to
      // management@thequarrystl.com, and does NOT mark the milestone as
      // sent (so the real campaign send afterward still goes out normally).
      if (testMode) {
        const result = await sendBulkEmail([{ email: 'management@thequarrystl.com', firstName: 'Matthew' }], '[TEST] ' + subject, html);
        results.push({ tasting: t.id, milestone: kind, testMode: true, subject, recipientCountIfReal: recipients.length, ...result });
        continue;
      }

      const result = await sendBulkEmail(recipients, subject, html);
      await markSent(log, key);
      results.push({ tasting: t.id, milestone: kind, recipientCount: recipients.length, ...result });
    }

    return json({ ok: true, today, provisioned, results });
  } catch (e) {
    console.error('wine-growth-campaign error:', e);
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
};

function json(body, status = 200) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body, null, 2) };
}
