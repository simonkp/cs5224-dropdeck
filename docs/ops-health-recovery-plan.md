# Operations analytics, incident response and recovery — review plan

Status: Phase 1 approved on 18 October 2026; read-only implementation complete and locally validated. Later recovery phases and AWS deployment remain gated.
Branch: `feat/ops-health-recovery`, based on `origin/main` (`30dc9b4`).
Prepared: 18 October 2026, Singapore time.

## Recommendation and scope

Add day-to-day incident response to `/ops/`, alongside merchant plans, monthly usage and billing previews. Business reporting and operational monitoring have different time windows and should have separate views.

Initial scope is the operator experience. Merchants may see a short status for their own affected drops later; buyers retain actionable retry/expiry messages. Technical diagnostics, other tenants' data and repair controls belong to operators.

This is an operational analytics feature, not a payment collection system. Existing billing remains a preview. Operational counts are diagnostic estimates and must not become the source of billable usage.

## Findings in the current implementation

- `OpsView.tsx` and the admin API provide monthly shop/plan/usage/billing reporting and enforce the Cognito `operators` group. There are no incident, recovery-job or application audit views.
- Ticket, claim, checkout and controller functions emit some structured logs. CDK configures log retention, API throttles and an optional cost budget; it does not define the requested operational alarms or dashboard.
- The controller already sweeps expired holds, retries ticks and republishes terminal state. We should extend these paths rather than build competing recovery logic.
- A claim reserves a stock shard before writing its hold. A crash between those writes leaks reservations. `releaseHold` marks the hold released before decrementing the counter, creating another leak window. Duplicate-claim compensation also needs to be covered.
- Confirmed holds can exist before their order record is written. Inventory checks must count authoritative confirmed reservations, not just completed order rows.
- `state.json` is published when contents change, with a forced initial publication per controller invocation. An older timestamp alone does not prove a failed controller. Shop/homepage publication failures can remain until another shop change.
- The active-hold GSI is eventually consistent and excludes confirmed/released holds. Its counts cannot prove that inventory is safe to increase. Hold TTL also prevents indefinite historical reconstruction.
- The checkout mailer currently distinguishes SES and log mode, but does not retain SES message IDs or receive delivery events. A successful send request is not evidence of delivery.

The existing local edits to `docs/degradation.md` are outside this plan and will not be overwritten or included in feature commits without review.

## 1. Operator interface

| View | Contents |
| --- | --- |
| Shops & billing | Existing plans, monthly usage and invoice previews; add current plan mix, monthly usage trends, allowance consumption, top-usage merchants and projected bill breakdown; retain the month selector |
| Operations | Health summary, recent trends, affected-drop list and filters for stage, severity, merchant and drop |
| Recovery jobs | Requested, queued, running, succeeded, failed and exhausted jobs; preview and result details |
| Audit | Actor, reason, target, action, before/after summary, timestamps and outcome |

Operations uses independent 15-minute, 1-hour and 24-hour filters. Refresh health snapshots approximately every 15–30 seconds while the page is visible. CloudWatch charts use minute-scale aggregation and show their own ingestion delay. Display observation time, source and freshness; missing data is **Unknown**, not Healthy or zero.

Business charts use the existing completed-drop usage records through bounded, paginated queries or cached aggregates. Current plan mix must be labelled current; historical plan changes/prices cannot be reconstructed from today's tier. Usage is posted when drops finish, so the selected month's totals may lag an active drop. Display that distinction and keep projected billing clearly separate from invoices or collected payments. Ticket/claim/confirmation charts show operation counts, not unique people or a guaranteed conversion funnel.

Each affected-drop row/detail includes:

- Tenant/shop and drop identity, lifecycle state and severity with a human-readable reason.
- Ticket attempts/successes, admitted claim outcomes, active/expired holds and confirmations. Distinguish hold counts from quantities reserved.
- API 5xx, throttled requests, p50/p95 latency and relevant controller failures.
- Controller heartbeat, last publication attempt, last successful write, source/public revision, last inventory check and pending recovery work.
- Inventory by variant and shard: capacity, recorded reserved/confirmed units, ledger-backed expected units, discrepancy and confidence.
- OTP requested, accepted by provider, delivered to recipient mail server, delayed, bounced, rejected and verified. Explicitly label SES disabled/log mode.
- Incident timeline and links to scoped CloudWatch logs and dashboards.

The list reads bounded, paginated health summaries. It does not scan every tenant's holds/orders or run CloudWatch Logs Insights queries on every page refresh.

## 2. Telemetry and AWS components

Use native API Gateway, Lambda, DynamoDB and SQS metrics where available. Add a shared structured logging/CloudWatch Embedded Metric Format helper for business outcomes and errors caught inside handlers; Lambda `Errors` alone misses failures returned as HTTP responses.

Use low-cardinality metric dimensions: stage, service, operation and bounded outcome category. Tenant/drop/request IDs are correlation fields in logs and operational records, not metric dimensions. This avoids a custom metric series for every drop. [CloudWatch cost guidance](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_billing.html)

