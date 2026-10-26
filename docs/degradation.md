# Degradation policy

What DropDeck does when a part fails mid-drop. The resilience experiment (`eval/README.md`) checks each row:
inject the fault in `staging`, observe, and compare with the row.

The invariant in every row: **no unit is ever sold twice**. Every failure resolves towards underselling (a unit
stuck until the drop ends) rather than overselling, because each step that gives stock out or back is a single
conditional write.

| Fault | What buyers see | What the system does | Recovers |
| --- | --- | --- | --- |
| Controller lost or crashes **before** the early group is frozen (open + grace + 2 s) | Nobody is admitted; claims answer "not your turn yet" with a retry time | Admission needs the frozen early-group size, which only the controller writes | Next minute's invocation freezes it and everything proceeds; buyers wait up to ~1 min |
| Controller lost or crashes **after** the freeze | Queue position stops moving; admitted buyers can still claim | Nothing advances the published watermark, but the claim endpoint computes admission from time and the frozen size, not from `state.json` | Next minute's invocation recomputes everything from time; at most ~1 min stale |
| EventBridge Scheduler fires the open late (measured 0–47 s) | Nothing: the queue opens at the advertised time | The open is scheduled 90 s ahead and the ticket endpoint refuses tickets until the entry time | Lag above 90 s would open the queue late by the excess; the controller logs `lagMs` for every open |
| Two controllers overlap | Nothing | Watermark is a function of time; early-group freeze, close and hold release are conditional writes, so only one of each wins | Immediately |
| Controller slow, sweep backlog | Sold-out flags may linger a few seconds after holds expire | Expired holds cannot be confirmed (checked on read); the sweep returns their units on the next tick | Next tick (2.5 s) |
| Merchant cancels while a tick is writing | `state.json` may briefly say Live | Next tick sees Cancelled, voids holds, republishes Cancelled, deletes the tick schedule; checkout refuses a cancelled drop | Next tick |
| DynamoDB throttles or errors on a claim | Claim fails with a retryable error; the page lets them retry | If the reserve landed but the hold write failed ambiguously, the unit is kept (undersell) rather than returned | Buyer retries; the same ticket cannot hold twice |
| Claim Lambda crashes between reserve and hold | Claim fails | One unit leaks for the rest of the drop | Not recovered; undersell by design (decision 0006) |
| Checkout crashes after confirming the hold | Confirmation fails | A retried confirm finds the confirmed hold and rebuilds the order from it | Buyer retries |
| Hold expires mid-checkout | "Your hold has expired" | Confirm's conditional flip requires the hold to be active and unexpired | Buyer rejoins |
| Function timeout on ticket or claim | Request fails | API Gateway returns 5xx; no partial state that can oversell | Buyer retries |
| A crowd taps Join in the same second as the queue opens | Before the draw, "Joining in a few seconds" for up to 10 s; their place is unchanged because the draw is random | The page waits a random 0–10 s before sending a pre-draw join (`joinSpreadMs` in `apps/web/app/d/buyer.ts`), so joins reach the ticket function as a stream; after the draw it sends at once | Measured on the reference crowd (`eval/load.ts --spread-sec 10`, 2026-10-17): no refusals, 83–85 ticket copies over two runs, average wait 3.7–3.8 s, longest 10 s. With the cap at 128, a sharp crowd (half in 1 s), twice the crowd, or half the buyers skipping the wait: 7–279 refused, every buyer got a ticket within 3 tries, longest wait 10 s |
| More joins at once than the ticket function's cap (`ticketConcurrency`, per stage) | "Joining…" a moment longer | Lambda refuses the excess with 503 before the handler runs, so nothing is written; the page retries with backoff, up to 5 retries | Within seconds as copies warm. Measured with the cap at 128 and no spreading: 923 refused, every buyer got a ticket, longest wait 4 s |
| Signing-key lookup refused (Parameter Store `ThrottlingException`) | The join fails and the page retries it | The key is fetched before any counter write, so a failed join leaves no entry in the draw | When a lookup succeeds; the key is then cached for the copy's life |
| Holds still open when the drop closes | Their buyers can still check out until the hold expires | The tick schedule is deleted on close, so holds that expire afterwards are never swept and the stock counters overstate sales | By design: merchant reports and exports count orders, never stock counters |
| A release or a not-yet-indexed hold lands between the sold-out read and the open-hold count | Drop closes a moment early | Close is decided from two reads in sequence (shard counters, then the GSI count) | Undersell only; a buyer already holding stock can still confirm |
| S3 write of `state.json` fails | Position stops updating | Logged; the next tick rewrites the whole object | Next tick |
| Write of `shop.json` or the homepage list (`featured.json`) fails | The shop page or homepage shows a drop's old state; the drop page itself is unaffected | Logged, never fails the merchant's request or the tick; both are rebuilt from the table on the shop's next change | The shop's next drop change or profile save |
| CloudFront serves stale `state.json` | Position lags by up to 5 s | Cache TTL is 1–5 s by design; claims do not depend on it | Within the TTL |
| Burst beyond stage throttle (1,000 rps, 2,000 burst; tickets 600 rps, 1,200 burst) | 429 on ticket or claim | API Gateway sheds load before Lambda or DynamoDB | The page retries joins; measured at 2,500 joins a second (2026-10-14): 4,561 joins shed, every buyer got a ticket on a retry |
| SES unavailable (Phase 4) | Email code does not arrive | Resend fallback behind the same mailer interface (decision 0002) | Fallback path |

Not handled, named honestly: the draw's counters share one partition key (`keys.earlyCounter`, `keys.ticketCounter`),
so they sit in one DynamoDB partition, documented at up to 1,000 writes a second. At about 1,800 joins a second
(2026-10-16) 460 writes were throttled; the SDK's retries absorbed 452 and 8 joins failed (no entry left behind).
Also not handled: a buyer with many sessions gets better odds, not more orders (decision 0001);
direct attacks on the ticket and claim endpoints are bounded only by stage throttling and the budget alarm.
