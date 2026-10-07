# 0014. Buyers' order data is deleted 180 days after the drop

- **Status:** Accepted
- **Date:** 2026-10-07
- **Decided by:** Simon, closing the PDPA items promised in the preliminary report

## Context

Orders hold a buyer's name and email. The preliminary report promised purpose-limited consent, a stated retention period and per-tenant deletion. None of these existed, and orders were kept forever.

## Decision

- **Retention:** every order gets a DynamoDB `ttl` set to 180 days after its drop ends, at the moment it is written, so DynamoDB deletes it at no cost. 180 days covers collection, refunds and disputes after a drop.
- **Notice:** checkout says that the name and email go to the shop for this order and are deleted after 180 days, and links to a short `/privacy/` page.
- **Merchants:** the orders screen says that orders are kept for 180 days, and that exporting the CSV keeps them longer under the shop's own policy.
- **Per-tenant deletion:** the operator CLI (decision 0013).

## Options rejected

- **Keep orders until the shop deletes them** — No stated period, and nobody would ever delete them.
- **Delete at drop close plus a few days** — Too short for collection and refunds.
- **A scheduled cleanup job** — DynamoDB TTL does the same at no cost and needs no code.

## Consequences

- Reports for drops older than 180 days lose their order rows. The monthly usage record (decision 0013) keeps the counts, which hold no personal data.
- TTL deletion is not instant; it usually happens within a few days of expiry.
- Orders written before this change have no `ttl`. Staging was reseeded with demo data, so none remain there.

## Change from the preliminary report

As promised in the report; the period is now fixed at 180 days.
