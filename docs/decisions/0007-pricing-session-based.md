# 0007. Growth is priced by buyer sessions, not 1% of drop value

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

Our cost scales with traffic (sessions, admissions, claims), not with the value of goods, and with delegated payment there was no way to collect 1%.

## Decision

Starter S$29/month (2 drops, 200 units). Growth S$79/month with 5,000 buyer sessions included, then S$5 per 1,000. Event S$19 per drop. Sessions are metered from admitted-buyer metrics we already collect for the cost model.

## Options rejected

- **Keep 1% as value capture** — Defensible, but still needs a collection mechanism and does not track cost.

## Consequences

Revenue now moves with the cost driver; the solvency argument in the report gets simpler.

## Change from the preliminary report

Changes the Growth tier and fixes the sentence in §2 claiming the 1% tracks cost.
