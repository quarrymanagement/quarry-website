import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // App-store identifiers (must stay stable for the lifetime of the app —
  // changing these breaks updates and forces a fresh install for every user)
  appId: 'com.thequarrystl.rewards',
  appName: 'Quarry Rewards',

  // The bundled web app — populated by scripts/bundle.js before `npx cap sync`.
  // Bundling (vs. server.url to the live site) is intentional: Apple's
  // Guideline 4.2 rejects pure web wrappers, and a bundled fallback keeps the
  // app usable even if the customer is offline.
  webDir: 'www',

  // iOS-specific settings
  ios: {
    contentInset: 'always',
    // Lock to portrait for now — the rewards app's design is phone-portrait only
    backgroundColor: '#0e0e0e',
  },

  // Android-specific settings
  android: {
    backgroundColor: '#0e0e0e',
    allowMixedContent: false,
  },

  // Plugin defaults
  plugins: {
    PushNotifications: {
      // Show alert+sound+badge when the app is in the foreground
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    Camera: {
      // Receipt-scan uses the rear camera with crop disabled
      androidScaleType: 'CENTER_CROP',
    },
  },
};

export default config;
