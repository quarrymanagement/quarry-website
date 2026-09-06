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
DATA_FILES_REGEX='^(events|bands|members|rewards|menu|credited-orders|scanned-flagged|pending-scans|marketing_drafts|marketing_calendar|marketing_events|marketing_learnings|marketing_crm|marketing_optimization|subscribers|social_drafts|social_calendar|social_events|social_learnings|social_assets|social_optimization|social_event_ideas|reservations|reservations_status|form_submissions|backup_form_submissions|crm_contacts|send_events|email_history|aggregates|inbox|schedule|ai_learnings|toast-discount-map)\.json$'

# What changed since the last commit Netlify actually published?
#
# HEAD^..HEAD only ever sees each commit's own tiny diff, so a real code
# commit gets permanently buried and never evaluated once more data-only
# commits land on top of it before Netlify gets to it. Under a fast, sustained
# flood of data-only commits (e.g. one per marketing email open/click, or
# just steady registration/CRM traffic) this can stall real deploys for days.
#
# A previous fix here tried `${CACHED_COMMIT_REF:-HEAD^}`, assuming Netlify
# populates CACHED_COMMIT_REF with the last-published commit during the
# ignore-command phase. It doesn't (verified: 99 of 100 deploys over the
# following ~24h still failed with "no content change"), so that fix silently
# no-op'd back to plain HEAD^.
#
# Correct fix: ask Netlify's own API what the actually-published commit is,
# and diff against that. NETLIFY_AUTH_TOKEN and SITE_ID are both already
# present in the build environment. If that call fails for any reason
# (missing token, network hiccup, no python3), fall back to a generous fixed
# lookback window instead of HEAD^ — worst case we rebuild a few extra times,
# which is far better than never rebuilding at all.
BASE_REF=""
if [ -n "$NETLIFY_AUTH_TOKEN" ] && [ -n "$SITE_ID" ] && command -v python3 >/dev/null 2>&1; then
    PUBLISHED_REF=$(curl -s -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" \
        "https://api.netlify.com/api/v1/sites/$SITE_ID" 2>/dev/null \
        | python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
    print((d.get('published_deploy') or {}).get('commit_ref') or '')
except Exception:
    pass" 2>/dev/null || echo '')
    if [ -n "$PUBLISHED_REF" ] && git cat-file -e "$PUBLISHED_REF" 2>/dev/null; then
        BASE_REF="$PUBLISHED_REF"
        echo "Diffing against last published commit from Netlify API: $BASE_REF"
    fi
fi

if [ -z "$BASE_REF" ]; then
    BASE_REF="HEAD~200"
    if ! git cat-file -e "$BASE_REF" 2>/dev/null; then
        BASE_REF=$(git rev-list --max-parents=0 HEAD | tail -1)
    fi
    echo "Could not resolve last-published commit via API — using fallback: $BASE_REF"
fi

CHANGED=$(git diff --name-only "$BASE_REF" HEAD 2>/dev/null || echo '')

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
echo "$NON_DATA" | sed 's/^/  - /'
exit 1
