# Setup, deploy and demo data

How to build DropDeck, deploy your own stage and load demo data. The project overview is in the
[README](../README.md). The team runbook and known gaps are in [`handover.md`](handover.md), the API contract in
[`api.md`](api.md), and an introduction to the AWS services used in [`aws-guide.md`](aws-guide.md).

Paths below are relative to the repository root.

## First-time setup

```bash
corepack enable            # pnpm 10 via packageManager
pnpm install
pnpm typecheck && pnpm test
pnpm test:int              # oversell and friends against DynamoDB Local (Docker)
pnpm web:build             # apps/web/out, uploaded by the CDK stack
```

Deploy your own dev stage (personal AWS account, region ap-southeast-1). Always use a named profile:
synth refuses any account not in `allowedAccounts` (`infra/cdk.json`, or `-c allowedAccounts=<id>`).

```bash
cd infra
export AWS_PROFILE=<your-dropdeck-profile>
npx cdk bootstrap                         # once per account/region
npx cdk deploy DropDeck-dev-simon -c stage=dev-simon -c budgetEmail=you@example.com
npx cdk destroy DropDeck-dev-simon -c stage=dev-simon   # when idle
../scripts/put-secrets.sh dev-simon       # signing keys as SSM SecureStrings (week 2)
```

Shared account, once: `npx cdk deploy DropDeck-GithubOidc -c githubRepo=<owner>/<repo> -c githubSubPrefix=<prefix>`
(the prefix is `sub_claim_prefix` from `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`; repos on GitHub's
immutable subjects send IDs, not names, and the name-only trust is refused), then add the
output role ARN as the `AWS_DEPLOY_ROLE_ARN` repository variable and `BUDGET_EMAIL` as another.
Merges to `main` then deploy `staging` and run a smoke test; until `AWS_DEPLOY_ROLE_ARN` is set the
deploy job is skipped rather than failing.

Console against a deployed dev stage from `next dev`: deploy with `-c webOrigins='["http://localhost:3000"]'`
(honoured on `dev-*` stages only), copy that stage's `<SiteUrl>/config.json` to `apps/web/public/config.json`
(git-ignored), then `pnpm --filter web dev`.

Demo data instead of clicking through the console (sign up at `<SiteUrl>/` with "Start your shop" first, so the shop is yours). Before a
demo or test session, reset the stage and get a fresh list of links:

```bash
pnpm demo:reset -- dev-simon            # signs you in to AWS if needed, wipes, seeds, prints the test links
pnpm demo:reset -- dev-simon you@example.com --opens-in 5
```

It runs the seed below with `--clear`, picks the stage's console user as the owner when there is only one, and uses
`AWS_PROFILE=dropdeck-uni` unless you set another. The seed on its own:

```bash
AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1 pnpm seed -- --stage dev-simon --owner you@example.com --clear
```

`--clear` wipes the stage's table, published drop files, shop pages, the homepage list, uploaded images and schedules (dev stages only
unless `--force`), then loads one shop with a draft, a scheduled drop (opens in `--opens-in` minutes, default 10), a
Live drop with orders, a closed drop with paid / unpaid / no-show orders, and a cancelled drop. It also loads two
more branded shops (Kopi Lab, dark; Hue Ceramics, light) with a countdown drop each, to show other brands side by
side. All three shops are listed on the homepage, so its "See a live drop" section shows their drops. Photos and
logos come from `eval/assets/seed` (sources in `CREDITS.md`). `--no-load` only clears.

## Guardrails (tested in `infra/test`)

- No VPC, NAT gateway, cache cluster or WAF: nothing bills by the hour.
- `state.json` is cached 1–5 s and its cache key ignores query strings, headers and cookies. Clients
  poll a fixed URL; **never add a cache-busting parameter**.
- API stage throttling (tickets and uploads throttled separately) and a monthly budget alarm per stage.
- Security headers (CSP, no framing, HSTS) on every page; functions write only their own bucket prefixes; staging and
  prod tables have point-in-time recovery and deletion protection. See `docs/security.md`.

Cost per drop, the idle month and the comparison with an EC2 + load balancer stack and with on-premise servers are in
`docs/cost-bom.md`. Operators (DropDeck staff) use `<SiteUrl>/ops/` and `pnpm ops` (decision 0013).

Our own domain and email (certificate, DNS, SES production access) are per-stage settings in `infra/cdk.json`
(`stageSettings`), empty until the domain is bought; [`docs/domain-setup.md`](domain-setup.md) has the steps.
