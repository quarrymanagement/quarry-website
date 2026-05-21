# Quarry Rewards — Distribution Kit

Use this once the apps are approved and live. Until then, the web version at `/quarry-app-customized.html` works for everything except push notifications.

---

## Smart Redirect Page

**Live at:** `https://thequarrystl.com/quarry-rewards.html`

This is a single-page landing that detects the visitor's device and steers them to the right place:

- **iPhone/iPad visitors** — primary button goes to the App Store; Android shows as a secondary option.
- **Android visitors** — primary button goes to Google Play; iOS shows as a secondary option.
- **Desktop** — both store buttons + the web-app link side by side.
- **Always** — "Open in your browser" links the existing web version of the rewards app.

**Before the app stores approve, replace these placeholders in `quarry-rewards.html`:**

- iOS: `https://apps.apple.com/app/id0000000000` → real App Store URL once approved.
- Android: `https://play.google.com/store/apps/details?id=com.thequarrystl.rewards` → already correct (your Bundle ID).

---

## QR Codes

Print these in three places:

| Location | What it looks like | What it points to |
|---|---|---|
| **Bar top runners** (next to the napkin caddies) | "Earn points · The Quarry Rewards · scan to join" | `https://thequarrystl.com/quarry-rewards.html` |
| **Server check presenters** (one in each holder) | "Earn 10 pts per $1 · scan this with your camera" | `https://thequarrystl.com/quarry-rewards.html` |
| **Golf bay cards** (laminated, in each of the four bays) | "Earn a free bucket of balls · 500 pts gets it free · scan to join" | `https://thequarrystl.com/quarry-rewards.html` |

Generate the QR codes at [qr-code-generator.com](https://www.qr-code-generator.com/) or any free QR generator. Use error-correction level **H** (high) — it survives spills and prints stay readable longer. Print on the heaviest cardstock the local print shop carries.

---

## Email Blast Draft (for SendGrid)

Subject options (A/B test — Quarry's SendGrid plan supports it):
- **A:** "Your Quarry rewards card is now an app — and it's free"
- **B:** "Snap a receipt, earn points. Quarry Rewards is live."

Body (HTML, mirrors the in-app onboarding voice):

```html
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1a1a1a;padding:40px 0;font-family:Arial,sans-serif">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="540" style="max-width:540px">
      <tr><td align="center" style="padding:30px 30px 20px">
        <div style="font-family:'Playfair Display',Georgia,serif;font-size:1.8rem;color:#D4AF6A;letter-spacing:0.02em">The Quarry</div>
        <div style="font-size:0.65rem;color:#888;letter-spacing:0.3em;margin-top:6px">NEW MELLE, MISSOURI</div>
      </td></tr>
      <tr><td style="padding:0 30px">
        <h1 style="color:#F5F0E8;font-family:'Playfair Display',Georgia,serif;font-size:1.8rem;line-height:1.2;margin:0 0 16px;font-weight:600">Your rewards card is now an app.</h1>
        <p style="color:rgba(245,240,232,0.85);font-size:1rem;line-height:1.6;margin:0 0 18px">Earn 10 points per dollar at the bar, kitchen, or golf bays. Redeem in person for free pours, bottle credits, entrées, and bucket-of-balls on the golf side.</p>
        <p style="color:rgba(245,240,232,0.85);font-size:1rem;line-height:1.6;margin:0 0 28px"><strong style="color:#D4AF6A">Sign up by [DATE] and we'll drop 500 bonus points</strong> in your account on top of the standard welcome bonus.</p>
      </td></tr>
      <tr><td align="center" style="padding:0 30px 30px">
        <a href="https://thequarrystl.com/quarry-rewards.html" style="display:inline-block;padding:16px 36px;background:#B8933A;color:#1A0E08;text-decoration:none;font-weight:700;letter-spacing:0.22em;font-size:0.85rem;text-transform:uppercase;border-radius:8px">Download the App</a>
      </td></tr>
      <tr><td style="padding:20px 30px 30px;border-top:1px solid rgba(212,175,106,0.2)">
        <p style="color:rgba(245,240,232,0.6);font-size:0.85rem;line-height:1.6;margin:0">The Quarry · 3960 Highway Z · New Melle, MO 63385 · <a href="tel:6362248257" style="color:#D4AF6A;text-decoration:none">636-224-8257</a></p>
        <p style="color:rgba(245,240,232,0.4);font-size:0.7rem;margin:14px 0 0">You received this because you opted in at thequarrystl.com or in-person at the restaurant. <a href="{{unsubscribe}}" style="color:rgba(245,240,232,0.6)">Unsubscribe</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
```

Send to:
- The SendGrid contact list referenced by `SENDGRID_LIST_ALL` env var (everyone who's ever opted in).
- Exclude anyone tagged with the unsubscribed list.

---

## Bartender / Server One-Pager

Print one copy per shift, laminate, keep at the host stand and at the bar service well. Verbiage for staff to use, common Q&A.

### Pitch line (use at the check drop)
> "If you ever come back, our rewards app banks ten points per dollar — about fifteen visits gets you a free entrée and a glass of wine. Want to see how to sign up? Takes thirty seconds."

### Five quick answers

**"Do I need an account?"**
Just your email. We text you a six-digit code each time you sign in on a new phone. No password to remember.

**"Does my tip count toward points?"**
No — your tip stays with your server. Points come off the food + drink subtotal (the pre-tip total).

**"What if I forget to scan my receipt?"**
You have twelve hours from when the tab closed to scan it. After that, ask a manager — they can credit the visit manually as long as the receipt's in our system.

**"What happens at the higher tiers?"**
- Silver (after $300 of trailing spend): 1.1× earn rate
- Gold ($600): 1.25× earn rate + 5% off bottles + free birthday entrée
- Elite ($1,000): 1.5× earn rate + 10% off bottles + complimentary glass per visit + your name on the wall

**"Do points expire?"**
Points themselves don't expire. Your tier perks decay if you don't visit for 60 days (we'll send a 30-day warning).

### Redemption shortcut
When a customer says "I want to redeem reward X":
1. They tap "Redeem" in the app, hand you the 4-digit code that appears.
2. You enter the code at the POS using the rewards redemption tile (front-of-bar terminal).
3. The reward applies to the check; the customer's app shows "Claimed" with a timestamp.

---

## In-app referral push (post-launch, weeks 1–4)

The catalog already has "+50 pts refer a friend" — surface it more aggressively in the first month while customer base is small.

- **Week 1:** push notification to all members at Day 3 — "Know someone who'd love The Quarry? Get +50 pts when they sign up with your code." Use `send-push.js` with `audience: 'all'`.
- **Weeks 2–4:** in-app banner on the Home tab showing each member's share-link with their referral code pre-filled. (Code change required: I'd add a "Share" card next to "Scan Receipt" on the Rewards screen — flag this when ready.)
