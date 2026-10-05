# 0002. Codes are sent with Amazon SES from our own domain, with our own OTP logic

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

Email codes need a sender. SES sandbox only reaches verified addresses (200 a day, 1 per second); production access needs a website URL and a bounce-handling process, usually answered within 24 hours.

## Decision

Buy a cheap domain (about US$10 a year), keep DNS at the registrar (no Route 53 hosted-zone charge), verify it in SES with DKIM, and request production access in week 1. The code is a 6-digit number; its hash, expiry and attempt count live on the hold item. Resend's free tier (3,000 a month, 100 a day) is the fallback behind the same mailer interface.

## Options rejected

- **Twilio Verify email channel** — Per-verification fee for something SES does for US$0.10 per 1,000.
- **Cognito for buyers** — Default Cognito email is capped at 50 a day and turns buyers into accounts, which we do not want.
- **Resend as primary** — 100 a day free limits load tests; weaker AWS story for the report.

## Consequences

One more vendor approval to manage (SES production access). Mitigated by asking early and keeping the fallback.

## Change from the preliminary report

Preliminary report rejected SES because of the approval queue. Re-admitted with the queue started on day 1 and a fallback named.
