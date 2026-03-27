#!/bin/bash
# Inject live Stripe publishable key at build time
if [ ! -z "$STRIPE_PUBLISHABLE_KEY" ]; then
  sed -i "s|__STRIPE_PK__|$STRIPE_PUBLISHABLE_KEY|g" quarry-golf.html
  echo "Stripe key injected"
else
  echo "WARNING: STRIPE_PUBLISHABLE_KEY not set"
fi
