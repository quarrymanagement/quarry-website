#!/bin/bash

# ── Restore front-facing site as index.html ──
# The admin panel was uploaded as index.html, pushing the real site to "index (1).html"
# This swaps them back so the public site loads at /
if [ -f "index (1).html" ]; then
  echo "Restoring front-facing site..."
  mv "index.html" "admin-schedule.html"
  mv "index (1).html" "index.html"
  echo "Front-facing site restored as index.html"
fi

# Clean up index (2).html if it exists (duplicate)
if [ -f "index (2).html" ]; then
  rm "index (2).html"
  echo "Removed duplicate index (2).html"
fi

# Inject live Stripe publishable key at build time
if [ ! -z "$STRIPE_PUBLISHABLE_KEY" ]; then
  sed -i "s|__STRIPE_PK__|$STRIPE_PUBLISHABLE_KEY|g" quarry-golf.html
  echo "Stripe key injected"
else
  echo "WARNING: STRIPE_PUBLISHABLE_KEY not set"
fi
