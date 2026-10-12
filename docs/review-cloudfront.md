# CloudFront design-review preview

This is a **separate public CloudFront site** for reviewing the UI on `feat/dropdeck-ui-workflow`. It runs the simulated buyer and merchant scenarios in the browser. It has no API Gateway, Cognito, SES, order storage, or connection to staging, and no real purchase or payment can occur. Each reviewer's changes stay in that browser's local storage.

From the repository root:

```bash
git switch feat/dropdeck-ui-workflow
pnpm web:review-build
```

This creates the ignored `apps/web/review-out/` directory. The normal `pnpm web:build` still produces `apps/web/out/` without fixtures; `pnpm web:verify-production` checks that boundary. The review build is deliberately moved out of `out/`, so a regular app deploy cannot accidentally ship it.

Use an AWS profile with CloudFormation, S3 and CloudFront deployment rights in an account listed in `infra/cdk.json`. Then deploy from `infra`:

```bash
export AWS_PROFILE=<team-profile> AWS_REGION=ap-southeast-1
aws sts get-caller-identity
cd infra
npx cdk deploy DropDeck-UiReview -c review=true --require-approval never --outputs-file review-outputs.json
```

Share the `ReviewUrl` output for the familiar landing page, and append `/__preview/` for the scenario gallery. Buyer URLs like `/d/preview/held/` and the merchant console at `/m/` use the same static export. The banner labels all screens as simulated. The review stack owns its own private S3 bucket and CloudFront distribution, leaving `DropDeck-staging` untouched.

When review is finished, remove the temporary site:

```bash
cd infra
npx cdk destroy DropDeck-UiReview -c review=true --force
```
