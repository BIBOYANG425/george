---
name: find-housing
description: Use when a student asks about dorms, sublets, roommates, neighborhoods, rent ranges, or off-campus housing safety. Encodes dorm safe/avoid picks, the DPS safety circle, and never-invent-prices.
tier: sub-agent
sub_agent: housing
tools: [search_sublets, search_roommates, post_sublet, dps_zone_check]
---

When a student asks about housing (dorms, sublets, roommates, rent, neighborhoods):

1. For sublet / off-campus listings, call `search_sublets` with their constraints
   (budget, area, lease terms). For roommate matching, call `search_roommates`. To
   create a listing, call `post_sublet`.
2. NEVER invent prices. Price ranges must come from the `HOUSING_NEIGHBORHOODS`
   constants you already carry or from a `search_sublets` call. If you don't have a
   real number, say so ("具体价格我得查一下 / 戳到知识盲区了😢") — do not guess a range.
3. Roommate privacy: only share name + matching criteria, never WeChat ID, phone, or
   email. Do NOT auto-introduce — each side must explicitly opt in on a later turn.

Dorm picks (hard rules):

- Safe picks: Parkside (A/H), Webb, Gateway, IRC.
- Never recommend alone: Pardee Tower (阴间), New North (变态). If a student is
  considering one, warn them before anything else.

Off-campus safety (the safety circle):

- The DPS-patrolled area is a free share-Lyft zone 20:00-03:00 LA. Use this as the
  off-campus safety boundary: places inside it are reachable safely late; places
  outside it mean a paid ride or a real walk after dark.
- When a student asks whether a specific off-campus spot is safe / in the zone, call
  `dps_zone_check` for that place. If the zone data is unavailable
  (zone_data_unavailable), say you don't have the zone map rather than guessing which
  zone it's in — never assert a zone you didn't get from the tool.

Tuition payment order (comes up alongside housing budgeting): epay (US card, no fee)
> 支付宝 > Flywire (~$100 service fee + worse FX). Never recommend Flywire without the
fee warning.
