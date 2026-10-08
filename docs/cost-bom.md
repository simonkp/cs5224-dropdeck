# Cost: bill of materials and platform comparison

What DropDeck costs to run, what a drop costs, and how that compares with a classic server-based design and with running it on our own servers. The tables between the markers come from `eval/cost-model.ts`; change an assumption there and run `pnpm --filter @dropdeck/eval cost -- --write`. Once a real drop is instrumented, `--measured <file>` replaces the modelled workload.

## How the architecture maps onto a classic web-app design

![DropDeck as built (platform A below): the crowd polls cached files at the edge; only joins, claims and checkouts reach Lambda](architecture.svg)

A classic scalable web app splits its work into stages (content in, heavy processing, delivery), puts EC2 web servers behind a load balancer with auto scaling, joins the stages with a queue, and serves readers from a CDN. DropDeck has the same parts, as managed services that cost nothing while idle:

| Classic piece | DropDeck | Service model |
| --- | --- | --- |
| Content in (users send data) | Merchant console → merchant API → `drop.json`, `shop.json`, `featured.json` (homepage list), uploaded images in S3 | PaaS (API Gateway, Lambda), IaaS (S3) |
| Heavy processing (not user-facing) | The burst: ticket, claim and checkout functions writing sharded DynamoDB counters; the controller ticking | PaaS (Lambda, DynamoDB, EventBridge Scheduler) |
| Delivery via CDN | CloudFront serves the pages, `state.json` (the waiting room) and photos from the edge | SaaS-style managed CDN |
| Load balancer + EC2 auto scaling | API Gateway + Lambda: scales per request, nothing to provision | PaaS |
| Queue between stages (SQS) | EventBridge Scheduler opens drops; the controller "messages" every waiting buyer by publishing one cached `state.json` | PaaS |
| Users' web browser / media player | Phone browser; the delivery channel, not part of the system | (client) |

**No rework needed.**
- The burst stage never touches a server we run.
- The CDN carries the read load, which is where a crowd's traffic is.
- A load balancer alone would cost about US$24 a month with nothing happening.

## WAF, DDoS and autoscaling (decided)

- **DDoS:** AWS Shield Standard protects every CloudFront distribution at no cost.
- **Denial of wallet:** it is bounded by the API stage throttle (1,000 requests a second; tickets have their own 600) and by the budget alarm. A million junk API calls cost about US$1.60.
- **WAF is not added.**
  - It cannot attach to an API Gateway HTTP API. On the main CloudFront distribution it would also inspect every waiting-room poll: US$0.60 per million, about +US$0.50 per reference drop, plus US$6 a month.
  - The upgrade path, if a drop is ever attacked:
    - **Fixed price:** WAF with an IP rate limit on a separate, API-only CloudFront distribution. That is US$6 a month and fractions of a cent per drop (platform B below).
    - **Flat rate:** a CloudFront flat-rate plan. Pro is US$15 a month for 10M requests, with WAF included and no overage charges; Business is US$200 a month for 125M.
- **Autoscaling** is built into Lambda, API Gateway and on-demand DynamoDB.
  - The ceiling that matters is the account's Lambda concurrency quota. In the sandbox it is **400** (checked 2026-10-07 with `aws lambda get-account-settings`). At about 80 ms per call that allows roughly 5,000 API calls a second, well above the 1,000-a-second stage throttle.
  - Cold starts at the opening second can be removed with provisioned concurrency for just the drop window (about US$0.04 per drop, included in platform B). Whether it is needed comes from the elasticity measurement.

## What drives the cost

- **Waiting-room polling is the cost.** Every buyer's page re-reads `state.json` from CloudFront, so cost follows buyers × minutes on the page × polls a minute. Everything behind the API costs a few cents per drop, because it is bounded by stock, not by the crowd.
- **Adaptive polling, as built** (`pollInterval` in `apps/web/app/d/buyer.ts`; it replaced a fixed 2 s poll) polls fast only when something can change for that buyer:
  - every 30 s during a far-off countdown
  - every 2 s from 2½ minutes before the queue opens
  - every 5 s when more than 300 people are ahead
  - every 10 s once holding stock
  - every 15 s in a background tab
