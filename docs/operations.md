# Operations visibility — Phase 1

Implemented on `feat/ops-health-recovery`. This release adds read-only operational diagnostics and business charts. It does not introduce repair endpoints, inventory adjustments, publication retry jobs, acknowledgment controls or a mutation audit trail. Those remain Phases 2–3 of [the approved plan](ops-health-recovery-plan.md).

## Operator experience

Sign in with a Cognito user in the existing `operators` group, then open `/ops/`.

- **Shops & billing:** existing plan management and monthly totals, plus current plan mix, six months of buyer sessions and merchant allowance/billing previews. New charts cover the current page of up to 25 merchants; page controls explicitly change their scope. Usage is recorded when drops finish. Preview bills use today's plan, not reconstructed historical pricing, and do not collect payment.
- **Operations:** up to 25 registered drops per page, with attention filtering, collection freshness, controller heartbeat, S3 state write time, source/public revisions and inventory evidence. Select a drop for 15-minute, 1-hour or 24-hour traffic, error and OTP outcomes and the latest ten sampled health transitions. The linked CloudWatch dashboard provides aggregate service p50/p95 latency and alarms.

Health refreshes every 15 seconds while visible; selected-drop metrics refresh every 30 seconds. These are polling intervals, not a real-time delivery guarantee. CloudWatch subscriptions, SES events and the minute collector have independent delays. Missing/stale collection and incomplete inventory samples are Unknown. No request records in a window can mean idle traffic or delayed ingestion.

## Collection and attribution

Monitoring is **disabled by default**. Enable it explicitly for a stage with CDK context `operationsEnabled=true`, or that stage's `stageSettings`. Existing team CI does not automatically provision this monitoring infrastructure on merge. The business analytics routes work without it; the Operations tab explains when monitoring is unconfigured.

When enabled, the stack provisions a separate operations DynamoDB table, one collector Lambda, minute EventBridge rule, six log subscriptions, API access logs, a CloudWatch dashboard and alarms, an SNS alarm topic, and an encrypted SES event queue with DLQ. With `mailFrom` configured, it also creates an SES configuration set and SNS delivery-event topic. The checkout role receives sending access to that configuration set alongside its existing sender identity access.

Application handlers emit explicit redacted EMF observations. CloudWatch metric dimensions are bounded to Stage/Service or Stage. Tenant, drop and request IDs are correlation fields, never metric dimensions. The buyer request path makes no telemetry network calls. The collector aggregates log batches into minute/hour buckets; transactional receipts suppress identical batch retries. Rebatched overlapping deliveries or duplicate provider notifications can still overcount, so all operational counts are **diagnostic estimates**, never billing inputs or unique buyers.

Ticket issuance counts HTTP 201. New holds count claim HTTP 201; duplicate claim HTTP 200 is an attempt but not a new hold. Confirmation attempts and successful responses can include buyer retries. OTP verified events occur after a successful first hold-confirmation transition; no OTP value is logged. SES accepted means the send request succeeded; delivered means the recipient server accepted the email, not inbox placement or reading. SES delivery, delay, bounce, complaint and rejection are separately attributed using internal tenant/drop tags. Resend fallback outcomes do not establish SES delivery.

Application 429s include lockouts and rate limits. API Gateway access logs independently count edge 429s even when Lambda is never invoked. Per-drop edge attribution is available only for ticket/claim URLs, which contain drop identity; opaque hold URLs cannot safely be attributed. The stage dashboard includes all edge 429s.

New drop publications and controller heartbeats populate the operational registry. Pre-existing drops appear after their next publication/controller activity; this version does not backfill all historical drops. Collection processes at most 20 registry records per minute with four parallel reads and a 90-second lease. Larger registries take multiple cycles and can show delayed samples; size the collector before staging load tests. Registry records expire two days after drop end when sampled. Minute/hour metrics and receipts expire after 48 hours; health transitions after 30 days. DynamoDB TTL removal is asynchronous.

## Inventory and publication evidence

Collection has **read-only access to the application table** and reads only `d/*/state.json` from the public bucket. It can write only to its separate operations table. Admin routes cannot launch repair jobs.

For each drop, the sample compares total shard `sold` counters with active hold quantities plus recorded order quantities. Active/expired quantities come from the eventually consistent active-hold GSI; orders and stock are separate consistent reads. Holds/orders are bounded to 200 each; missing/unprocessed stock rows or query continuation mark the sample incomplete. An expired hold is flagged after a 10-second sweep allowance. The comparison is per-drop, not a per-shard ledger reconstruction.

