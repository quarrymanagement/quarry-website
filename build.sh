#!/bin/bash

# ── Restore the real main homepage ──
# The admin panel overwrote index.html. The original homepage lives in git history
# at commit f12f97d. We restore it during build so the public site loads at /
echo "Restoring main homepage from git history..."
git show f12f97d:index.html > index.html
echo "Main homepage restored: The Quarry | Restaurant, Wine Bar & Live Music"

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
