# Evaluation harness

Anyone on the team can pick up an experiment; the API contract is in [`docs/api.md`](../docs/api.md). Each experiment writes its raw
output under `eval/results/<date>-<experiment>/` and a one-line summary into `eval/results/SUMMARY.md`.

| Experiment | Script (planned) | Reported result |
| --- | --- | --- |
| Oversell correctness | `oversell.ts` — N concurrent claims vs M units (built; also covered locally by `pnpm test:int`) | sold == min(N, M), no double release |
| Load and headroom | `load.ts` — join, wait, claim, confirm on a real scheduled drop at `--scale` 1, 3, 10 (built; TypeScript like `oversell.ts`, not k6, so it needs nothing installed; the crowd's polling is not reproduced) | p50/p95/p99 per step, first degradation |
| Counter ceiling | `k6/claim-one-shard.js` with shardCount 1, 2, 4, 8 | write rate where one item saturates |
| Elasticity | CloudWatch query at open | cold-start share, time to serve at peak |
| Fairness | `fairness.ipynb` over ticket metrics | displacement distribution, draw on/off |
| Resilience | fault switches in `staging` | behaviour vs [`docs/degradation.md`](../docs/degradation.md) |
| Cost per drop | `cost.ipynb` over per-drop metrics and the bill | cost per 1,000 admitted buyers |

Reference workload: 200 units, about 5,000 buyer sessions, a 10-minute window. Run heavy tests in the
shared `eval` stage only, behind the budget alarm, and `cdk destroy` afterwards.

Load against a deployed stage (about 7 minutes a run; `--dry-run` prints the arrival plan without touching AWS):

```bash
AWS_PROFILE=dropdeck-uni pnpm --filter @dropdeck/eval load -- --stage dev-simon --scale 1    # then 3, then 10
```

Options:
- **Crowd shape:** `--spike-sec 1` puts half the crowd into 1 s, `--spike-sec 30` spreads it over 30 s.
- **The page's spreading:** `--spread-sec 10` makes each pre-draw join wait a random 0–10 s, as the buyer page does. `--spread-share 0.5` makes only half the buyers do it, like scripts or old cached pages.
- **Time on the page:** `--checkout-sec 20-60` sets how long buyers take to check out. `--abandon-share 0.2` makes one in five leave without confirming.

Results from 13–19 Oct are written up in [`docs/join-under-load.md`](../docs/join-under-load.md).

Stages share the account's Lambda concurrency, so agree a time before a 3x or 10x run. Leave 15 minutes between runs so each starts cold (each result says whether it did), and keep the machine awake: a sleeping laptop spoils the run.

Oversell against a deployed stage (needs `scripts/put-secrets.sh <stage>` done once):

```bash
AWS_PROFILE=dropdeck-uni pnpm --filter @dropdeck/eval oversell -- --stage dev-simon --n 500 --m 50
```
