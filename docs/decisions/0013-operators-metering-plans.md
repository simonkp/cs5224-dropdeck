# 0013. Operators, usage metering and plan limits

- **Status:** Accepted
- **Date:** 2026-10-07
- **Decided by:** Simon, after an architecture review (scaling, cost, what a SaaS provider needs)

## Context

The pricing in decision 0007 could not run:
- Every shop was on `starter`, and no limit was enforced.
- Buyer sessions, the Growth tier's meter, were not recorded.
- DropDeck itself, as the SaaS provider, had no way to see its shops.

The preliminary report also promised per-tenant data deletion.

## Decision

- **Metering:** when the controller finishes a drop, it adds the drop to `T#{tenant} / USAGE#{yyyy-mm}`: drops, cancelled drops, sessions (early + late tickets), orders, units, sales.
  - The month is in Singapore time.
  - A `meteredAt` flag on the drop, set in the same transaction, makes it count once however many ticks finish it.
- **Plans as data:**
  - `packages/shared/src/plans.ts` holds the tiers, their limits and an invoice preview.
  - `/schedule` refuses a drop beyond the plan with `PLAN_LIMIT` (402). Starter allows 2 drops and 200 units a month; drops cancelled before they opened are free.
- **Operators:**
  - A Cognito group `operators` on the same user pool; no second login or pool.
  - A separate `admin-api` function serves `/admin/*` and checks the group on every call.
  - A separate `/ops/` page shows shops, usage, plan and an invoice preview, and lets an operator change a shop's plan.
  - A `TENANTS` registry item per shop lets operators list shops without scanning the table.
- **Destructive jobs are CLI only:** `pnpm ops -- <stage> delete-tenant <id>`, with a typed confirmation, deletes a shop and all its data (PDPA).

## Options rejected

- **An operator tab inside the merchant console** — Operators are not shops. It would also put operator screens in every merchant's bundle.
- **A separate admin user pool or app client** — More config, and Cognito groups already give the role for free.
- **Counting usage from logs** — Logs Insights queries cost money per scan and are not transactional. The usage item is exact and cheap.
- **Taking payment** — Out of scope. The invoice is a preview, and billing integration is future work.

## Consequences

- A drop's usage appears when it finishes, not live.
- Orders confirmed after the close (a hold that outlives it) are not counted. That only ever undercounts, by at most a hold window's worth.
- Plan changes take effect at the next `/schedule`.
- Seeded demo shops are on Growth (Tiong Bahru, Kopi Lab) and Starter (Hue Ceramics), so the limits can be shown.
- `docs/cost-bom.md` takes its measured inputs from the same usage records.

## Change from the preliminary report

New. The report described tiers but not how they would be metered or enforced.
