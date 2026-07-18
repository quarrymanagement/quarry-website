#!/bin/bash
set -e

# ── Restore the real public homepage ──
# The Decap CMS admin lives at index.html in the working tree (so it can be
# served from / locally for editing). At deploy time we replace it with the
# real public homepage which is tracked in the repo as homepage.html.
#
# Previously this used `git show <commit>:index.html` which pinned a single
# historical commit and broke any time the homepage was updated. The new
# approach is fully version-controlled and self-documenting.
if [ -f "homepage.html" ]; then
  echo "Restoring main homepage from homepage.html..."
  cp homepage.html index.html
  echo "Main homepage restored: The Quarry | Restaurant, Wine Bar & Live Music"
else
  echo "ERROR: homepage.html missing — cannot restore public homepage" >&2
  exit 1
fi

# Clean up misnamed files if they exist
if [ -f "index (1).html" ]; then
  rm "index (1).html"
  echo "Removed index (1).html (wedding page duplicate)"
fi
if [ -f "index (2).html" ]; then
  rm "index (2).html"
  echo "Removed index (2).html (robots.txt duplicate)"
fi

# Inject live Stripe publishable key at build time
if [ ! -z "$STRIPE_PUBLISHABLE_KEY" ]; then
  sed -i "s|__STRIPE_PK__|$STRIPE_PUBLISHABLE_KEY|g" quarry-golf.html
  echo "Stripe key injected"
else
  echo "WARNING: STRIPE_PUBLISHABLE_KEY not set"
fi

# Inject GA4 Measurement ID across every public page that has the placeholder
if [ ! -z "$GA4_MEASUREMENT_ID" ]; then
  COUNT=$(grep -l "__GA4_MEASUREMENT_ID__" *.html 2>/dev/null | wc -l)
  if [ "$COUNT" -gt 0 ]; then
    sed -i "s|__GA4_MEASUREMENT_ID__|$GA4_MEASUREMENT_ID|g" *.html
    echo "GA4 Measurement ID injected into $COUNT pages ($GA4_MEASUREMENT_ID)"
  else
    echo "GA4 placeholder not found in any HTML file — already injected or pages don't have snippet"
  fi
else
  echo "WARNING: GA4_MEASUREMENT_ID not set — analytics will not collect data"
fi

# ── Site notice banner ──
# Adds notice.js to every public page so hours/event notices only ever need
# editing in ONE file (notice.js) instead of ~30 HTML files. Runs after the
# homepage restore above, so the real index.html gets it too.
#
# Injected into <head> with defer, NOT before </body>. Several pages have no
# </body> at all (homepage.html, quarry-menu.html, quarry-brunch.html,
# quarry-drinks.html, quarry-catering.html, quarry-giftcards.html) and
# homepage.html actually ends mid-script, so anything appended at the end of
# the file would land inside an unclosed <script> and never run. Every page
# has exactly one </head>; defer still runs it after the DOM is parsed.
NOTICE_SKIP="quarry-admin.html quarry-form.html"
NOTICE_COUNT=0
for f in *.html; do
  [ -e "$f" ] || continue
  case " $NOTICE_SKIP " in *" $f "*) continue ;; esac
  # already injected? (idempotent — safe to re-run)
  grep -q 'src="/notice.js"' "$f" && continue
  grep -q '</head>' "$f" || continue
  # the banner attaches itself to <header>; skip pages that have none
  grep -qi '<header' "$f" || continue
  sed -i 's|</head>|<script src="/notice.js" defer></script>\n</head>|' "$f"
  NOTICE_COUNT=$((NOTICE_COUNT + 1))
done
echo "Site notice banner injected into $NOTICE_COUNT pages"
