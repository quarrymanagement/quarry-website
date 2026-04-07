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
