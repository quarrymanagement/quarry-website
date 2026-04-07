#!/usr/bin/env python3
"""
seo_inject.py — Bulk SEO upgrade for The Quarry website.

Idempotently injects per-page meta tags (title, description, canonical,
OpenGraph, Twitter Card, geo) and JSON-LD structured data right after the
existing <title>...</title> tag in each public-facing HTML page.

Re-run safe: looks for <!-- BEGIN SEO --> ... <!-- END SEO --> and
replaces the block in-place, so config edits propagate cleanly.

This is a build-time script, NOT executed at deploy time. It produces
direct file edits that get committed.
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SITE = "https://thequarrystl.com"
SITE_NAME = "The Quarry"
DEFAULT_OG = "https://static.wixstatic.com/media/f1c1b8_c5a995404a4c4e20aa35de83c9c26bfa~mv2.jpg/v1/fill/w_1200,h_630,al_c,q_85/quarry-og.jpg"
PHONE = "+1-636-248-0426"
ADDRESS = {
    "@type": "PostalAddress",
    "streetAddress": "3960 Highway Z",
    "addressLocality": "New Melle",
    "addressRegion": "MO",
    "postalCode": "63385",
    "addressCountry": "US",
}
GEO = {"@type": "GeoCoordinates", "latitude": "38.8192", "longitude": "-90.8683"}
OPENING_HOURS = [
    {"@type": "OpeningHoursSpecification", "dayOfWeek": ["Wednesday", "Thursday"], "opens": "16:00", "closes": "21:00"},
    {"@type": "OpeningHoursSpecification", "dayOfWeek": ["Friday", "Saturday"], "opens": "16:00", "closes": "22:00"},
    {"@type": "OpeningHoursSpecification", "dayOfWeek": "Sunday", "opens": "10:00", "closes": "20:00"},
]
SAME_AS = [
    "https://www.instagram.com/thequarrystl",
    "https://www.facebook.com/profile.php?id=61581374159536",
]

# ---------------------------------------------------------------------------
# Per-page SEO config
# ---------------------------------------------------------------------------
PAGES = {
    "quarry-menu.html": {
        "title": "Menu | Chef-Crafted American Cuisine | The Quarry New Melle MO",
        "description": "Explore The Quarry's full dinner menu — wood-fired steaks, seafood, hand-crafted appetizers and shareable plates. Locally sourced, chef-driven American cuisine in New Melle, Missouri.",
        "slug": "quarry-menu.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Menu", "/quarry-menu.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "Restaurant",
            "@id": f"{SITE}/#restaurant",
            "name": "The Quarry",
            "url": f"{SITE}/quarry-menu.html",
            "telephone": PHONE,
            "priceRange": "$$-$$$",
            "servesCuisine": ["American", "Steakhouse", "Seafood", "Wine Bar"],
            "address": ADDRESS,
            "geo": GEO,
            "openingHoursSpecification": OPENING_HOURS,
            "acceptsReservations": True,
            "hasMenu": {
                "@type": "Menu",
                "@id": f"{SITE}/quarry-menu.html#menu",
                "name": "The Quarry Dinner Menu",
                "inLanguage": "en-US",
                "hasMenuSection": [
                    {"@type": "MenuSection", "name": "Appetizers", "description": "Shareable starters and small plates"},
                    {"@type": "MenuSection", "name": "Salads & Soups"},
                    {"@type": "MenuSection", "name": "Steaks & Chops", "description": "Wood-fired steaks and house-cut chops"},
                    {"@type": "MenuSection", "name": "Seafood"},
                    {"@type": "MenuSection", "name": "Pasta & Entrées"},
                    {"@type": "MenuSection", "name": "Desserts"},
                ],
            },
        }],
    },
    "quarry-drinks.html": {
        "title": "Drink Menu | Wine, Cocktails & Craft Beer | The Quarry New Melle",
        "description": "Curated wine list, hand-shaken cocktails, local craft beer and rotating taps. The Quarry's full drink menu — wine bar and cocktail lounge in New Melle, MO.",
        "slug": "quarry-drinks.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Drinks", "/quarry-drinks.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "BarOrPub",
            "name": "The Quarry Wine Bar",
            "url": f"{SITE}/quarry-drinks.html",
            "telephone": PHONE,
            "priceRange": "$$",
            "address": ADDRESS,
            "geo": GEO,
            "openingHoursSpecification": OPENING_HOURS,
            "hasMenu": {
                "@type": "Menu",
                "name": "The Quarry Drink Menu",
                "inLanguage": "en-US",
                "hasMenuSection": [
                    {"@type": "MenuSection", "name": "Wines by the Glass"},
                    {"@type": "MenuSection", "name": "Wines by the Bottle"},
                    {"@type": "MenuSection", "name": "Signature Cocktails"},
                    {"@type": "MenuSection", "name": "Craft Beer & Local Taps"},
                    {"@type": "MenuSection", "name": "Spirits"},
                    {"@type": "MenuSection", "name": "Non-Alcoholic"},
                ],
            },
        }],
    },
    "quarry-brunch.html": {
        "title": "Sunday Brunch | Bottomless Mimosas & Live Music | The Quarry MO",
        "description": "Sunday brunch at The Quarry — chef-crafted brunch classics, bottomless mimosas, live acoustic music, and waterfront patio seating in New Melle, Missouri.",
        "slug": "quarry-brunch.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Sunday Brunch", "/quarry-brunch.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "Restaurant",
            "name": "The Quarry — Sunday Brunch",
            "url": f"{SITE}/quarry-brunch.html",
            "telephone": PHONE,
            "priceRange": "$$",
            "servesCuisine": ["Brunch", "American"],
            "address": ADDRESS,
            "geo": GEO,
            "openingHoursSpecification": [
                {"@type": "OpeningHoursSpecification", "dayOfWeek": "Sunday", "opens": "10:00", "closes": "14:00"}
            ],
            "hasMenu": {
                "@type": "Menu",
                "name": "Sunday Brunch Menu",
                "inLanguage": "en-US",
                "hasMenuSection": [
                    {"@type": "MenuSection", "name": "Brunch Classics"},
                    {"@type": "MenuSection", "name": "Eggs Benedict & Skillets"},
                    {"@type": "MenuSection", "name": "Sweets"},
                    {"@type": "MenuSection", "name": "Brunch Cocktails", "description": "Bottomless mimosas, bloody marys, and signature brunch drinks"},
                ],
            },
        }],
    },
    "quarry-catering.html": {
        "title": "Catering | On & Off-Site Catering Services | The Quarry New Melle MO",
        "description": "Full-service catering from The Quarry — weddings, corporate events, private parties. Customizable menus, on-site and off-site catering throughout the St. Louis metro and St. Charles County.",
        "slug": "quarry-catering.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Catering", "/quarry-catering.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "Service",
            "name": "The Quarry Catering",
            "serviceType": "Catering",
            "url": f"{SITE}/quarry-catering.html",
            "provider": {
                "@type": "Restaurant",
                "@id": f"{SITE}/#restaurant",
                "name": "The Quarry",
                "telephone": PHONE,
                "address": ADDRESS,
            },
            "areaServed": [
                {"@type": "City", "name": "New Melle", "addressRegion": "MO"},
                {"@type": "City", "name": "Defiance", "addressRegion": "MO"},
                {"@type": "City", "name": "Wentzville", "addressRegion": "MO"},
                {"@type": "City", "name": "St. Charles", "addressRegion": "MO"},
                {"@type": "City", "name": "O'Fallon", "addressRegion": "MO"},
                {"@type": "City", "name": "St. Louis", "addressRegion": "MO"},
            ],
            "hasOfferCatalog": {
                "@type": "OfferCatalog",
                "name": "Catering Services",
                "itemListElement": [
                    {"@type": "Offer", "itemOffered": {"@type": "Service", "name": "Wedding Catering"}},
                    {"@type": "Offer", "itemOffered": {"@type": "Service", "name": "Corporate Catering"}},
                    {"@type": "Offer", "itemOffered": {"@type": "Service", "name": "Private Party Catering"}},
                    {"@type": "Offer", "itemOffered": {"@type": "Service", "name": "Drop-Off Catering"}},
                    {"@type": "Offer", "itemOffered": {"@type": "Service", "name": "Full-Service Catering"}},
                ],
            },
        }],
    },
    "quarry-events.html": {
        "title": "Events Calendar | Live Music, Bingo & Special Events | The Quarry",
        "description": "Upcoming events at The Quarry in New Melle, MO — live music nights, music bingo, themed dinners, fundraisers, and seasonal celebrations. Reserve your spot today.",
        "slug": "quarry-events.html",
        "og_image": "https://static.wixstatic.com/media/f1c1b8_c5a995404a4c4e20aa35de83c9c26bfa~mv2.jpg/v1/fill/w_1200,h_630,al_c,q_85/quarry-events.jpg",
        "breadcrumbs": [("Home", "/"), ("Events Calendar", "/quarry-events.html")],
        # Event schema injected dynamically in build_event_schemas()
        "extra_schema": "EVENTS_DYNAMIC",
        "faqs": [
            ("How do I buy tickets for events at The Quarry?",
             "Tickets for ticketed events at The Quarry can be purchased directly on this page by clicking 'Register' on the event you want to attend. You'll be taken to a secure Stripe checkout. Walk-in events are first-come, first-served — no ticket required."),
            ("Are events at The Quarry family friendly?",
             "Most events at The Quarry are 21+, but family-friendly afternoon events and Sunday brunch with live music are open to all ages. Each event listing notes any age restrictions."),
            ("Do I need a reservation to come for live music?",
             "Live music nights are open to walk-ins, but tables fill up fast — especially on Friday and Saturday evenings. We recommend booking a table on the Reservations page to guarantee seating."),
            ("Can I host my own private event at The Quarry?",
             "Yes. The Quarry hosts corporate dinners, birthday parties, rehearsal dinners, and milestone celebrations. Visit the Private Events page or call 636-248-0426 to inquire about availability."),
            ("Where is The Quarry located?",
             "The Quarry is at 3960 Highway Z, New Melle, Missouri 63385 — about 15 minutes from Wentzville and 30 minutes from St. Charles, in the heart of Defiance wine country.")
        ],
    },
    "quarry-bands.html": {
        "title": "Live Bands & Music Schedule | The Quarry New Melle, Missouri",
        "description": "Weekly live music at The Quarry — local and regional bands, acoustic afternoons, evening shows. See this week's lineup and plan your visit to New Melle, Missouri.",
        "slug": "quarry-bands.html",
        "og_image": "https://static.wixstatic.com/media/f1c1b8_c5a995404a4c4e20aa35de83c9c26bfa~mv2.jpg/v1/fill/w_1200,h_630,al_c,q_85/quarry-bands.jpg",
        "breadcrumbs": [("Home", "/"), ("Live Bands", "/quarry-bands.html")],
        "extra_schema": "BANDS_DYNAMIC",
    },
    "quarry-wineclub.html": {
        "title": "Rock & Vine Wine Club | Monthly Wine Membership | The Quarry MO",
        "description": "Join The Quarry's Rock & Vine Wine Club — curated monthly wine selections, exclusive member events, tasting nights, and discounts. New Melle, Missouri's premier wine club.",
        "slug": "quarry-wineclub.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Rock & Vine Wine Club", "/quarry-wineclub.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "Service",
            "name": "Rock & Vine Wine Club",
            "serviceType": "Wine Club Membership",
            "url": f"{SITE}/quarry-wineclub.html",
            "provider": {
                "@type": "Restaurant",
                "@id": f"{SITE}/#restaurant",
                "name": "The Quarry",
                "telephone": PHONE,
                "address": ADDRESS,
            },
            "description": "Monthly curated wine club with member-only tastings, events, and discounts at The Quarry in New Melle, Missouri.",
        }],
    },
    "quarry-beergarden.html": {
        "title": "Beer Garden | Outdoor Patio & Craft Beer | The Quarry New Melle",
        "description": "The Quarry's outdoor beer garden — coming 2026. Local craft taps, lakeside patio seating, casual eats, and live music in New Melle, Missouri.",
        "slug": "quarry-beergarden.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Beer Garden", "/quarry-beergarden.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "BarOrPub",
            "name": "The Quarry Beer Garden",
            "url": f"{SITE}/quarry-beergarden.html",
            "telephone": PHONE,
            "priceRange": "$$",
            "address": ADDRESS,
            "geo": GEO,
            "description": "Outdoor lakeside beer garden with local craft taps, casual fare, and live music — opening 2026 at The Quarry in New Melle, Missouri.",
        }],
    },
    "quarry-golf.html": {
        "title": "Indoor Golf Simulators | Hole-In-One Golf | The Quarry New Melle",
        "description": "Hole-In-One Golf at The Quarry — state-of-the-art TrackMan indoor golf simulators, leagues, lessons, and private bay rentals. Year-round golf in New Melle, Missouri.",
        "slug": "quarry-golf.html",
        "og_image": "https://static.wixstatic.com/media/f1c1b8_c5a995404a4c4e20aa35de83c9c26bfa~mv2.jpg/v1/fill/w_1200,h_630,al_c,q_85/quarry-golf.jpg",
        "breadcrumbs": [("Home", "/"), ("Hole-In-One Golf", "/quarry-golf.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": ["SportsActivityLocation", "GolfCourse"],
            "name": "Hole-In-One Golf at The Quarry",
            "url": f"{SITE}/quarry-golf.html",
            "telephone": PHONE,
            "priceRange": "$$",
            "address": ADDRESS,
            "geo": GEO,
            "description": "Indoor golf simulator bays with TrackMan technology, year-round leagues, private events, and lessons at The Quarry in New Melle, Missouri.",
            "amenityFeature": [
                {"@type": "LocationFeatureSpecification", "name": "TrackMan Simulators", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Private Bay Rentals", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Leagues & Tournaments", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Food & Drink Service", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Climate Controlled", "value": True},
            ],
            "openingHoursSpecification": OPENING_HOURS,
        }],
        "faqs": [
            ("How much does it cost to rent a golf bay at The Quarry?",
             "Hole-In-One Golf bay rentals at The Quarry start at competitive hourly rates and can be booked by the hour. Pricing varies by time of day and bay availability — visit the Reservations page or call 636-248-0426 for current rates."),
            ("How many people can fit in one golf bay?",
             "Each TrackMan simulator bay at The Quarry comfortably accommodates up to 6 players, making it ideal for friend groups, family outings, date nights, or small private parties."),
            ("Do you serve food and drinks in the golf bays?",
             "Yes. The Quarry provides full food and drink service directly to the golf bays. You can order from our menu — appetizers, entrées, wine, cocktails, and craft beer — all without leaving your simulator."),
            ("What golf simulator technology do you use?",
             "Hole-In-One Golf at The Quarry uses TrackMan simulators, the same launch monitor technology used by PGA Tour professionals. Play famous courses, work on your swing, or compete in skills challenges."),
            ("Do you offer leagues or lessons?",
             "Yes. The Quarry runs year-round indoor golf leagues and offers private lessons. Contact us at 636-248-0426 or visit the Hole-In-One Golf page for the current league schedule."),
            ("Can I book a golf bay for a private event?",
             "Absolutely. Golf bays are perfect for corporate events, birthday parties, bachelor/bachelorette parties, and team-building. Bays can be reserved in advance through the Reservations page or by calling 636-248-0426.")
        ],
    },
    "quarry-reservations.html": {
        "title": "Reservations | Book a Table or Bay | The Quarry New Melle MO",
        "description": "Reserve your table, golf bay, or private dining experience at The Quarry in New Melle, Missouri. Online booking for dinner, brunch, events, and golf simulators.",
        "slug": "quarry-reservations.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Reservations", "/quarry-reservations.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "ReserveAction",
            "name": "Book a Reservation at The Quarry",
            "target": {
                "@type": "EntryPoint",
                "urlTemplate": f"{SITE}/quarry-reservations.html",
                "inLanguage": "en-US",
                "actionPlatform": ["http://schema.org/DesktopWebPlatform", "http://schema.org/MobileWebPlatform"],
            },
            "result": {"@type": "Reservation", "name": "Restaurant or Golf Bay Reservation"},
        }],
    },
    "quarry-private-events.html": {
        "title": "Private Events | Corporate, Birthday & Rehearsal Dinners | The Quarry",
        "description": "Host your private event at The Quarry — corporate dinners, birthday parties, rehearsal dinners, holiday gatherings. Customizable menus and dedicated event spaces in New Melle, MO.",
        "slug": "quarry-private-events.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Private Events", "/quarry-private-events.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "EventVenue",
            "name": "The Quarry Private Events",
            "url": f"{SITE}/quarry-private-events.html",
            "telephone": PHONE,
            "address": ADDRESS,
            "geo": GEO,
            "description": "Private event venue for corporate dinners, rehearsal dinners, birthday parties, holiday gatherings, and milestone celebrations in New Melle, Missouri.",
            "maximumAttendeeCapacity": 200,
            "amenityFeature": [
                {"@type": "LocationFeatureSpecification", "name": "Private Dining Rooms", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Customizable Menus", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Audio/Visual Equipment", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "Dedicated Event Coordinator", "value": True},
                {"@type": "LocationFeatureSpecification", "name": "On-Site Parking", "value": True},
            ],
        }],
    },
    "quarry-ourstory.html": {
        "title": "Our Story | The Quarry — A New Melle, Missouri Original",
        "description": "The story behind The Quarry — a 26-acre lakeside restaurant, wine bar, and event venue in New Melle, Missouri. Family-owned, chef-driven, community-rooted.",
        "slug": "quarry-ourstory.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Our Story", "/quarry-ourstory.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "AboutPage",
            "name": "Our Story | The Quarry",
            "url": f"{SITE}/quarry-ourstory.html",
            "mainEntity": {"@id": f"{SITE}/#restaurant"},
        }],
    },
    "quarry-contact.html": {
        "title": "Contact The Quarry | Hours, Directions & Phone | New Melle MO",
        "description": "Contact The Quarry in New Melle, Missouri — phone, email, hours, directions, and reservations. We're at 3960 Highway Z, just minutes from Wentzville and Defiance wine country.",
        "slug": "quarry-contact.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Contact", "/quarry-contact.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "ContactPage",
            "name": "Contact The Quarry",
            "url": f"{SITE}/quarry-contact.html",
            "mainEntity": {"@id": f"{SITE}/#restaurant"},
        }],
    },
    "quarry-press.html": {
        "title": "Press & Media | The Quarry New Melle, Missouri",
        "description": "Press releases, media coverage, and brand assets for The Quarry — restaurant, wine bar, and live music venue in New Melle, Missouri.",
        "slug": "quarry-press.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Press & Media", "/quarry-press.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": "Press & Media | The Quarry",
            "url": f"{SITE}/quarry-press.html",
        }],
    },
    "quarry-careers.html": {
        "title": "Careers | Now Hiring | The Quarry New Melle, Missouri",
        "description": "Join the team at The Quarry. Now hiring servers, bartenders, line cooks, hosts, and event staff in New Melle, Missouri. Apply today.",
        "slug": "quarry-careers.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Careers", "/quarry-careers.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "Careers at The Quarry",
            "url": f"{SITE}/quarry-careers.html",
            "mainEntity": {
                "@type": "Organization",
                "name": "The Quarry",
                "url": SITE,
                "telephone": PHONE,
                "address": ADDRESS,
            },
        }],
    },
    "quarry-event-detail.html": {
        "title": "Event Details | The Quarry New Melle, Missouri",
        "description": "Event details, schedule, ticketing, and registration for upcoming events at The Quarry — restaurant, wine bar, and live music venue in New Melle, Missouri.",
        "slug": "quarry-event-detail.html",
        "og_image": "https://static.wixstatic.com/media/f1c1b8_c5a995404a4c4e20aa35de83c9c26bfa~mv2.jpg/v1/fill/w_1200,h_630,al_c,q_85/quarry-events.jpg",
        "breadcrumbs": [("Home", "/"), ("Events", "/quarry-events.html"), ("Event Details", "/quarry-event-detail.html")],
        "extra_schema": [],
    },
    "quarry-giftcards.html": {
        "title": "Gift Cards | Restaurant, Golf & Wine | The Quarry New Melle MO",
        "description": "Give the gift of The Quarry — gift cards good for dining, drinks, golf simulators, brunch, and events. Available in any amount. Buy online or in person in New Melle, MO.",
        "slug": "quarry-giftcards.html",
        "og_image": DEFAULT_OG,
        "breadcrumbs": [("Home", "/"), ("Gift Cards", "/quarry-giftcards.html")],
        "extra_schema": [{
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "The Quarry Gift Card",
            "description": "Gift card valid for dining, drinks, golf simulator bays, brunch, and events at The Quarry in New Melle, Missouri.",
            "url": f"{SITE}/quarry-giftcards.html",
            "brand": {"@type": "Brand", "name": "The Quarry"},
            "offers": {
                "@type": "AggregateOffer",
                "lowPrice": "25",
                "highPrice": "500",
                "priceCurrency": "USD",
                "availability": "https://schema.org/InStock",
                "url": f"{SITE}/quarry-giftcards.html",
            },
        }],
    },
}


# ---------------------------------------------------------------------------
# Dynamic schema builders (events.json driven)
# ---------------------------------------------------------------------------
def parse_event_date(name, date_str, time_str):
    """Best-effort parse of human-readable date+time → ISO 8601."""
    import datetime as dt
    try:
        # date_str like "Friday, April 3, 2026"; time_str like "6:00 PM"
        date_part = date_str.split(",", 1)[1].strip() if "," in date_str else date_str
        # date_part like "April 3, 2026"
        d = dt.datetime.strptime(date_part, "%B %d, %Y")
        if time_str:
            t = dt.datetime.strptime(time_str.strip().upper(), "%I:%M %p").time()
            d = d.replace(hour=t.hour, minute=t.minute)
        return d.strftime("%Y-%m-%dT%H:%M:00-05:00")  # Central
    except Exception:
        return None


def build_event_schemas():
    """Read events.json and emit a list of Event JSON-LD objects + ItemList wrapper."""
    try:
        data = json.load(open(ROOT / "events.json"))
    except Exception:
        return []
    events = data.get("events", [])
    items = []
    list_items = []
    for i, e in enumerate(events, start=1):
        start = parse_event_date(e.get("name", ""), e.get("date", ""), e.get("time", ""))
        if not start:
            continue
        sold_out = e.get("status") == "sold-out"
        price = e.get("pricePerSeat") or e.get("pricePerTable") or 0
        price_dollars = f"{price/100:.2f}" if price else "0.00"
        ev = {
            "@context": "https://schema.org",
            "@type": "Event",
            "name": e.get("name", "The Quarry Event"),
            "startDate": start,
            "eventStatus": "https://schema.org/EventScheduled",
            "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
            "description": (e.get("description") or "")[:500],
            "image": [DEFAULT_OG],
            "location": {
                "@type": "Place",
                "name": "The Quarry",
                "address": ADDRESS,
                "geo": GEO,
            },
            "organizer": {
                "@type": "Organization",
                "name": "The Quarry",
                "url": SITE,
                "telephone": PHONE,
            },
            "offers": {
                "@type": "Offer",
                "url": f"{SITE}/quarry-events.html#{e.get('id','')}",
                "price": price_dollars,
                "priceCurrency": "USD",
                "availability": "https://schema.org/SoldOut" if sold_out else "https://schema.org/InStock",
                "validFrom": start,
            },
            "performer": {"@type": "PerformingGroup", "name": e.get("name", "The Quarry")},
        }
        items.append(ev)
        list_items.append({
            "@type": "ListItem",
            "position": i,
            "url": f"{SITE}/quarry-events.html#{e.get('id','')}",
            "name": e.get("name", ""),
        })
    if items:
        items.append({
            "@context": "https://schema.org",
            "@type": "ItemList",
            "name": "The Quarry Upcoming Events",
            "url": f"{SITE}/quarry-events.html",
            "numberOfItems": len(list_items),
            "itemListElement": list_items,
        })
    return items


def build_band_schemas():
    """Read bands from events.json and emit MusicEvent JSON-LD objects."""
    try:
        data = json.load(open(ROOT / "events.json"))
    except Exception:
        return []
    bands = data.get("bands", [])
    items = []
    list_items = []
    for i, b in enumerate(bands, start=1):
        date_str = b.get("date", "")  # "2026-03-27"
        slot = b.get("timeSlot", "")  # "7 PM - 10 PM"
        # parse start time from slot
        import re as _re
        m = _re.match(r"(\d+)\s*(AM|PM)", slot, _re.I)
        try:
            import datetime as dt
            d = dt.datetime.strptime(date_str, "%Y-%m-%d")
            if m:
                hr = int(m.group(1))
                if m.group(2).upper() == "PM" and hr != 12:
                    hr += 12
                d = d.replace(hour=hr)
            start_iso = d.strftime("%Y-%m-%dT%H:00:00-05:00")
        except Exception:
            continue
        ev = {
            "@context": "https://schema.org",
            "@type": "MusicEvent",
            "name": f"{b.get('name','Live Music')} at The Quarry",
            "startDate": start_iso,
            "eventStatus": "https://schema.org/EventScheduled",
            "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
            "description": f"Live music featuring {b.get('name','')} at The Quarry in New Melle, Missouri. {slot}.",
            "image": [DEFAULT_OG],
            "location": {
                "@type": "Place",
                "name": "The Quarry",
                "address": ADDRESS,
                "geo": GEO,
            },
            "organizer": {"@type": "Organization", "name": "The Quarry", "url": SITE, "telephone": PHONE},
            "performer": {"@type": "MusicGroup", "name": b.get("name", "")},
            "offers": {
                "@type": "Offer",
                "url": f"{SITE}/quarry-bands.html",
                "price": "0",
                "priceCurrency": "USD",
                "availability": "https://schema.org/InStock",
                "validFrom": start_iso,
            },
        }
        items.append(ev)
        list_items.append({"@type": "ListItem", "position": i, "name": ev["name"], "url": f"{SITE}/quarry-bands.html"})
    if items:
        items.append({
            "@context": "https://schema.org",
            "@type": "ItemList",
            "name": "Upcoming Live Music at The Quarry",
            "url": f"{SITE}/quarry-bands.html",
            "numberOfItems": len(list_items),
            "itemListElement": list_items,
        })
    return items


# ---------------------------------------------------------------------------
# Block builders
# ---------------------------------------------------------------------------
BEGIN_MARK = "<!-- BEGIN SEO (auto-injected by seo_inject.py) -->"
END_MARK = "<!-- END SEO -->"


def html_escape(s):
    return (s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;"))


def build_block(cfg):
    title = cfg["title"]
    desc = cfg["description"]
    slug = cfg["slug"]
    canonical = f"{SITE}/{slug}"
    og_image = cfg.get("og_image", DEFAULT_OG)
    bread = cfg.get("breadcrumbs", [])

    breadcrumb_schema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": name, "item": f"{SITE}{path}"}
            for i, (name, path) in enumerate(bread)
        ],
    }
    schemas = [breadcrumb_schema]
    extra = cfg.get("extra_schema")
    if extra == "EVENTS_DYNAMIC":
        schemas.extend(build_event_schemas())
    elif extra == "BANDS_DYNAMIC":
        schemas.extend(build_band_schemas())
    elif isinstance(extra, list):
        schemas.extend(extra)

    faqs = cfg.get("faqs")
    if faqs:
        schemas.append({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": q,
                 "acceptedAnswer": {"@type": "Answer", "text": a}}
                for q, a in faqs
            ],
        })

    schema_blocks = "\n".join(
        f'<script type="application/ld+json">{json.dumps(s, ensure_ascii=False, separators=(",", ":"))}</script>'
        for s in schemas
    )

    return f"""{BEGIN_MARK}