- **Measured:**
  - **Built site (playwright):** a phone left on a countdown page for 5 minutes made **11** polls, against 150 at a fixed 2 s. A first page load is 18–19 requests and 270–590 KB depending on photos.
  - **Deployed on dev-simon, 2026-10-07:**
    - a countdown two days out: **7 polls in 3 minutes**, every 30 s
    - a drop whose queue opened during the test: 76 polls in 3 minutes, switching to every 2 s once inside the last 2½ minutes
- **Always-free allowances** (CloudFront 10M requests and 1 TB a month, Lambda, Scheduler) absorb the first few drops each month on a normal account. Whether they apply to the NUS sandbox's credit account cannot be checked: the sandbox's service control policy denies the Free Tier API. So every figure below is shown without them unless marked.

<!-- BOM:START -->
_Generated by `eval/cost-model.ts` (modelled inputs). Prices: AWS on-demand, ap-southeast-1, price list of 2026-10-07. US$ unless marked._

### Per drop (reference drop: 200 units, 5,000 buyer sessions)

| Item | As built (adaptive): quantity | As built | Fixed 2 s (replaced): quantity | Fixed 2 s |
| --- | --- | --- | --- | --- |
| CloudFront requests (pages + state.json polls) | 0.81M (0.71M polls) | $0.97 | 1.90M (1.80M polls) | $2.27 |
| CloudFront data out | 2.6 GB | $0.31 | 3.2 GB | $0.39 |
| CloudFront Functions (URL rewrite) | 15k | <$0.01 | 15k | <$0.01 |
| API Gateway (HTTP API) | 7.3k | <$0.01 | 7.3k | <$0.01 |
| Lambda (ARM, 512 MB) incl. controller | 1.5k GB-s | $0.02 | 1.5k GB-s | $0.02 |
| DynamoDB on-demand | 7.1k W / 23.2k R | <$0.01 | 7.1k W / 23.2k R | <$0.01 |
| S3 (state.json writes, edge refills) | 1080 PUT / 4050 GET | <$0.01 | 1080 PUT / 4050 GET | <$0.01 |
| EventBridge Scheduler | 46 | <$0.01 | 46 | <$0.01 |
| SES email codes | 173 | $0.02 | 173 | $0.02 |
| CloudWatch Logs | 4.3 MB | <$0.01 | 4.3 MB | <$0.01 |
| **Total per drop** |  | **$1.35** |  | **$2.73** |
| With the always-free CloudFront allowance (1 drop a month) |  | $0.38 |  | $0.46 |

Polls per session: 142 as built, against 360 with the fixed 2 s poll it replaced (2.5× fewer). Session time by phase (assumed): countdown 5 min, near the front 3 min, far back 3 min, holding 1 min.

### Sensitivity: cost per drop against how long buyers keep the page open

| Minutes on page | 5 | 10 | 15 | 20 | 30 |
| --- | --- | --- | --- | --- | --- |
| As built (adaptive) | $0.82 | $1.20 | $1.58 | $1.96 | $2.71 |
| Fixed 2 s (replaced) | $1.40 | $2.35 | $3.30 | $4.25 | $6.15 |

### Fixed monthly cost of each platform (no drops at all)

| Platform | Idle month | Per reference drop | Note |
| --- | --- | --- | --- |
| A. DropDeck as built (adaptive polling) | $0.05 | $1.35 | pay per use; idle month ≈ storage only |
| B. A + WAF on the API + warm Lambdas | $6.05 | $1.39 | optional hardening, not built |
| C. Classic servers: ALB + EC2 auto scaling + cache | $161 | $1.61 | always-on servers; +4 × c7g.large for 1 h per drop |
| D. On-premise (sized for the peak) | $550 | $0.05 | fixed cost whatever the traffic; bandwidth in colocation |

<details><summary>A. DropDeck as built (adaptive polling): fixed items</summary>

| Item | Quantity | Per month |
| --- | --- | --- |
| S3 storage (site, images, JSON) | ~2 GB | $0.05 |
| DynamoDB storage | < 25 GB | $0.00 |
| Cognito (Essentials, < 10k monthly users) | - | $0.00 |
| Budget alarm, SSM parameters, CloudFront (idle) | - | $0.00 |

</details>

<details><summary>B. A + WAF on the API + warm Lambdas: fixed items</summary>