Concurrent writes, GSI lag, or a confirmed hold whose order write has not completed can explain a difference. A matching sample also does not prove that every shard is correct. **Never use these diagnostics to increase sellable stock or authorize a release.** Transactional reservation/release, durable ledger and revision-checked reconciliation must precede repair functionality.

Controller heartbeat is independent of S3 LastModified: unchanged healthy public state does not require a write every tick. The collector compares lifecycle/source revision and records S3 write time; failed state and grouped shop/homepage publications are flagged until a later success. These observations are not a durable publication outbox or proof of CloudFront cache freshness. Existing snapshots without source revisions show an unknown revision until republished. A transition timeline records detected changes, not operator action history.

## Alarm defaults and response

Thresholds are initial values for sandbox validation, not validated service objectives:

| Signal | Initial rule |
| --- | --- |
| Service 5xx | >1%, at least 50 requests and 10 errors in each of two consecutive 5-minute periods |
| Service latency | p95 >1.5 seconds, at least 50 requests, two consecutive 5-minute periods |
| API edge 429s | >5%, at least 50 requests and 20 throttles, two consecutive 5-minute periods |
| Lambda errors / throttles | Nonzero in two consecutive 5-minute periods |
| DynamoDB throttling / system errors | Nonzero summed across operations, two consecutive 5-minute periods, for application and ops tables |
| Collector failures | Nonzero in two consecutive minute periods |
| Missing collector | Fewer than one collection run, three minute periods; missing data breaches |
| Affected drops in sample | Nonzero in three consecutive minute periods; this is not a global affected-drop total |
| Publication / OTP failure, delay, bounce, complaint, rejection | Nonzero in one minute period |
| SES delivery backlog | Oldest queued event >120 seconds in two consecutive minute periods |
| SES delivery DLQ | Any visible message |

All alarms target the stack's `AlarmTopicArn` output. **No notification recipient is hardcoded or subscribed by this change.** Configure and confirm the team's destination during deployment. Missing request traffic is non-breaching; missing collection is separately alarmed. Stage alarms complement per-drop evidence and may persist until their next evaluation after a fix.

For an incident, open Operations, verify collection freshness, find the affected drop, inspect heartbeat/publication/revision evidence and inventory completeness, then follow the CloudWatch dashboard and restricted logs. Investigate persistent discrepancies using existing runbooks. Do not edit counters from a GSI comparison. If delivery events stop, inspect SES configuration-set routing, the queue and DLQ before treating zero deliveries as success. Existing controller expiry sweeping still operates; no new retry/repair worker is installed.

Raw SES queue payloads can contain email addresses and headers. Queue access is restricted to its collector role and trusted AWS service publishers; data is redacted before operations-table persistence. Queues use managed encryption and retain events for four days (DLQ fourteen days). Application monitoring logs retain for one month. Ops snapshots exclude buyer names, email addresses, OTPs, authorization tokens, and raw provider payloads. Infrastructure administrators with broad IAM access can still read service logs/queues.

## Validation and deployment gate

Local checks cover metric attribution/redaction, authorization, pagination, stale/partial health, retry deduplication, collector leases and non-mutation of inventory against DynamoDB Local. CDK assertions cover opt-in resources, event routing, queues, alarms and collector permissions. Local demo fixtures support UI review and are excluded from normal production builds.

Before deploying, review the CDK diff for the intended AWS account/stage with `operationsEnabled=true`. Review custom metrics, percentile alarms, dashboard, log ingestion, subscriptions and DynamoDB read/write costs against the sandbox budget. Provision a notification destination, verify SES sender and sandbox recipient constraints **in that account and region**, and run live healthy/failure/429/delivery probes and notification tests. Tune collector capacity and thresholds using the reference/spike workload. SES identities and permissions from a personal account do not transfer to team staging.

No AWS resources have been deployed as part of this implementation. Sandbox deployment and failure/load validation are Phase 4. Removing monitoring later destroys its log groups/queues under the current stack policy but retains the operations table; review retention before disabling a deployed stage.

AWS references: [EMF and metric cardinality](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html), [SES event destinations](https://docs.aws.amazon.com/ses/latest/dg/event-destinations-manage.html), [SES sending resource permissions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html).
