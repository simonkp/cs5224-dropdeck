# 0015. A public homepage with open sign-up; shops opt in to being listed

- **Status:** Accepted
- **Date:** 2026-10-08
- **Decided by:** Simon, ahead of a domain purchase and a possible STEPS showing

## Context

A new shop could only start by being sent the console link. Nothing explained what DropDeck is, and there was no way
in for a merchant who finds it on their own. We plan to buy a domain and may open DropDeck to visitors at STEPS.

## Decision

- **One public page at `/`:** what DropDeck is, how a drop works (real screenshots of the product), pricing read from
  the same plan data the API enforces, and sign-up. No separate marketing site.
- **Open sign-up:** "Start your shop" opens Cognito's create-account screen; the new shop lands in the console with a
  getting-started checklist (brand it, create a drop, schedule it, share it). Plans and operators (decision 0013)
  are the guard against misuse, not an invite list.
- **"See a live drop" is real:** up to three drops from shops that turned on "List my drops on the DropDeck
  homepage". It is **off by default**: a shop's customers and timing are its own. The list is a cached
  `p/featured.json`, rebuilt from a `FEATURED` partition whenever a listed shop's drop changes, so the homepage
  costs no API call.
- **Domain-ready, not domain-dependent:** the custom domain, SES domain identity and SES sign-up email are optional
  per-stage settings (`docs/domain-setup.md`). Until they are set nothing changes.
- **No made-up numbers:** the page shows no customer counts, quotes or logos we do not have.

## Consequences

- The section hides itself when no shop is listed, so an empty stage still looks finished.
- Cognito's own sender allows about 50 sign-up emails a day; enough for a pilot, not for a STEPS crowd, so sign-up
  email moves to SES once production access is granted.
- Anyone can create a shop. A new shop is on Starter, so the most it can do without an operator is 2 drops and 200
  units a month.

## Change from the preliminary report

New. The report assumed merchants would be recruited and onboarded by the team.
