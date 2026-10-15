---
type: review
client: "Gina's Bakery"
date: 2026-10-07
language: en
verdict: revise
findings: 3
high: 3
proposal: ""
research: ""
model: "qwen3.6:35b-a3b"
updated: 2026-10-07
---

# Gina's Bakery: review of the proposal

**Verdict: revise.** The proposal scope correctly targets the client's need for online ordering and GBP setup, and prices fit within our standard ranges. However, it contains three revisions needed before sending: the payment terms deviate from the required 50/50 split, it offers a prohibited free trial on care, and it introduces specific technology vendors not listed in our knowledge base.

## Findings (3 high, 0 medium, 0 low)

1. **[high] investment -> payment_terms:** Payment terms do not match agency standards. Evidence: Agency knowledge states '50% to start, 50% on delivery.' The proposal offers '30% deposit to start, 70% on launch.' Fix: Change the payment terms to 50% deposit and 50% on delivery. *(reviewer)*
2. **[high] scope -> Monthly care -> description:** Proposal offers a free trial despite agency policy prohibiting it. Evidence: Agency knowledge states 'No free trials.' The proposal includes: 'The first month is a free trial.' Fix: Remove the free trial and charge for the first month of care. *(reviewer)*
3. **[high] summary; scope -> Online ordering:** Specific technology vendors are named without basis in the knowledge or research. Evidence: The knowledge base and research do not mention Shopify, Stripe, Afterpay, or Klaviyo. They are not standard tools listed in our services. Fix: Remove the specific vendor names (Shopify, Stripe, etc.) and describe the generic capabilities (e.g., 'secure checkout') to avoid committing to unverified tools. *(reviewer)*

## What works

- Pricing for Online Ordering and GBP setup matches the agency's standard price ranges perfectly.
- The scope correctly targets the high-impact business problems: moving orders from Instagram to a website and establishing Google Maps presence.
- The proposed timeline (6 weeks) fits within the 5-to-7 week estimate for an online ordering build.

## What was checked and is fine

- Totals are the correct sum of the core scope items ($3,300 - $5,500).
- Currency is AUD as per agency standard.
- Language is English, consistent with the proposal and brief.

---

- Brief: Gina's Bakery, artisan bakery in Bondi. Site: https://ginas-bakery.example/. They take orders through Instagram DMs and want online orders.
- Model: qwen3.6:35b-a3b on a local server (http://localhost:11434)
- Steps: 2, duration: 224 s
- Tokens: 2 requests, 4,648 tokens in, 5,603 out, 9,283 read from cache, cost: n/a (no price for this model)
