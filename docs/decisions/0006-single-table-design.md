# 0006. One on-demand table, tenant first in every key, tickets not stored

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

The design needs drops, stock shards, holds, buyer limits and orders, with tenant isolation.

## Decision

One DynamoDB table (on-demand) with PK/SK as in `packages/shared/src/keys.ts`, plus a sparse GSI1 holding only active holds by expiry. Tickets are HMAC-signed tokens, not items. The per-buyer limit is a conditional put on its own item at confirmation; holds are keyed by ticket for idempotency.

## Options rejected

- **Ticket items per buyer** — A write per buyer at the busiest moment; the token carries everything the claim needs.
- **Per-buyer limit checked then reserved** — Race between two concurrent claims from one buyer.

## Consequences

DynamoDB TTL is a backstop only; expiry is checked on read and swept by the controller.

## Change from the preliminary report

Refines the preliminary data model; tickets no longer stored.