<meta name="description" content="{html_escape(desc)}">
<link rel="canonical" href="{canonical}">
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
<meta name="author" content="The Quarry">
<meta name="geo.region" content="US-MO">
<meta name="geo.placename" content="New Melle">
<meta name="geo.position" content="38.8192;-90.8683">
<meta name="ICBM" content="38.8192, -90.8683">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{SITE_NAME}">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="{html_escape(title)}">
<meta property="og:description" content="{html_escape(desc)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{html_escape(title)}">
<meta name="twitter:description" content="{html_escape(desc)}">
<meta name="twitter:image" content="{og_image}">
{schema_blocks}
{END_MARK}"""


# ---------------------------------------------------------------------------
# File rewriter
# ---------------------------------------------------------------------------
TITLE_RE = re.compile(r"<title[^>]*>.*?</title>", re.IGNORECASE | re.DOTALL)
SEO_BLOCK_RE = re.compile(
    re.escape(BEGIN_MARK) + r".*?" + re.escape(END_MARK),
    re.DOTALL,
)


def process_file(path: Path, cfg: dict):
    html = path.read_text(encoding="utf-8", errors="replace")
    new_title_tag = f"<title>{html_escape(cfg['title'])}</title>"
    new_block = build_block(cfg)

    # Step 1: replace existing title
    if TITLE_RE.search(html):
        html = TITLE_RE.sub(new_title_tag, html, count=1)
    else:
        # Insert title right after <head>
        html = re.sub(r"(<head[^>]*>)", r"\1\n" + new_title_tag, html, count=1, flags=re.I)

    # Step 2: idempotently replace or insert SEO block right after the title
    if SEO_BLOCK_RE.search(html):
        html = SEO_BLOCK_RE.sub(new_block, html, count=1)
    else:
        html = html.replace(new_title_tag, new_title_tag + "\n" + new_block, 1)

    path.write_text(html, encoding="utf-8")


def main():
    only = set(sys.argv[1:]) or None
    for slug, cfg in PAGES.items():
        if only and slug not in only:
            continue
        p = ROOT / slug
        if not p.exists():
            print(f"SKIP missing: {slug}", file=sys.stderr)
            continue
        process_file(p, cfg)
        print(f"Updated: {slug}")


if __name__ == "__main__":
    main()
