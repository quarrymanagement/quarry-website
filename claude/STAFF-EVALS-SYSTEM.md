# Staff Self-Evaluations

Built 2026-10-18. Admin → **Team › Evaluations** (tab id `staffevals`). Owner login + events_staff.

Not disciplinary. Never feeds Write-Ups. The employee page and email both say so.

## Pieces
| Piece | Where | Notes |
|---|---|---|
| Admin tab | `admin/staff-evals-admin.js` | Self-injecting, loaded from `admin/index.html` after Training Tests. Views: Send · Responses · Questions |
| Employee page | `staff-eval.html?t=<token>` | noindex, mobile-first, one standard per screen, autosaves in localStorage |
| Backend | Supabase edge fn `staff-evals` (verify_jwt off, custom auth) | Source `supabase/functions/staff-evals/index.ts`. **The six forms live in `FORMS` here** |
| Tables | `staff_evaluations`, `staff_evaluation_audit` | RLS on, no policies, anon/authenticated revoked. Migration `staff_evaluations`. Schema: `claude/staff-evals-schema.sql` |

## Forms
server · host · busser · expo · bartender · kitchen. Each has 7–8 **standards** (the policy, in one or two sentences) and, for each, a 1–5 self-rating plus a required real example (8+ words). Then three shared open questions (15+ words): strongest area, hardest standard and why, what they need from management.

Scale is frequency-anchored so it means the same thing in every role: 1 Not yet · 2 Some shifts · 3 Most shifts · 4 Every shift · 5 I could train it.

Edit wording in `FORMS` and bump that form's `version`; redeploy the function. Existing records keep `form_version`.

## Flow
1. **Send** — pick a role → the full form is shown → "Questions look good" → roster (Square team + `checklist_staff`). Server/bartender/kitchen are pre-checked by checklist role or Square job title. Host/busser/expo: Square lumps them as Support Staff, so support staff are listed **unchecked** to tick by hand. Anyone with an open eval for that role is flagged and not pre-checked. Email → sent immediately; no email → Text / Copy link per person on the result screen.
2. Employee opens → `in_progress` → submits → `submitted`. management@ emailed with their average.
3. **Respond** — rate every standard 1–5 + note, strengths, focus for next 30 days (required), anything else. Gap of 2+ between self and management is flagged both sides. Save draft or Send → `responded`, employee emailed.
4. Employee's same link shows both ratings side by side + notes, and asks for a reflection (15+ words) → **Acknowledge** → `acknowledged`, management@ emailed the reflection. Locked after that.
5. **Void** keeps the record, kills the link.

Ref numbers `EV-<year>-<seq>`. `EV-2026-0001` is Claude's end-to-end test (voided).

## Cadence
30 days after hire, then quarterly.

## The numbers (management only)
Every evaluation's detail screen has a **The numbers** card: this person vs the average for others in their Square job title (10+ hours in the window), 30/60/90 days. Function `public.staff_eval_metrics(name, days)` (migration `staff_eval_metrics`, source `claude/staff-eval-metrics.sql`), called by edge action `admin_metrics`. Matched on the Square shift name, so the name on the eval must match Square exactly. When you send a response, the 60-day numbers are frozen onto the record (`metrics_snapshot`) so later reviews compare against what you saw. The employee never sees this card.

| Metric | Source | Who it covers |
|---|---|---|
| Shifts / hours, shifts over 12h (missed clock-out) | `square_sync.shifts` | everyone |
| Checks, average check, tips % of sales | `square_sync.order_header` | check-holders (servers, bartenders) |
| Comps per 100 checks, split by reason (complaint, entry error, changed mind, other) and $ | `square_sync.discount_detail` (employee discounts excluded) | check-holders |
| Cash tips declared vs cash taken | `order_tips` (CASH) vs `shifts.declared_tips_cents` | check-holders. Flagged under 10% |
| Checklist sign-offs | `checklist_logs.staff_name` | everyone who signs a board |
| Latest training test | `training_test_attempts` | anyone who took one |

Not measurable yet: voids (Square line deletions aren't synced; "Entry error" comps are the closest proxy), refires (no KDS data; "Customer complaint" comps are the proxy, attributed to the server, not the cook), handheld vs terminal (device isn't synced), who approved a comp (Square records no approver on any comp in the last 60 days).

## Guest feedback (Google reviews)
Built 2026-10-19. Table `guest_reviews` (schema `claude/guest-reviews.sql`). Admin › Team › Evaluations › **Guest feedback**: filter complaints / last 60 days / staff-named / hidden; per review write **"What we're changing"** (staff see it under the review), tag staff first names (auto-tagged on import from `checklist_staff`; confirm by hand), or hide it.

On the employee's evaluation, the first screen after the intro is **What guests are saying**: shared reviews from the last 60 days, grouped as reviews that name them, then the 5 most recent complaints (3★ or less), then two 5★. Every form (version 2) adds a first open question: pick one complaint, what will you personally do differently. What they saw is frozen on the record (`feedback_snapshot`) and shown on the manager's response screen.

Import: reviews are read from the Business Profile owner view (business.google.com/reviews) in Chrome while signed in as the profile manager. First import 2026-10-19: 83 written reviews since 2025-11-01 (32 at 3★ or less, 9 naming staff). Staging table `guest_reviews_stage` held the batch; its insert policy was dropped right after. Edge action `admin_reviews_import` takes the same rows for future pulls (dedup on source + Google review id).

## Goals and weekly check-ins
Built 2026-10-19. Edge function `staff-checkins` (source `supabase/functions/staff-checkins/index.ts`), tables `staff_goals`, `staff_checkins`, `staff_weekly_focus` (schema `claude/staff-goals-checkins.sql`). Kept separate from `staff-evals` on purpose.

- **End of the evaluation:** "Your goals for next week": 2 goals, each tied to a standard (the first pre-set to the one they rated lowest) with 6+ words on exactly what they'll do. Saved by `goals_set` right after the evaluation submits; the results page shows them.
- **Manager:** every evaluation has a **Goals** card: edit wording, mark done, drop, reopen, or add a goal "from management".
- **Weekly tab:** (1) one-line team focus per role for the week (top of each check-in; last week's shown as a hint); (2) send check-ins to everyone with an open goal who hasn't had one that week; (3) read the three answers and reply: one-tap replies ("Great work. Keep it up.", "Let's talk on your next shift.", etc.) or your own words. They're emailed the first time you reply, and see it on their link and at the top of next week's.
- **Check-in page** `staff-checkin.html?t=<token>`, Matt's three questions, built to take about a minute:
  1. *What are some things you focused on this week?* Per open goal: tap Done / Partly / Not yet + one line (3+ words). Free text (5+ words) if they had no goals, optional "anything else" otherwise.
  2. *What could you do to keep improving on those?* (5+ words)
  3. *What are two things you want to add on?* Two short new goals (4+ words), standard optional. Standards per role are mirrored in `AREAS` in the function; keep it in step with `FORMS` in `staff-evals`.
- Done goals close. Unfinished goals carry if "keep working on this" stays ticked (default), otherwise they're dropped. Max 4 open goals; the page and server both enforce it.
- Weeks run Monday to Sunday, Chicago time. Sending is a button for now (not automatic).
