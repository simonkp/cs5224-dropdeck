# Degradation policy

What DropDeck does when a part fails mid-drop. The resilience experiment (`eval/README.md`) checks each row:
inject the fault in `staging`, observe, compare with the "Expected" column.

The invariant in every row: **no unit is ever sold twice**. Every failure resolves towards underselling (a unit
stuck until the drop ends) rather than overselling, because each step that gives stock out or back is a single
conditional write.

| Fault | What buyers see | What the system does | Recovers |
| --- | --- | --- | --- |
| Controller invocation lost or crashes | Queue position stops moving; claims already admitted still work | Nothing advances the published watermark; claims are still admitted, because the claim endpoint computes admission from time, not from `state.json` | Next minute's scheduled invocation recomputes everything from time; at most ~1 min stale |
| Two controllers overlap | Nothing | Watermark is a function of time; early-group freeze, close and hold release are conditional writes, so only one of each wins | Immediately |
| Controller slow, sweep backlog | Sold-out flags may linger a few seconds after holds expire | Expired holds cannot be confirmed (checked on read); the sweep returns their units on the next tick | Next tick (2.5 s) |
| Merchant cancels while a tick is writing | `state.json` may briefly say Live | Next tick sees Cancelled, voids holds, republishes Cancelled, deletes the tick schedule; checkout refuses a cancelled drop | Next tick |
| DynamoDB throttles or errors on a claim | Claim fails with a retryable error; the page lets them retry | If the reserve landed but the hold write failed ambiguously, the unit is kept (undersell) rather than returned | Buyer retries; the same ticket cannot hold twice |
| Claim Lambda crashes between reserve and hold | Claim fails | One unit leaks for the rest of the drop | Not recovered; undersell by design (decision 0006) |
| Checkout crashes after confirming the hold | Confirmation fails | A retried confirm finds the confirmed hold and rebuilds the order from it | Buyer retries |
| Hold expires mid-checkout | "Your hold has expired" | Confirm's conditional flip requires the hold to be active and unexpired | Buyer rejoins |
| Function timeout on ticket or claim | Request fails | API Gateway returns 5xx; no partial state that can oversell | Buyer retries |
| S3 write of `state.json` fails | Position stops updating | Logged; the next tick rewrites the whole object | Next tick |
| CloudFront serves stale `state.json` | Position lags by up to 5 s | Cache TTL is 1–5 s by design; claims do not depend on it | Within the TTL |
| Burst beyond stage throttle (1,000 rps, 2,000 burst) | 429 on ticket or claim | API Gateway sheds load before Lambda or DynamoDB | Buyer retries; limits re-tuned from the 10× load test |
| SES unavailable (Phase 4) | Email code does not arrive | Resend fallback behind the same mailer interface (decision 0002) | Fallback path |

Not handled, named honestly: a buyer with many sessions gets better odds, not more orders (decision 0001);
direct attacks on the ticket and claim endpoints are bounded only by stage throttling and the budget alarm.
