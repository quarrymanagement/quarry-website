#!/usr/bin/env python3
"""One-off data fixes for events.json (2026-10-22). Idempotent.
events.json is rewritten by webhooks constantly, so re-run this on the
freshest copy right before committing instead of rebasing a stale edit.
Usage: python3 scripts/apply-event-fixes-2026-10-22.py events.json
"""
import json, sys
path = sys.argv[1] if len(sys.argv) > 1 else 'events.json'
raw = open(path, encoding='utf-8').read()
d = json.loads(raw)
ev = {e.get('id'): e for e in d.get('events', [])}

# Halloween Day of the Dead: flat $40/person, 7-10 PM, DJ Earl Draper.
h = ev['event_1788301739552']
h['description'] = ("A 21+ Day of the Dead Halloween party with DJ Earl Draper, featured Espol\u00f2n Tequila, "
                    "a costume contest with prizes and Halloween mini games. $40 per person, includes 2 drink tickets.")
h['detailDescription'] = ("Celebrate Halloween Day of the Dead style at The Quarry, 7 to 10 PM. DJ Earl Draper is on the decks "
                          "all night, Espol\u00f2n Tequila is our featured spirit, and there's a costume contest with prizes plus "
                          "Halloween-themed mini games. Tickets are $40 per person and include admission and 2 drink tickets. "
                          "21+ only \u2014 come dressed up and bring your crew.")
h['highlights'] = ["Day of the Dead theme", "DJ Earl Draper", "Featured Espol\u00f2n Tequila",
                   "Costume contest with prizes", "Halloween-themed mini games", "$40 per person",
                   "Includes 2 drink tickets", "21+ event", "7\u201310 PM"]
h['tiers'] = [{"name": "General Admission", "pricePerPerson": 4000, "priceLabel": "$40", "priceUnit": "person"}]
h['pricePerPerson'] = 4000
h['pricePerSeat'] = 4000   # was 5000: event-register.js falls back to this when no tier name is sent
h['price'] = 4000          # was 5000
h['endTime'] = '22:00'

# Wedding Vendor Show (cancelled 2026-08-03). The description's August 29, 2026 is right:
# every vendor email says "Wedding Show Vendor Registration (8/29/26)", and commit 31fd13a75
# (2026-05-08) set date 2026-08-29 on purpose. Later stale-copy saves (81888ecaf, f75b9978a,
# 077750d0f) put 2026-10-29 back. Fix the date, keep the description.
v = ev.get('event_1776713155862')
if v:
    v['date'] = '2026-08-29'

out = json.dumps(d, indent=2, ensure_ascii=False) + ('\n' if raw.endswith('\n') else '')
open(path, 'w', encoding='utf-8').write(out)
print('ok')
