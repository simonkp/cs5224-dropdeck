# DropDeck

Hosted drops for small Singapore merchants: a countdown, a fair waiting room, and stock that cannot
oversell. CS5224 Cloud Computing, AY2026/27 Sem 1, Team 8.

- **Build plan:** the team's DropDeck Build Plan doc (Claude Docs).
- **Decisions:** [`docs/decisions/`](docs/decisions/README.md). **AI-use log:** [`docs/ai-use.md`](docs/ai-use.md).

## Layout

| Path | What |
| --- | --- |
| `packages/shared` | Types, error codes, key builders, signed tokens, email normalisation, lifecycle and admission maths (pure, unit-tested) |
| `services/merchant-api` | Merchant routes: profile, drop CRUD, schedule/unschedule/cancel/duplicate |
| `services/ticket`, `claim`, `checkout`, `controller` | Buyer path and scheduler target (the email code at checkout is still to come). Failure behaviour: [`docs/degradation.md`](docs/degradation.md) |
| `apps/web` | Next.js static export: landing, `/d/{tenant}/{drop}` drop page, `/m/` console |
| `infra` | AWS CDK app: one stack per stage, plus a one-off GitHub OIDC stack |
| `tests/integration` | Real handlers in-process against DynamoDB Local (`pnpm test:int`, needs Docker; also a CI job) |
| `eval` | Load, fairness and cost experiments (`oversell.ts` built) |

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

Demo data instead of clicking through the console (sign up at `<SiteUrl>/m/` first so the shop is yours):

```bash
AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1 pnpm seed -- --stage dev-simon --owner you@example.com --clear
```

`--clear` wipes the stage's table, published drop files and schedules (dev stages only unless `--force`), then
loads one shop with a draft, a scheduled drop (opens in `--opens-in` minutes, default 10), a Live drop with
orders, a closed drop with paid / unpaid / no-show orders, and a cancelled drop. `--no-load` only clears.

## Guardrails (tested in `infra/test`)

- No VPC, NAT gateway, cache cluster or WAF: nothing bills by the hour.
- `state.json` is cached 1–5 s and its cache key ignores query strings, headers and cookies. Clients
  poll a fixed URL; **never add a cache-busting parameter**.
- API stage throttling and a monthly budget alarm per stage.

## Week 1 checklist (exit: a drop can be created and viewed)

- [x] Monorepo, shared library, CDK stack, CI workflow
- [x] Merchant API: profile, drop CRUD, lifecycle transitions, publish `drop.json`, open schedule
- [x] Drop page reading `drop.json`, polling `state.json`, countdown on server time
- [ ] Create GitHub repo, push, deploy OIDC stack, first green `staging` deploy
- [x] Console sign-in (Cognito managed login, code + PKCE) and drop editor (code done; not yet deployed)
- [ ] Buy domain, verify in SES, request production access
