---
type: research
client: "Gina's Bakery"
website: "https://ginas-bakery.example/"
date: 2026-10-07
model: "qwen3.6:35b-a3b"
confidence: medium
updated: 2026-10-07
---

# Gina's Bakery: research

## Summary

Gina's Bakery is a small artisan sourdough bakery on Hall Street in Bondi Beach, NSW. They produce country loaves, pastries and coffee with a 48-hour sourdough process. Their website has basic information (home, menu, contact) but they currently take orders only via Instagram DM or phone call - they have no online ordering system. The brief confirms they want to move to online orders. Their Instagram link on the site returns a 404 error, suggesting an inactive or broken social presence. This is a clear opportunity for online ordering implementation and Google Business Profile setup to capture local demand.

## The business

- **Industry:** Artisan bakery
- **Location:** Bondi Beach, NSW, Australia
- **Size:** 1 shop, under 10 staff
- **Segment:** small business
- **Web:** https://ginas-bakery.example/

## Digital presence

| Channel | Status | Notes |
|---|---|---|
| Website | found | Functional site at ginas-bakery.example with home, menu and contact pages. Basic info only - no ordering system, limited interactivity. |
| Google Business Profile | not found | Could not verify Google Business Profile status. |
| Instagram | not found | Instagram link on site (@ginasbakerybondi) returns 404 error. Could not verify account existence or activity. |
| Facebook | unknown | Not checked - no Facebook presence mentioned on site. |
| Online ordering | not found | No online ordering found. Orders taken via Instagram DM or phone only. |
| Reviews | unknown | Could not verify review status. |

## Problems found

1. **No online ordering system - orders only via Instagram DM or phone call, creating friction and missed opportunities** (impact: high). Evidence: Brief states they want online orders; contact page says 'To order, message us on Instagram or call the shop'
2. **Instagram link on website returns 404 - broken social presence** (impact: medium). Evidence: Fetching https://instagram.com/ginasbakerybondi returned HTTP 404
3. **Limited website functionality - no menu integration, no contact form, no local SEO optimization visible** (impact: medium). Evidence: Website has only basic home/menu/contact pages with no dynamic features or conversion tools

## Competitors

- **not verified**: No competitors named in brief and none found on fetched pages

## Opportunities for the agency

| Service | Why | Price | Priority |
|---|---|---|---|
| Online ordering | Client explicitly wants online orders; currently loses efficiency taking orders via Instagram DM or phone. An online ordering system would capture orders 24/7, reduce manual work and increase conversion. | $3,000 – $5,000 | high |
| Business website | Current site is basic with no online features. A redesigned site with integrated menu, contact form, Google Business Profile link and mobile optimization would improve local visibility and customer experience. | $1,500 – $2,500 | medium |
| Google Business Profile setup | Cannot verify current GBP status; setting up or optimizing their profile would capture local search traffic from customers looking for bakeries in Bondi. | $300 – $500 | medium |
| Monthly care | Ongoing hosting, updates and small changes would keep the site running smoothly once upgraded with ordering functionality. | $80 – $150 per month | low |

## Questions for the client

1. What is your ideal online ordering workflow? Do you want customers to pay online or order for pickup only?
2. Do you have a Google Business Profile already, and if so who manages it?
3. Is the Instagram account @ginasbakerybondi still active, or should we help reactivate it?
4. What are your peak hours and busiest days, so we can plan capacity for online orders?
5. Do you currently use any POS or inventory system that needs to connect to the online ordering?

## Sources

- https://ginas-bakery.example/: Home page - business description, hours, location, order process
- https://ginas-bakery.example/menu: Menu prices and product range
- https://ginas-bakery.example/contact: Contact details, address, order instructions
- https://instagram.com/ginasbakerybondi: Instagram link verification - returned 404

## Confidence

**medium.** Verified: website content (home, menu, contact pages), address, hours, products and prices from own site. Instagram link confirmed as broken (404). Could not verify Google Business Profile status, review counts, or actual Instagram activity due to 404 and lack of access. No competitors fetched as none were named in brief or found on site.

## Brief

> Gina's Bakery, artisan bakery in Bondi. Site: https://ginas-bakery.example/. They take orders through Instagram DMs and want online orders.

## Run

- Model: qwen3.6:35b-a3b on a local server (http://localhost:11434)
- Steps: 6, pages fetched: 4, duration: 137 s
- Tokens: 6 requests, 3,499 tokens in, 3,996 out, 22,335 read from cache, cost: n/a (no price for this model)
