#!/usr/bin/env node
// ============================================================================
// scripts/bundle.js — copy quarry-app-customized.html into mobile/www/index.html
//
// Capacitor wraps whatever is in `webDir` (mobile/www) as the bundled web
// payload. We keep the source-of-truth at the repo root (where the live web
// version is served) and just snapshot it here whenever we want to ship a new
// native build. Run via `npm run sync` from mobile/.
//
// In addition to the file copy, we:
//   1. Strip the PWA manifest <link> — irrelevant inside a native shell.
//
// Note on API base URL: the app code already does
//   const apiBase = location.hostname.includes('thequarrystl.com') ? '' : 'https://thequarrystl.com';
// so when running inside the native wrapper (hostname = localhost or
// capacitor://localhost) it auto-picks the full URL. No injection needed.
// ============================================================================

const fs   = require('fs');
const path = require('path');

const SOURCE = path.resolve(__dirname, '..', '..', 'quarry-app-customized.html');
const TARGET_DIR = path.resolve(__dirname, '..', 'www');
const TARGET = path.join(TARGET_DIR, 'index.html');

if (!fs.existsSync(SOURCE)) {
  console.error('[bundle] ERROR: source not found at', SOURCE);
  process.exit(1);
}

fs.mkdirSync(TARGET_DIR, { recursive: true });

let html = fs.readFileSync(SOURCE, 'utf8');

// Drop the PWA manifest tag (no use inside a native shell)
html = html.replace(/<link\s+rel=["']manifest["'][^>]*>\s*/i, '');

fs.writeFileSync(TARGET, html, 'utf8');
console.log('[bundle] wrote', TARGET, '(' + html.length + ' bytes)');
