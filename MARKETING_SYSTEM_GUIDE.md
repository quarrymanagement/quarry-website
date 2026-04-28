# The Quarry — Marketing System Guide

Last updated: 2026-04-27

This is the operator's guide to your full automated marketing engine: how it works, what's running, what needs you, and how to extend it.

---

## What's running automatically

| What | When | What it does |
|------|------|--------------|
| `social-cadence-engine` | Every 4 hours | Reads events.json + bands + wine club, builds 60-day arc of skeleton posts. Reshuffles when new events appear. |
| `social-generate-daily` | 13:00 UTC (8am CT) | Hydrates captions for skeletons coming up in the next 7 days. |
| `social-post` | Every 10 min | Posts approved drafts to Facebook + Instagram at their `scheduledFor` time. |
| `social-poll-stats` | Every 30 min | Pulls reach/likes/comments/shares from Meta Graph API. |
| `social-optimize` | 8:00 UTC (3am CT) | Mines last 60 days of engagement for patterns. Writes insights into AI prompts. |
| `social-weather-trigger` | 11:00 UTC (6am CT) | Checks today's forecast. Auto-creates patio-perfect or cozy-fireside drafts on service days (Wed-Sun). |
| `marketing-generate-daily` | 12:00 UTC (7am CT) | Email drafts (parallel arc to social — same events, different channel). |
| `marketing-send` | Every 10 min | Sends approved emails via SendGrid. |
| `marketing-poll-stats` | Every 15 min | Email opens/clicks/bounces. |
| `marketing-optimize` | 7:00 UTC (2am CT) | Email engagement learning loop. |

---

## Daily operator workflow (~5 min/day)

1. Open `/admin/` → **Social** → **Drafts Inbox**.
2. For each pending draft (badge shows count):
   - Read the **Graphic Brief** in the modal.
   - Either **upload your Canva poster** (gold button) OR **pick from asset library** OR **generate DALL-E** (~$0.04).
   - Edit caption if needed.
   - Click **Approve & Schedule** OR **Post Now**.
3. Open **Email** tab → review pending email drafts the same way.

That's it. The rest runs.

---

## Designer queue (build graphics ahead of time)

**Social tab → Settings → 📋 Designer Queue.** Shows every upcoming post that needs a graphic, with:

- Build by date (when you need it ready)
- Template reference (which Canva template to copy)
- Spec (title, date, callout, etc.)
- Tone mode (standard / urgency / value-push)

Build them in batches once a week, upload via the modal as posts come up for review.

---

## Asset library (eliminates DALL-E spend for vibe posts)

Add real venue photos in **Social → Settings → 📚 Asset Library → + Add Venue Photo**. Tag them (`patio`, `sunset`, `food`, `wine`, `band`, `golf`, etc.) so the AI can pick the right one.

When generating an atmosphere post, the AI sees the available library and picks a real Quarry photo if one fits — saves $0.04/post and your real venue beats AI vibes every time.

**Recommended starter assets:**
- 5-10 patio shots (different times of day)
- 5-10 food close-ups (top-sellers + seasonal)
- 5-10 venue interior (bar, fireplace, dining room)
- 5-10 band-on-stage shots
- 5-10 cocktail/wine close-ups
- 5-10 golf course / Hole-in-One shots
- 5-10 wide views (Quarry lake, cliffs, sunset)

Total: ~50 photos = essentially infinite vibe content.

---

## Cross-channel attribution (UTM tags)

Every link in every post (email + social) is auto-tagged like:

- Email: `?utm_source=email&utm_medium=marketing&utm_campaign=event-evt-bootscootin-oct17-T-7`
- Facebook: `?utm_source=facebook&utm_medium=social&utm_campaign=event:evt-bootscootin-oct17:T-7`
- Instagram: `?utm_source=instagram&utm_medium=social&utm_campaign=event:evt-bootscootin-oct17:T-7`

In Google Analytics, filter `utm_campaign` contains `evt-bootscootin-oct17` to see all touches across email + FB + IG rolling up to that one event.

**You need Google Analytics installed on thequarrystl.com** for this to actually capture data. If it's not already there, that's the missing piece — install GA4 once and attribution lights up everywhere.

---

## Things that still need you (one-time setup)

### 1. Add OpenAI API credits ($10 recommended)

Currently blocking DALL-E image regeneration.

1. Go to https://platform.openai.com/account/billing/overview
2. Add $10 credits
3. Set up auto-recharge ($10 when balance < $5)

Without this, you can still use uploaded posters and the asset library — DALL-E is the only thing that needs credits.

### 2. (Optional) Google Business Profile posts

GBP posts show up in Google Maps when people search "wine bar near me" — huge for local discovery. Setup involves:

1. Verify you're the GBP manager for The Quarry at https://business.google.com/
2. Enable Google Business Profile API in Google Cloud Console (free)
3. Create OAuth client ID, download credentials JSON
4. Add credentials to Netlify env: `GOOGLE_GBP_CREDENTIALS_JSON`
5. Tell me when done — I'll wire `social-post.js` to also post to GBP

