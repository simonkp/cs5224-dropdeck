# DropDeck

Hosted drops for small Singapore merchants: a countdown, a fair waiting room, and stock that cannot
oversell. CS5224 Cloud Computing, AY2026/27 Sem 1, Team 8.

- **Build plan:** the team's DropDeck Build Plan doc (Claude Docs).
- **Start here:** [`docs/handover.md`](docs/handover.md) (state, setup, runbook, known gaps) and [`docs/api.md`](docs/api.md) (API contract). New to AWS: [`docs/aws-guide.md`](docs/aws-guide.md).
- **Decisions:** [`docs/decisions/`](docs/decisions/README.md). **AI-use log:** [`docs/ai-use.md`](docs/ai-use.md).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | Types, error codes, key builders, signed tokens, email normalisation, lifecycle and admission maths (pure, unit-tested) |
| `services/merchant-api` | Merchant routes: profile and branding, uploads, drop CRUD, schedule/unschedule/cancel/duplicate, reports |
| `services/admin-api` | Operator routes (`/admin/*`, Cognito group `operators`): shops, usage, plans |
| `services/ticket`, `claim`, `checkout`, `controller` | Buyer path and scheduler target. Email codes: log mode (code shown on the page) until the stage has a `mailFrom` for SES ([`docs/domain-setup.md`](docs/domain-setup.md)). Failure behaviour: [`docs/degradation.md`](docs/degradation.md) |
| `apps/web` | Next.js static export: `/` homepage and sign-up, `/d/{tenant}/{drop}` drop page, `/s/{slug}` shop page, `/m/` console, `/ops/` operators, `/privacy/` |
| `infra` | AWS CDK app: one stack per stage, plus a one-off GitHub OIDC stack |
| `tests/integration` | Real handlers in-process against DynamoDB Local (`pnpm test:int`, needs Docker; also a CI job) |
| `eval` | Experiments (`oversell.ts`, `e2e.ts`, cost model), demo seed, merchant study kit |

## First-time setup

### Run the frontend locally

Use Node.js 22 or newer (Node 22 is used in CI). From the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open <http://localhost:3000>. `corepack pnpm` uses the version pinned in `packageManager`
without replacing an existing global pnpm installation. Stop the server with Ctrl+C.

The web scripts use webpack because Turbopack's CSS worker failed to bind its local socket
in the macOS setup environment. Both development and static export are verified with webpack.

The homepage, privacy page and merchant sign-in screen can render without AWS configuration.
Sign-up, sign-in, merchant data and buyer transactions require a deployed AWS development stage;
the repository does not include an offline backend. Copy that stage's `config.json` into
`apps/web/public/config.json` as described below. Docker is only needed for the DynamoDB integration
tests, not for the frontend or production build.

### Validate and deploy

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
(`stageSettings`), empty until the domain is bought; [`docs/domain-setup.md`](docs/domain-setup.md) has the steps.

## Week 1 checklist (exit: a drop can be created and viewed)

- [x] Monorepo, shared library, CDK stack, CI workflow
- [x] Merchant API: profile, drop CRUD, lifecycle transitions, publish `drop.json`, open schedule
- [x] Drop page reading `drop.json`, polling `state.json`, countdown on server time
- [x] Create GitHub repo, push, deploy OIDC stack, first green `staging` deploy
- [x] Console sign-in (Cognito managed login, code + PKCE) and drop editor
- [ ] Buy domain, verify in SES, request production access (stack ready; steps in `docs/domain-setup.md`)

### Populated local design preview

Run `pnpm dev:demo`, then open [the scenario gallery](http://localhost:3000/__preview/).
This development-only mode supplies local buyer and merchant data without AWS credentials.
The checkout test code is `123456`; no email or payment is sent. Reset fixtures from the gallery.
The local preview simulates services. Connected Cognito, SES, CloudFront and scheduled-controller checks require a development AWS deployment.

Production export is unchanged: `pnpm web:build`, then `pnpm web:verify-production` verifies that demo fixtures and the preview route are excluded.
