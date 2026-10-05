# 0004. Payment is delegated through a PayNow handoff; merchants mark orders paid or no-show

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

The preliminary report says payment is delegated; the workflow draft proposed a sandbox payment step.

## Decision

The confirmation screen shows the merchant's PayNow mobile or UEN, the amount and an order reference. The merchant marks each order paid or no-show in the console; the export and report use those states.

## Options rejected

- **Sandbox stub** — Gives merchants in the user study nothing real to reconcile.
- **Stripe test mode** — Card flow contradicts "we take no card data" and adds integration work that does not serve the evaluation.

## Consequences

No card data and no payment cost. Usable in real merchant pilots.

## Change from the preliminary report

Replaces "payment stubbed to a sandbox" in the risk table.
