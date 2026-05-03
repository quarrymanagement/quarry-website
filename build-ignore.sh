#!/bin/bash
# ============================================================================
# build-ignore.sh — Tell Netlify whether to skip this build.
#
# Exit 0 = SKIP build (no rebuild, no build minutes used).
# Non-zero = PROCEED with build.
#
# WHY THIS EXISTS:
#   Cron-driven Netlify Functions (marketing-poll-stats every 15 min,
#   social-poll-stats every 30 min, sync-form-to-sendgrid on every form
#   submission, etc.) commit small JSON updates back to the repo through
#   data-store.js. Each commit triggered a fresh Netlify deploy — ~96
#   builds/day, eating ~1500 build minutes/month.
#
#   But these data files are read directly from raw.githubusercontent.com
#   by both the public site (events page, bands page) and the admin
#   (loads via data-store.js which also reads from GitHub). They never
#   need to live on the Netlify CDN. Re-deploying the entire site every
#   time a single CRM record updates is pure waste.
#
# LOGIC:
#   If every file changed in this commit is one of our well-known data
#   files, skip the build. Anything else (HTML, CSS, JS, package.json,
#   netlify/functions/*, .toml, .sh) is a real code change and triggers a
#   normal build.
# ============================================================================

set -e

# Whitelist of data files that DON'T need a Netlify rebuild when they change.
# Keep in sync with data-store.js ALLOWED_FILES + a few other auto-written
# files (schedule.json, form submissions, etc.).
DATA_FILES_REGEX='^(events|bands|members|rewards|marketing_drafts|marketing_calendar|marketing_events|marketing_learnings|marketing_crm|marketing_optimization|subscribers|social_drafts|social_calendar|social_events|social_learnings|social_assets|social_optimization|social_event_ideas|reservations|reservations_status|form_submissions|backup_form_submissions|crm_contacts|send_events|email_history|aggregates|inbox|schedule|ai_learnings)\.json$'

# What changed in this commit?
CHANGED=$(git diff --name-only HEAD^ HEAD 2>/dev/null || echo '')

if [ -z "$CHANGED" ]; then
    # Initial commit, force-push, or detached HEAD — we can't tell, so build.
    echo 'No previous commit to compare against — proceeding with build.'
    exit 1
fi

# Find any changed file that is NOT a known data file.
NON_DATA=$(echo "$CHANGED" | grep -vE "$DATA_FILES_REGEX" || true)

if [ -z "$NON_DATA" ]; then
    echo 'All changed files are data-only — skipping Netlify build to save build minutes.'
    echo 'Changed files:'
    echo "$CHANGED" | sed 's/^/  - /'
    exit 0
fi

echo 'Code or template changes detected — proceeding with build.'
echo 'Files needing a rebuild:'
echo "$NON_DATA" | sed 's/