# Joining under load: problem, change and test results

Branch `fw/join-under-load`. Measured on `dev-fw` with `eval/load.ts`, 13–19 Oct 2026.

## The problem

When a crowd taps Join together, the ticket function needs one Lambda copy per join in progress. A new copy takes about 1.25 s to answer its first request, so a crowd of about 320 joins a second used up the account's 400 copies. Those 400 are shared by every stage (`staging`, `dev-simon`, `dev-fw`). Once they were used up:

- **Joins were refused** with 503. On the reference crowd 17–41% of joins failed, and up to 148 buyers never got a ticket even after six tries. The real page did not retry, so each refused buyer saw an error.
- **The draw counted buyers who don't exist.** The ticket function added the buyer to the draw before looking up its signing key. When the lookup was refused, the buyer got an error but kept their place. One run left 2,394 such places, which held up admission for real buyers.
- **Other stages stalled.** While the run held all 400 copies, no function in any stage could start.

## The change

1. **Key first.** The ticket function fetches its signing key before writing to the draw, so a failed join leaves nothing behind (`services/ticket/src/handler.ts`).
2. **Cap on ticket copies.** The new `ticketConcurrency` setting reserves and limits the ticket function's copies. No stage sets it. Set it per stage in `infra/cdk.json` under `stageSettings`, or with `-c ticketConcurrency=128` on deploy, as the tests below did on `dev-fw`. Joins over the cap are refused with 503 before any code runs (`infra/lib/dropdeck-stack.ts`).
3. **The page retries.** A join refused with 429 or 5xx, or a dropped connection, is retried up to 5 times with growing, randomised pauses (`apps/web/app/d/buyer.ts`, `joinRetryMs`).
4. **The page spreads joins.** A join made before the draw waits a random 0–10 s first, and the page says "no rush". Places in the draw are random, so the delay costs the buyer nothing (decision 0003). Joins after the draw are sent at once (`joinSpreadMs`).

Cost: nothing extra. Reserved concurrency has no charge, and retries add a few thousand API calls per drop.

## How it was tested

- **Workload:** a real scheduled drop with 200 units and 5,000 buyers (the reference crowd, "1×"). Half the buyers arrive in the first 5 s, 20% after the draw, and the rest in between. Each buyer joins, waits for their turn, claims and confirms.
- **Cold starts:** every run was 15 minutes after the previous one, so it started with no warm copies. This was confirmed from AWS's own figures in each result. Runs that started warm, or where the test laptop slept, were discarded.
- **Retries:** the test retries joins in both setups, so "before" shows what a retrying page would have seen.
- **Precision:** each setup was run once, except where noted, so treat small differences as noise.

Result files are in `eval/results/<date>-load/`, with one line per run in `eval/results/SUMMARY.md`.

## Results

### Before and after, reference crowd

| | Before (3 runs) | After: cap + 10 s spread + retry (2 runs) |
| --- | --- | --- |
| Joins refused | 269 – 2,562 | 0 |
| Buyers with no ticket after 6 tries | 0 – 148 | 0 |
| Places in the draw nobody holds | 0 – 2,394 | 0 |
| Ticket copies / account peak | 392–399 / 400 of 400 | 83–85 / 87 of 400 |
| Wait for a ticket, max | 4.2 – 26.3 s | 10.0 s |
| Wait for a ticket, avg | 0.41 s (only run that recorded it) | 3.72–3.78 s |
| Sold out after admission starts | 36–48 s | 31–34 s |

- **Before:** `2026-10-13-load/115822`, `140132`, `2026-10-16-load/075145`.
- **After:** `2026-10-17-load/102542`, `115931`.
- **The wait:** almost all of it is the deliberate spread. The system's own share averaged 0.06–0.07 s.

### Choosing the setup (reference crowd)

| | Before | Spread 30 s | Cap 128 | Cap + spread 30 s | Cap + spread 10 s | Cap + spread 5 s |
| --- | --- | --- | --- | --- | --- | --- |
| Joins refused | 269 | 0 | 923 | 0 | 0 | 182 |
| Buyers who retried | 264 | 0 | 581 | 0 | 0 | 148 |
| Ticket copies | 399 | 32 | 128 | 26 | 83 | 128 |
| Wait avg / max | 0.41 / 10.98 s | 10.28 / 30.04 s | 0.25 / 4.03 s | 10.43 / 30.02 s | **3.72 / 10.03 s** | 1.94 / 5.10 s |

10 s is the shortest spread tested with no refusals, and it leaves 45 copies of headroom under the cap. At 5 s the reference crowd already reaches the cap. The cap stays as the backstop for pages that don't spread, such as scripts or pages cached from before the change.

### Why a cap of 128

Only 128 was tested. The reasons to keep it:

- **Not lower than about 85.** With the 10 s spread, the reference crowd used 83–85 copies. A lower cap would refuse ordinary crowds.
- **Not much higher.** AWS keeps 100 of the account's 400 unreserved, so at most 300 can be reserved across all stages. 128 leaves room for `staging` and `dev-simon`.
- **It costs buyers little.** Up to 3×, the cap was reached in several runs, but refused buyers got in on a retry within a second or two. Their wait after the spread averaged 0.05–0.12 s, with a longest of 2.2 s.
- **A higher cap would not fix the long waits.** From 4× on, most refusals are API Gateway's 429 (18,623 against 588 at the cap at 5×). Raising the cap would only cut the smaller share.