This is 30 min of setup work for substantial local SEO wins. Worth doing when you have a free morning.

### 3. (Optional) Meta DM auto-response

Capture leads from FB/IG comments + DMs by drafting AI replies you approve.

1. Go to your Meta App at https://developers.facebook.com/apps/
2. Add "Messenger" + "Instagram" products
3. Set webhook URL: `https://thequarrystl.com/.netlify/functions/meta-webhook` (I'll build this once you've subscribed)
4. Subscribe to events: `messages`, `comments`, `feed`
5. Add `META_WEBHOOK_VERIFY_TOKEN` env var
6. Submit app for review (requires "pages_messaging" + "instagram_manage_comments" permissions)

App Review takes 1-2 weeks. Plan ahead.

### 4. Add non-ticketed events to events.json

Right now `events.json` only has 4 ticketed events. Your existing posters show events like "Boots & Bourbon" (no reservation), "Yoga Un-Wine-D" (RSVP via email), etc. These aren't in the data, so the cadence engine can't promote them.

Two options:
- **Manual add**: Use the existing Events admin tab to add them with a new category like `Special Event` or `RSVP Only`
- **Wix sync**: If you keep events in Wix, build a Wix → events.json sync (let me know)

Same for **bands** — make sure bands are added 4-6 weeks in advance so the cadence engine can build proper T-30/T-14/T-7 promo arcs. Right now most bands only get T-3 + T-0 because they're added too late.

---

## How the AI learns (and what to feed it)

The optimizer (`social-optimize`) runs nightly. After 5+ posted+polled posts, it starts finding patterns:

- "Posts on Wednesday 6pm CT get 2.3× the reach of Thursday morning"
- "Posts with caption length 60-90 chars outperform 200+ on Instagram"
- "Posts using `#STLWeekend` outperform those without by 1.4×"

These insights show in **Social → Settings → 🧠 AI Learnings**, and feed into every new caption generation automatically.

**To accelerate learning:** approve & post consistently for 2-3 weeks. The optimizer needs volume to find real patterns. Anything less than 5 posts and it returns "not enough data yet."

---

## Cost summary (typical month)

| Service | Cost |
|---------|------|
| Anthropic Claude (caption generation) | ~$2-5/month at 1 post/day |
| OpenAI DALL-E (only when you use it) | ~$0/month if you use library + uploads, ~$1-3 if mixed |
| SendGrid Marketing Basic 5k | $15/month (already have) |
| Open-Meteo weather API | $0 (free) |
| Meta Graph API | $0 (free) |
| GitHub storage for assets/data | $0 (within free tier) |
| Netlify functions | $0 (within free tier; ~50k invocations/month) |

**Total ongoing: ~$17-23/month** for the entire automated marketing engine.

---

## File map (where everything lives)

| File | Purpose |
|------|---------|
| `events.json` | Source of truth for events + bands + registrations |
| `social_drafts.json` | Pending/approved/posted social drafts |
| `social_calendar.json` | Legacy rules (cadence engine has mostly replaced) |
| `social_events.json` | Engagement aggregates from Meta |
| `social_learnings.json` | AI-generated optimization insights |
| `social_assets.json` | Asset library (real venue photos) |
| `marketing_drafts.json` | Email drafts |
| `marketing_calendar.json` | Email rules |
| `marketing_events.json` | Email engagement (opens/clicks) |
| `marketing_learnings.json` | Email AI learnings |

---

## Troubleshooting

**"Image gen failed: billing limit reached"** → Add OpenAI credits (above).

**Drafts not appearing for new events** → Click "Rebuild Schedule" in Social → Settings, or wait 4 hours for cron.

**Caption sounds off / wrong tone** → Open the draft, click "Redo", give specific feedback ("less corporate", "lead with the band name", etc.). The model adapts to per-draft instructions.

**No posts going live** → Check Social → Settings → Meta Connection. Should be ✓ Connected. If ✗, the META_PAGE_ACCESS_TOKEN env var needs refresh.

**Want to pause everything** → Comment out the cron schedules in `netlify.toml`, redeploy.

---

## What's next (Phase 2 backlog)

These would build on what's now running:

1. **Comment/DM AI response inbox** — captures FB/IG comments, drafts replies
2. **Google Business Profile posts** — local SEO win
3. **Stories scheduling** — Stories are 30% of IG engagement, currently zero
4. **Wix → events.json sync** — auto-pull events from Wix
5. **Loyalty program tie-in** — link social engagement to guest rewards
6. **Reservation widget integration** — bake reservation links into all event posts
7. **Competitor monitoring** — track 3-5 nearby venues' posts
8. **Review monitoring** (Google / Yelp / TripAdvisor) — auto-draft responses

Pick whichever matters most when you're ready to extend.
