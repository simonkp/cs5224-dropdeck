# 0005. A drop has variants; a claim takes one variant

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

Drops often sell sizes or flavours. Mixed baskets would need multi-item transactions.

## Decision

Each variant has its own stock and price and its own sharded counter. One claim reserves one variant, up to the per-buyer limit, as one conditional write.

## Options rejected

- **Mixed baskets** — Need TransactWriteItems and partial-failure handling; lower throughput ceiling.

## Consequences

The no-oversell guarantee still rests on a single conditional write per claim.

## Change from the preliminary report

The preliminary report said "items, quantities" without defining them.
