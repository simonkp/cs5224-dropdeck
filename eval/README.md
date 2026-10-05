# Evaluation harness

Owned by Liwen from 19 Oct (drafting from the API contract before then). Each experiment writes its raw
output under `eval/results/<date>-<experiment>/` and a one-line summary into `eval/results/SUMMARY.md`.

| Experiment | Script (planned) | Reported result |
| --- | --- | --- |
| Oversell correctness | `oversell.ts` — N concurrent claims vs M units (built; also covered locally by `pnpm test:int`) | sold == min(N, M), no double release |
| Load and headroom | `k6/drop.js` — page, poll, ticket, claim at 1x, 3x, 10x | p50/p95/p99 per step, first degradation |
| Counter ceiling | `k6/claim-one-shard.js` with shardCount 1, 2, 4, 8 | write rate where one item saturates |
| Elasticity | CloudWatch query at open | cold-start share, time to serve at peak |
| Fairness | `fairness.ipynb` over ticket metrics | displacement distribution, draw on/off |
| Resilience | fault switches in `staging` | behaviour vs degradation policy |
| Cost per drop | `cost.ipynb` over per-drop metrics and the bill | cost per 1,000 admitted buyers |

Reference workload: 200 units, about 5,000 buyer sessions, a 10-minute window. Run heavy tests in the
shared `eval` stage only, behind the budget alarm, and `cdk destroy` afterwards.

Oversell against a deployed stage (needs `scripts/put-secrets.sh <stage>` done once):

```bash
AWS_PROFILE=dropdeck-uni pnpm --filter @dropdeck/eval oversell -- --stage dev-simon --n 500 --m 50
```
