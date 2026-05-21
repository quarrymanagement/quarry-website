# Quarry Rewards — Native App Wrappers

This folder wraps the existing customer rewards web app (`/quarry-app-customized.html` at the repo root) in a Capacitor shell so it can ship to the App Store + Google Play.

The web version is unchanged. Both native builds load a snapshot of the same HTML, and all API calls still hit the live `thequarrystl.com` Netlify functions.

## Layout

```
mobile/
├── capacitor.config.ts     ← app ID, name, plugin defaults
├── scripts/bundle.js       ← copies quarry-app-customized.html → www/index.html
├── www/                    ← bundled web payload (generated, gitignored output dir)
├── ios/                    ← Xcode project — build on a Mac
├── android/                ← Android Studio / Gradle project — build anywhere
└── package.json            ← Capacitor + plugin deps
```

App identifiers (don't change these — they're permanent once an app is on a store):

- **Bundle ID / App ID:** `com.thequarrystl.rewards`
- **Display Name:** `Quarry Rewards`

## Day-to-day workflow

After any change to the web app (`quarry-app-customized.html`):

```bash
cd mobile
npm run sync         # rebundles + runs `npx cap sync` to push to both platforms
```

Then:
- **iOS:** `npm run open:ios` — opens the Xcode project, hit Cmd-R to run on simulator or device.
- **Android:** `npm run open:android` — opens Android Studio, hit ▶ to run.

## First-time build setup

### iOS (Mac with Xcode required)

1. Install Xcode 15+ from the App Store.
2. Install CocoaPods: `sudo gem install cocoapods` (only needed once).
3. From `mobile/ios/App`: `pod install`.
4. Open `ios/App/App.xcworkspace` in Xcode.
5. Select the "App" target → **Signing & Capabilities** → set Team to your existing Apple Developer Program team. Xcode will auto-generate provisioning. Bundle ID is already `com.thequarrystl.rewards`.
6. Connect an iPhone via USB or pick a simulator and hit Cmd-R.

### Android (any OS — Mac, Windows, Linux)

1. Install Android Studio.
2. Open `mobile/android/` in Android Studio. It'll prompt to install missing SDKs — accept all.
3. Plug in an Android device with USB debugging enabled (or use the emulator).
4. Hit the ▶ Run button.

## Native features wired in

These Capacitor plugins are installed and synced:

- **@capacitor/camera** — for the receipt scanner (B2 in `LAUNCH_PLAN.md`: still uses the web `<input type=file>` today; the native upgrade swaps to the Camera API for a one-tap experience).
- **@capacitor/push-notifications** — for "your points are about to expire", "new reward", tier upgrades (B4: backend wiring still pending).
- **@capacitor/preferences** — secure key-value for the session token, replacing localStorage in the native build.

## Building for the stores

### iOS (TestFlight + App Store)

```bash
cd mobile
npm run sync
npm run open:ios
```

In Xcode:
- Set the version + build number in **General** → **Identity**.
- Product → **Archive** → distribute via **App Store Connect** → upload.
- A few minutes later it appears in App Store Connect → TestFlight. Test, then submit for review.

### Android (Google Play)

```bash
cd mobile
npm run sync
cd android
./gradlew bundleRelease    # produces app/build/outputs/bundle/release/app-release.aab
```

Upload the `.aab` to Google Play Console → your app → internal testing track first, then production.

**Important:** the first time you build for release, Android Studio will prompt you to generate a keystore. **Back this up in a password manager immediately** — losing it means you can never update the app on Play; you'd have to publish a new app with a new package ID.

## Why this lives in `mobile/` and not at the repo root

The repo root's `package.json` powers the Netlify Functions deploy. Mixing Capacitor + Capacitor plugin deps in there would inflate every function build with ~90 extra packages. Keeping the mobile project as a sibling subproject means:

- Netlify deploys are unaffected (the functions build ignores `mobile/`).
- The mobile project has its own `node_modules`, lockfile, and config.
- The web app continues to live at the repo root unchanged.
