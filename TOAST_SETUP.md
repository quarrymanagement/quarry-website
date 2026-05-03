# Toast → Quarry Rewards Integration

This wires Toast's webhook into your member rewards program. When a member's tab closes at the bar, Toast pushes the order to your Netlify function, which credits points to their account based on `rewards.json` (earn rate × tier multiplier) and writes the change to `members.json`.

## What's already deployed

- **Netlify function:** `netlify/functions/toast-order-webhook.js`
  - Public URL: `https://thequarrystl.com/.netlify/functions/toast-order-webhook`
- **Member matching:** by email (primary), phone (last 10 digits, fallback)
- **Idempotency:** retries with the same `orderId` won't double-credit
- **Tier promotion:** automatic when lifetime points cross thresholds
- **Audit trail:** every credit lands in the member's `history[]` with order ID

## What you need to do once (~30 min)

### 1 — Get Toast Public API access

Toast's "free" API requires you to enable it on your account. Two paths:

**A. Self-serve (try this first):**
1. Sign in to https://www.toasttab.com/restaurants
2. Go to **Settings → Integrations → API & Webhooks** (exact path may have changed)
3. Look for "Public API" or "Restaurant API" — request access if it isn't already enabled

**B. If self-serve isn't available:**
- Email `cx-service@toasttab.com` (the address on your existing case ref `!00DC0017Bak.!500PV01UhzZY`)
- Subject: "Enable Public API access — The Quarry"
- Body: "We're staying with Toast and would like to enable the Public API + Webhooks for our loyalty program. Please advise on next steps and any fees."

You'll receive **API credentials**: a client ID, client secret, and a **webhook signing secret**.

### 2 — Subscribe to webhook events

Inside Toast's API console:

- Webhook URL: `https://thequarrystl.com/.netlify/functions/toast-order-webhook`
- Subscribe to: `OrderUpdated` and `CheckClosed` (or whatever Toast calls "tab paid/closed")
- Save and copy the **signing secret**

### 3 — Set Netlify environment variables

Netlify dashboard → site `roaring-pegasus-444826` → **Site settings → Environment variables → Add new**

| Variable | Value |
|---|---|
| `TOAST_WEBHOOK_SECRET` | The signing secret from step 2 |
| `GITHUB_TOKEN` | (already set — leave alone) |

### 4 — Test it

1. In Toast, ring up a small test sale ($1). At tab open, enter **your own email** as the customer.
2. Close the tab.
3. Within ~10 seconds, the webhook fires.
4. Open admin → **Customers → Rewards Members → click your member → +/− Pts** to see the audit trail. You should see a `+10 pts` (for $1 spent at 10 pts/$1) entry tagged `by: toast-webhook`.

### 5 — Train your servers

For points to credit, the customer's email or phone has to be on the Toast tab. The simplest server prompt: **"Are you a Quarry rewards member? What's your email?"** before swiping the card. Toast lets you save customer info on a tab/check at order time.

Phone numbers also work — the webhook compares the last 10 digits, so formatting differences like `(636) 224-8257` vs `6362248257` both match.

## How it behaves day-to-day

| Scenario | Result |
|---|---|
| Member's email on tab → close → webhook fires | Points credited, audit log entry, tier auto-updates |
| No customer info on tab | Webhook returns success, nothing credited (failsafe) |
| Customer's email isn't a member yet | Webhook returns `unmatched`, logged in Netlify but no credit. Manager can manually add the member later |
| Toast retries the same order twice | Second attempt detects duplicate `orderId` and skips — no double credit |
| Server enters a typo in email | Won't match a member; no credit, no harm done |

## Troubleshooting

- **Netlify function logs:** Site dashboard → **Functions → toast-order-webhook → Logs**. Every webhook is logged with the result (`earned`, `unmatched`, `skipped`, etc.)
- **Webhook never fires:** Check Toast's webhook delivery logs. If they're returning errors, check Netlify's function logs for stack traces. Most common: missing `TOAST_WEBHOOK_SECRET` env var causing 401 responses.
- **Test mode:** Set `TOAST_WEBHOOK_SECRET=""` (empty) in Netlify temporarily to skip signature verification while debugging. Re-enable after.
- **Member exists but no credit:** Most likely the email on the Toast tab doesn't exactly match `members.json`. Compare in admin.

## What's NOT in this integration (future scope)

- **Redemption** — when a member uses a $5-off reward, Toast won't know to discount the bill. Bartender currently honors it manually. Wiring this requires Toast's Loyalty / Discount API — separate build.
- **Sign-up at the bar** — server can't currently create a new member from inside Toast. Adding the customer to the tab + filling out the admin add-member form is a two-step process today.
- **Tier promotion email** — when a member crosses to Gold or Platinum, no email is sent. SendGrid integration exists but the trigger isn't wired in yet.

These are all good candidates for the next iteration.