To get a shorter wait at larger crowds, raise API Gateway's limit on the join route together with the draw counter fix (see Limits) rather than the cap.

### Other crowd shapes, before and after

| Shape | Before: refused / retried | After: refused / retried | After: wait avg / max | After: no ticket |
| --- | --- | --- | --- | --- |
| Calm (half over 30 s) | 0 / 0 | not rerun (no change needed) | – | – |
| Sharp (half in 1 s) | 7,919 / 48% | 183 / 157 buyers | 3.80 / 10.04 s | 0 |
| Double (10,000) | 5,124 / 29%, 8 database errors | 7 / 7 buyers, 0 database errors | 3.70 / 10.05 s | 0 |
| Half the buyers skip the spread | – | 279 / 209 buyers, at most 3 tries | 1.94 / 10.02 s | 0 |

In every run after the change, the account peaked at 130 of 400 or below, leaving at least 270 for the other stages.

### How far it scales (after the change)

| Buyers | Peak joins/s sent | Refused 429 / 503 | Wait avg / max | No ticket after 6 tries |
| --- | --- | --- | --- | --- |
| 5,000 (1×) | 281 | 0 / 0 | 3.78 / 10.04 s | 0 |
| 10,000 (2×) | 555 | 0 / 7 | 3.70 / 10.05 s | 0 |
| 15,000 (3×) | 774 | 0 / 145 | 3.62 / 10.04 s | 0 |
| 20,000 (4×) | 1,947 | 5,914 / 215 | 4.07 / 26.79 s | 0 |
| 25,000 (5×) | 3,738 | 18,623 / 588 | 5.29 / 29.41 s | 15 |
| 30,000 (6×) | 4,838 | 33,428 / 1,297 | 6.41 / 30.70 s | 339 |
| 40,000 (8×) | 7,742 | 73,190 / 3,596 | 6.48 / 31.69 s | 6,422 (16%) |

- **Ceiling:** about 20,000 buyers in the reference shape. Between 20,000 and 25,000 the average wait passes 5 s and the first buyers get no ticket.
- **Cause:** API Gateway's limit on the join route, 600 a second with bursts up to 1,200. Refused buyers' retries then multiply the traffic.
- **The average stops rising past 6×** because the slowest buyers fail and drop out of it.
- **Unaffected:** every run had 0 places nobody holds and sold all 200 units.

### Time spent on the page (after the change, 1×)

| | Wait for a ticket, avg | Last order after admission starts |
| --- | --- | --- |
| Checkout 1–3 s | 3.78 s | ~36 s |
| Checkout 20–60 s | 3.75 s | 87.8 s |
| Checkout 20–60 s, 20% leave without confirming | 3.37 s | 419 s |

- **Joining is unaffected.** Time on the page doesn't hold a Lambda copy: a hold is just a record with an expiry time, and the checkout screen makes no requests until the buyer taps.
- **Abandoned holds:** they keep the unit reserved until the hold expires, so units are resold in waves.
- **The claim rush:** each time a unit returns, every waiting buyer taps Claim at once. In that run this caused 21,919 refused claims and took the claim function, which has no cap, to 168 copies.
- **Test fault:** this run's result file says FAIL because one hold had not yet expired when the run ended. 199 orders plus 1 hold account for all 200 units. The checks in `load.ts` have been fixed since.

## Limits and follow-ups

- **API Gateway's limit on the join route** (600 a second) is the next limit, at about 20,000 buyers. Raising it moves the limit to the next item.
- **The draw counter's single database partition**, about 1,000 writes a second. All 8 counter shards share one partition key (`packages/shared/src/keys.ts`). It caused the database errors at 2× before the change and 1–2 at 6–8× after.
- **The claim rush on returned stock:** the claim function has no cap, which risks the account's 400 with large crowds. Not measured beyond 1×.
- **Reserving copies for `staging`:** only 300 of the account's 400 copies can be reserved across all stages. Setting `ticketConcurrency` for `staging` in `cdk.json` is a team decision.
- **Pages that don't spread** (scripts, old cached pages): they are held back by the cap and retries only.
- **Not reproduced:** the crowd's reads of `state.json`. CloudFront serves that file, so it doesn't reach Lambda.

## Reproducing

```bash
AWS_PROFILE=<profile> AWS_REGION=ap-southeast-1 pnpm --filter @dropdeck/eval load -- --stage <dev-stage> --scale 1 --spread-sec 10
# --spike-sec 1 (sharp), --scale 2 (double), --spread-share 0.5 (half skip the spread),
# --checkout-sec 20-60, --abandon-share 0.2, --dry-run (print the plan only)
```

- **Space out runs:** leave 15 minutes between runs, so each starts cold.
- **Keep the laptop awake:** a sleeping laptop spoils the run.
- **Agree a time first:** a 3× or bigger run uses the shared account's capacity.