Proposed components:

- **CloudWatch:** aggregate metrics, dashboard, metric/composite alarms and structured logs. API access logs capture edge 429s that never reach Lambda; parse their HTTP status separately from application 429s such as OTP lockouts.
- **DynamoDB operations table:** per-drop summaries, incident lifecycle, publication intent/status, recovery jobs, deduplication records and append-only application audit events. Separate from billing and buyer data, with explicit retention and query indexes.
- **EventBridge Scheduler + collector Lambda:** bounded periodic health collection for active drops, recently closed drops with outstanding work and open incidents. Maintain an operational drop registry instead of scanning the application table.
- **SQS + recovery Lambda + DLQ:** asynchronous, bounded repair/republication work with retries, exponential backoff and jitter. Record a job before enqueueing, with an outbox/dispatcher to recover failed enqueue attempts.
- **SNS:** alarm notifications to a configured team destination. Provision the topic without assuming a recipient; subscription confirmation is completed during deployment.
- **SES configuration set → SNS/SQS → event Lambda:** correlate provider message IDs with internal drop/hold references. Deduplicate events, tolerate out-of-order events and expose redacted outcomes. Delivery means acceptance by the recipient mail server, not inbox placement or reading. [SES events](https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html)

No OTP values, signed tokens, full buyer emails or raw provider payloads appear in operational screens or audit entries. Restrict access to raw SES events and redact before persistence. Suggested initial retention: 30 days for logs, health detail and delivery correlation; 90 days for recovery/audit records. These are configurable proposals, not changes to buyer-data retention.

## 3. Initial alarms and incident rules

Thresholds below are provisional and must be tuned using the repository's reference workload and burst/failure tests. Gate rate/percentile alarms on enough traffic; do not treat normal sold-out, not-yet-admitted or validation responses as system failures.

| Signal | Initial rule to validate |
| --- | --- |
| API 5xx | Above 1% with at least 10 failures in a rolling 5 minutes |
| Edge throttling | 429s above 5% with at least 20 throttles in 5 minutes; show application lockouts separately |
| Latency | p95 above 1.5 seconds for 5 minutes with at least 50 requests; separate ticket/claim/checkout operations |
| Controller health | Live drop heartbeat absent for more than 90 seconds, allowing for the next scheduled invocation |
| Publication | Desired revision remains unpublished for over 30 seconds; escalate after 90 seconds. Evaluate alongside heartbeat and last successful publication |
| Inventory | Expired active holds exceed the sweep allowance; persistent ledger/counter discrepancy creates an incident, not an automatic stock adjustment |
| OTP | Send failures, repeated delivery delays beyond 2 minutes and bounce/complaint events. Low-volume individual failures appear in the drop timeline even below an aggregate alarm threshold |
| Recovery | DLQ messages, exhausted jobs, stuck leases or a growing oldest-job age |
| Dependencies | Lambda throttles/timeouts and DynamoDB throttling/system errors |

Deduplicate incidents by stage/drop/signal, support acknowledge/resolve with notes, and record transitions. Acknowledgment does not repair the underlying condition. Stage alarms can point to a filtered affected-drop list; avoid one CloudWatch alarm per transient drop. Missing telemetry must itself be visible when live drops exist.

## 4. Safe inventory reconciliation

**Invariant: recovery must never create stock that can be sold twice.** No operator button sets counters to a guessed total.

