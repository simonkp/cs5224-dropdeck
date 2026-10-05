# 0001. Buyers verify by email code at checkout, not at the queue

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

The workflow draft (29 Sep) proposed a phone OTP for every buyer before joining the queue, via Twilio Verify.

## Decision

Verification happens after a buyer holds stock, as part of checkout. Each drop sets verification to **Off** or **Email** (default Email). SMS is designed behind the same interface as a paid add-on and priced in the report, but not built.

## Options rejected

- **Phone OTP before the queue (draft P1–P7)** — ~US$0.11 per verification (US$0.05 Verify + US$0.0591 SMS to Singapore) × ~5,000 buyers ≈ US$545 per drop, against S$29–79 a month of revenue. Puts a third-party API on the opening-minute path. Twilio still needs a registered business (UEN or approved Trust Hub profile) to avoid the "Likely-SCAM" sender label.
- **Email OTP at the queue** — Cheap, but verification latency and email deliverability would sit in the opening minute, and the count still scales with the crowd.
- **No verification** — Simplest, but one person with many sessions could take many orders.
- **Email and SMS both built** — Twice the integration work for a channel we cannot send reliably without a UEN.

## Consequences

Verifications are bounded by holds (about 250 for the reference drop), so cost tracks units sold: ~US$0.03 per drop on SES. Email is a weaker identity than phone; we state the residual honestly: extra sessions buy better odds, not more than one order per address.

## Change from the preliminary report

Preliminary report deferred all misuse defences. This brings a per-buyer limit into the core build.
