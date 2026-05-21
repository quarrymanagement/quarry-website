# Quarry Rewards — Store Listing Copy

Use this as the source-of-truth for both **App Store Connect** and **Google Play Console**. Each section maps to a specific field in the store dashboards. Numbers in parentheses are the character limits.

---

## Identifiers

| Field | Value |
|---|---|
| Bundle ID / Application ID | `com.thequarrystl.rewards` |
| Display Name | `Quarry Rewards` |
| Category — primary | Food & Drink |
| Category — secondary | Lifestyle |
| Age rating | 4+ (iOS) / Everyone (Android) — contains no objectionable content. The rewards app references alcohol availability at The Quarry restaurant but does not enable purchase. |
| Languages | English (US) — only |
| Apple Developer Team | Use Matthew's existing Apple Developer Program account |
| Pricing | Free |
| In-App Purchases | None |

---

## App Store Connect

### App Name (30)
`Quarry Rewards`

### Subtitle (30)
`Points for every visit`

### Promotional Text (170 — updatable without a new build)
`Snap your receipt to earn points instantly. Redeem for free pours, entrées, and bucket-of-balls at the indoor golf bays. Members earn 10 pts per $1.`

### Description (4000)
```
Earn rewards at The Quarry — New Melle's restaurant, wine bar, live-music venue, and indoor golf destination.

The Quarry Rewards app lets you earn points every time you stop in for dinner, drinks, brunch, or a round at the Surfside Hole-In-One golf bays. Scan your receipt with one tap, and the points land on your account within minutes.

EARN 10 POINTS PER $1
Every closed tab counts toward your balance — at the bar, in the kitchen, or at the golf bays. Tips go to your server, so they aren't included.

HIGHER TIERS, BIGGER PERKS
- Quarry Standard (1.0× earn)
- Quarry Silver (1.1× earn)
- Quarry Gold (1.25× earn + 5% off bottles + free birthday entrée)
- Quarry Elite (1.5× earn + 10% off bottles + complimentary glass per visit)

REDEEM IN PERSON
Eight rewards to choose from, starting at 500 points:
- Free Bucket of Balls (75 practice balls)
- $10 Off Your Bill
- Free Glass of Wine or Beer
- Free Appetizer (Pretzel, Devils, Wings, or Flatbread)
- $20 Wine Bottle Credit
- Free Entrée + Glass of Wine
- Free Wine Tasting Admission for two
- ... and more

EXTRA WAYS TO EARN
- +10 points every visit (when your closed tab is $20+)
- +250 welcome bonus
- +250 birthday-month visit
- +50 reservation honored
- +25 wine tasting RSVP
- +50 refer a friend (up to 5/year)
- +100 for leaving a public review
- +1,000 for booking a private party

YOUR DASHBOARD
- Real-time points balance and tier status
- Visit history with the points earned per check
- Event RSVPs for monthly wine tastings, live music, and themed nights
- One-tap reservations and golf bay bookings

ABOUT THE QUARRY
3960 Highway Z, New Melle, MO — open Wed–Sat for lunch and dinner, plus Sunday brunch. Chef-crafted Midwest cuisine, an extensive wine and bottle list, live music on the weekends, and four climate-controlled golf simulator bays available year-round.

Visit thequarrystl.com or call (636) 224-8257 to book a reservation.

Must be 21+ to consume alcohol. Please drink responsibly.
```

### Keywords (100, comma-separated)
```
quarry,rewards,restaurant,wine,bar,golf,new melle,missouri,loyalty,points,brunch,live music,events,bay rental
```

### Support URL
`https://thequarrystl.com/quarry-contact.html`

### Marketing URL
`https://thequarrystl.com/`

### Privacy Policy URL
`https://thequarrystl.com/privacy.html`

### What's New (4000 — first release)
`Welcome to The Quarry Rewards. Sign in with your email — no password needed — and start earning 10 points per $1 from your first visit. Scan a receipt to credit your visit instantly, redeem points in person at the bar, and watch your tier climb from Standard up to Elite.`

---

## Google Play Console

### App Title (30)
`Quarry Rewards`

### Short Description (80)
`Earn points and unlock rewards at The Quarry restaurant + golf in New Melle, MO.`

### Full Description (4000)
*Use the same body as the App Store description above — Google Play allows the same text and the same emoji-free formatting reads well in both stores.*

### App Category
Primary: Food & Drink

### Tags
Restaurant Reservations, Loyalty Programs, Wine, Live Music, Golf

### Contact Email
`management@thequarrystl.com`

### Contact Phone
`+1-636-224-8257`

### Contact Website
`https://thequarrystl.com/`

### Privacy Policy URL
`https://thequarrystl.com/privacy.html`

### Content Rating Questionnaire (key answers)
- Does the app contain violence? **No**
- Does the app contain sexual content? **No**
- Does the app contain gambling? **No**
- Does the app reference alcohol, tobacco, or drugs? **Yes — alcohol is served at the venue and referenced in reward descriptions (e.g., "free glass of wine"). The app does not enable purchase of alcohol.**
- Does the app contain user-generated content shared publicly? **No** — all content is curated by management.

### Data Safety Form

Data collected:
- **Personal info:** email address, name (required for sign-in and reservations).
- **Photos:** receipt images for points crediting (uploaded directly to backend, not retained after credit posts).
- **App activity:** in-app interactions (purely on-device, not sent anywhere).
- **App info and performance:** crash logs (Capacitor default, anonymous).

Data shared with third parties:
- **SendGrid** — to send sign-in codes and reward confirmation emails.
- **Square** — for golf bookings (Square handles its own data per Square's privacy policy).
- **Toast** — receipt cross-validation (Toast handles its own data per Toast's privacy policy).

Data encryption in transit: **Yes**
Data deletion request mechanism: **Yes** (email `management@thequarrystl.com`)

---

## Visual Assets Checklist

These are required for submission. C2 generates the screenshots; C3 the privacy policy lives at `privacy.html`; the icon set is already in `mobile/ios/.../Assets.xcassets` and `mobile/android/app/src/main/res`.

| Asset | iOS requirement | Android requirement |
|---|---|---|
| App icon | 1024×1024 PNG (generated, no alpha) | 512×512 PNG (generated) |
| Phone screenshots | 6.7" (1290×2796) — 3 to 10 | Phone (1080×1920) — 2 to 8 |
| Tablet screenshots | 12.9" iPad — optional | Tablet — optional |
| Feature graphic | n/a | 1024×500 PNG |
| Promo video | optional 15–30s preview | optional |
| Splash screen | generated | generated |

---

## Versioning Convention

- **MARKETING_VERSION** (the human-facing version on the App Store): `1.0.0` for launch, semver thereafter.
- **CURRENT_PROJECT_VERSION** (the integer build number Apple uses for upload deduplication): increment every TestFlight upload, never reuse.
- **Android versionCode** + **versionName**: mirror the iOS values. Bump versionCode every release-track upload.