| Item | Quantity | Per month |
| --- | --- | --- |
| S3 storage (site, images, JSON) | ~2 GB | $0.05 |
| DynamoDB storage | < 25 GB | $0.00 |
| Cognito (Essentials, < 10k monthly users) | - | $0.00 |
| Budget alarm, SSM parameters, CloudFront (idle) | - | $0.00 |
| WAF web ACL + 1 rate rule (API-only distribution) | - | $6.00 |

</details>

<details><summary>C. Classic servers: ALB + EC2 auto scaling + cache: fixed items</summary>

| Item | Quantity | Per month |
| --- | --- | --- |
| Application Load Balancer (+1 LCU) | 730 h | $24 |
| EC2 web/queue servers, 2 × t4g.medium (two AZs) | 1460 h | $62 |
| EBS gp3, 2 × 20 GB | 40 GB | $3.84 |
| ElastiCache Valkey t4g.small (queue state) | 730 h | $28 |
| NAT gateway (private subnets) | 730 h | $43 |
| S3, DynamoDB, Cognito as above | - | $0.05 |

</details>

<details><summary>D. On-premise (sized for the peak): fixed items</summary>

| Item | Quantity | Per month |
| --- | --- | --- |
| 2 × 1U servers (HA pair), S$3,500 each over 36 months | - | $150 |
| Colocation, 2U with power and 100 Mbps, Singapore | - | $231 |
| Operations (patching, backups, on-call), 4 h at S$50 | - | $154 |
| Off-site backup and domain/TLS | - | $15 |

</details>

### Monthly cost against revenue as the business grows

Merchant mix (assumed): 60% Starter (2 small drops), 30% Growth (4 reference drops), 10% Event (1 small drop). A small drop is a fifth of the reference drop. Revenue at S$1.30 per US$.

| Platform | 10 shops: cost | 50 shops: cost | 200 shops: cost | 10 shops: gross margin | 50 shops: gross margin | 200 shops: gross margin |
| --- | --- | --- | --- | --- | --- | --- |
| A. DropDeck as built (adaptive polling) | $20 | $98 | $393 | 96% | 96% | 96% |
| B. A + WAF on the API + warm Lambdas | $26 | $107 | $411 | 95% | 96% | 96% |
| C. Classic servers: ALB + EC2 auto scaling + cache | $185 | $279 | $632 | 63% | 89% | 94% |
| D. On-premise (sized for the peak) | $550 | $553 | $564 | -9% | 78% | 94% |
| Revenue (all platforms) | $504 | $2519 | $10077 |  |  |  |

At 200 shops that is 500 drops a month (240 reference-size). Margins exclude people, payment fees and taxes.

<!-- BOM:END -->

## Reading the comparison

- **At our size (tens of shops), serverless wins by a wide margin.** The idle month costs cents, so a quiet month cannot make the service insolvent. The classic stack costs about US$161 a month before the first drop. On-premise costs about US$550, and it still needs a CDN in front, or it must be sized for thousands of requests a second at every opening.
- **At a few hundred shops, the always-on designs catch up,** because per-drop polling cost grows with every drop while their fixed cost is shared. That is the point to reconsider:
  - polling intervals (the biggest lever; see the sensitivity table)
  - a CloudFront flat-rate plan, which caps request cost
  - pushing admission updates instead of polling them
- **Revenue covers cost in every scenario above 10 shops.** The pricing in decision 0007 charges for buyer sessions beyond the Growth allowance, so revenue grows with the same thing that drives cost.

## Assumptions to replace with measurements

| Assumption | Value | How to measure |
| --- | --- | --- |
| Minutes on the page per session, by phase | 5 countdown, 3 near the front, 3 far back, 1 holding | CloudFront request count for one seeded drop ÷ sessions |
| Sessions per reference drop | 5,000 | `USAGE#` records (`GET /m/usage`, the ops page) |
| Orders per unit, holds per order | 1 per 1.5 units, 1.3 | `USAGE#` orders and units; hold count from the logs |
| Merchant mix and drops per month | 60/30/10 Starter/Growth/Event | Pilot merchants |
| On-premise costs | S$3,500 per server, S$300 colocation, 4 h ops a month | Vendor quotes |
| Exchange rate | S$1.30 per US$ | — |