1. **Remove new leak windows first.** Use conditional DynamoDB transactions for stock reservation plus hold creation, and for hold release plus stock return. Cover duplicate claims, SDK retries, checkout races and cancellation. Stable operation IDs make retries idempotent. Preserve per-shard capacity checks and stock-shard revision numbers.
2. **Add durable evidence.** Maintain a per-drop reservation ledger, written in the same transaction as each reservation/state transition, including hold ID, shard, quantity and operation ID. Retain evidence until reconciliation is complete, independently of the short-lived hold TTL. Confirmed reservation evidence remains valid when an order row is temporarily missing.
3. **Detect separately from repair.** Bounded collector jobs compare counters and ledger state. Live reads can race with legitimate traffic and are labelled suspect until rechecked; neither GSI counts nor several independent reads constitute an atomic snapshot. [DynamoDB isolation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
4. **Allow safe live actions only.** Expired-hold sweep uses the same transactional release primitive, with expiry/state conditions. Never release an unexpired or confirmed hold.
5. **Restrict counter reconciliation initially to quiescent terminal drops.** Wait until remaining holds expire and maximum in-flight processing/retry windows have passed. Use a per-drop repair lease, verify a consistent ledger view and condition the repair on unchanged shard revisions. All writers must increment those revisions. Abort if concurrent writes, missing evidence or contradictory values are observed.
6. **Treat legacy gaps conservatively.** Existing drops predate the ledger. Missing holds or expired history are not proof of leaked stock. Report ambiguous differences and require investigation; do not automatically decrease counters. Fully automated repair during a live drop is deferred until a tested write-fencing protocol exists.

New transactions/ledger writes change the cost and latency of the claim path. Measure their effect before deployment; update the single-table/undersell decision documentation after approval. Do not ship recovery while silently retaining the known non-atomic leak paths.

## 5. Publication recovery and restricted actions

Store durable publication intent/status for drop state, drop metadata, shop state and the homepage list. Track controller heartbeat independently and update success timestamps only after successful S3 writes. Collect S3 LastModified/public revision as separate evidence; a timestamp embedded in a proposed snapshot is not proof it reached S3 or CloudFront.

Retries rebuild from current DynamoDB data, not a historical payload submitted by the browser. All publication paths—controller, merchant writes and recovery—must use the same revision/conditional-write protocol. Test overlapping writers and retries so stale Live content cannot overwrite a newer Closed/Cancelled publication. Respect normal CDN TTLs; reserve invalidation for demonstrated need.

Operator actions for the first release:

- Run a diagnostic/inventory check.
- Preview a proposed expired-hold sweep or safe terminal-drop reconciliation.
- Retry publication for a specified drop/shop, or a failed recovery job.
- Apply an approved, still-current repair preview.

Keep existing `operators` access for diagnostics. Require an additional `ops-recovery` group for mutations, checked in the backend on every action. The web API can create jobs but cannot directly edit stock; the worker has narrowly scoped permissions.

Every mutation requires a reason, request/idempotency ID, target stage/tenant/drop, expiry-bounded preview and expected revisions. Invalidate stale previews. Persist the request audit before dispatch; if audit persistence fails, do not start the repair. Record execution, retries, before/after evidence and outcome. Expose no arbitrary database edits, arbitrary Lambda invocation, arbitrary object keys or bulk tenant repair endpoint. CloudTrail complements this application audit; it does not replace the operator's reason and domain-specific result.

## 6. Implementation phases and review gates

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 — Visibility | Business analytics charts, outcome instrumentation, API access logs, heartbeat/publication tracking, read-only Operations UI, collector and initial CloudWatch dashboard/alarms | Correct attribution, bounded reads, meaningful Unknown/idle states and no PII leaks |
| 2 — Controlled publication recovery | Publication intent/outbox, version-aware retries, job UI, recovery role and audit | Stale/duplicate jobs cannot regress public state; every mutation attributable |
| 3 — Inventory safety | Transactional reservation/release, durable ledger, diagnostics, expired-hold sweeps and restricted terminal-drop reconciliation | Fault/race tests preserve capacity and exactly-once release; performance/cost accepted |
| 4 — Staging validation | Deploy to personal sandbox first, exercise failures/load, tune alarms, then deploy to team staging | Infrastructure diff reviewed; team access, notification recipient and per-account SES configured |

Phase 1 is the first reviewable milestone. Phase 2 publication retries and Phase 3 inventory repair are separately reviewed before enabling mutations. Phase 1 implementation details and deployment instructions are recorded in [operations.md](operations.md).

## 7. Validation and acceptance

- Test metric outcomes for successful, rejected and duplicate requests. Verify API-level throttles are observed without handler execution; billing remains sourced from existing metering.
- Test operator authorization, recovery-only authorization, tenant scoping, pagination, rate limits, stale previews, idempotency and audit-write failure.
- Inject crashes around each reservation/release/confirmation step, including confirmed hold before order creation. Run overlapping workers, checkout versus sweep, duplicate compensation and ambiguous retries against DynamoDB Local.
- Deliberately introduce supported ledger/counter discrepancies; preview must identify the exact shard/quantity, apply once, and refuse missing history or concurrent revisions. No counter below zero or above capacity, no increase in sellable inventory based solely on a missing GSI result.
- Fail S3 writes and enqueueing, kill workers, replay old publication events and exhaust retries. Verify outbox recovery, DLQ visibility, immutable job history and terminal-state publication ordering.
- Exercise SES accepted/delivered/delayed/bounce/complaint and log-mode cases. Correlate events without exposing email/code data.
- Verify visible dashboard states for healthy, idle, unknown, delayed, partial failure and permission-denied conditions at desktop/mobile sizes.
- Run reference and spike load tests; compare claim latency, throughput, transaction conflicts, DynamoDB capacity, log volume and projected CloudWatch/SQS/ledger cost with the existing baseline. Test alarm transitions and notification delivery, not only CDK synthesis.
- Deployment preflight checks account/stage, SSM signing keys, SES identity/configuration, IAM permissions, notification confirmation and live diagnostic probes. Each AWS account needs its own operational resources and sender configuration.

Acceptance: an operator can identify an affected drop and its evidence, preview a supported recovery action, run it exactly once with appropriate access, and see an attributable result. Uncertain inventory or telemetry remains explicitly Unknown/Needs investigation rather than silently repaired.

## Review defaults

Recommended: four ops views; visibility first; minute-scale CloudWatch charts plus 15–30-second health snapshots; SES events for delivery status; no automatic live counter correction; an additional recovery role; configurable 30/90-day retention. Confirm the notification destination and budget during sandbox deployment preparation. The first implementation milestone should remain read-only until the recovery safety gates pass.
