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
| `services/ticket`, `claim`, `checkout`, `controller` | Buyer path and scheduler target (week 2; TODO lists in each handler) |
| `apps/web` | Next.js static export: landing, `/d/{tenant}/{drop}` drop page, `/m/` console |
| `infra` | AWS CDK app: one stack per stage, plus a one-off GitHub OIDC stack |
| `eval` | Load, fairness and cost experiments |

## First-time setup

```bash
corepack enable            # pnpm 10 via packageManager
pnpm install
pnpm typecheck && pnpm test
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

Shared account, once: `npx cdk deploy DropDeck-GithubOidc -c githubRepo=<owner>/<repo>`, then add the
output role ARN as the `AWS_DEPLOY_ROLE_ARN` repository variable and `BUDGET_EMAIL` as another.
Merges to `main` then deploy `staging` and run a smoke test; until `AWS_DEPLOY_ROLE_ARN` is set the
deploy job is skipped rather than failing.

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
- [ ] Console sign-in (Cognito) and drop editor
- [ ] Buy domain, verify in SES, request production access
