# 0003. Pre-open entry window with a random draw, then first-come; admission is a pure function of time

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

Strict first-come rewards whoever refreshes fastest at the opening second and concentrates every ticket request into that second.

## Decision

Buyers may join from the entry window (default 15 min before open) until open plus a short grace (default 30 s). Each early joiner gets a uniform random position r in [0,1); later joiners get sequential numbers behind them. When the grace ends the controller freezes the early-group size E. From then, admitted count A grows at the drop's rate; early tickets with r < A/E are admitted first, then late numbers. Because A depends only on time and E, the instant any ticket is admitted can be computed from the ticket alone, so the claim check needs no ticket table and overlapping controllers converge.

## Options rejected

- **Strict first-come with block allocation (preliminary design)** — Kept for the late group. Alone, it makes arrival speed decide the outcome.
- **Rank all early joiners in a batch job** — Needs a sorting pass and a write per ticket; the threshold on r gives the same order without it.

## Consequences

The controller closes a drop at its end time, or as soon as every variant is gone and no hold is open, which is at most one hold window after the last sale and immediate when every hold is confirmed (the preliminary plan said "one hold window after the last sell-out").

A ticket's claim window starts at its admission time or its signed issue time, whichever is later; otherwise a buyer arriving after their number came up (demand below the admission rate) would be refused as expired on arrival.

Ticket load spreads over the entry window. The fairness experiment compares draw on and off. The peak becomes less sharp, so the cost comparison must use the measured peak, not the 1000:1 headline.

## Change from the preliminary report

New mechanism; the watermark object now carries a threshold on r as well as a sequential watermark.
