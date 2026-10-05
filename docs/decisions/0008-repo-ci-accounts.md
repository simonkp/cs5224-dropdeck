# 0008. GitHub with Actions and OIDC; personal dev accounts plus one shared evaluation account

- **Status:** Accepted
- **Date:** 2026-10-05
- **Decided by:** Simon, confirming the team's workflow review

## Context

TAs need repo access until marks are out. Credits are per AWS account; load tests burn them.

## Decision

Private GitHub repo with a TA token. GitHub Actions runs type-check, tests, web build and cdk synth on every PR, and deploys `staging` on merge to main through an OIDC role that may only assume the CDK bootstrap roles. Each developer deploys `dev-<name>` to a personal account; staging, load tests and the cohort drop run in one shared account so cost comes from one bill.

## Options rejected

- **Self-hosted GitLab** — TA access would depend on a personal server staying up.
- **One shared account for everything** — Development would eat the credits load tests need.

## Consequences

No long-lived AWS keys in GitHub.

## Change from the preliminary report

Matches the preliminary plan; adds the account split.

## Amendment (2026-10-05): the NUS Innovation Sandbox

Each student was given an AWS Innovation Sandbox account (IAM Identity Center, US$50). Simon's
(`337542796977`, "NUS ISB Account 19") is the shared staging and evaluation account. Findings that changed the setup:

- **CDK bootstrap roles cannot be assumed.** An SCP explicitly denies `sts:AssumeRole` on the `cdk-*` roles.
  The CLI falls back to the caller's credentials and still passes CloudFormation the bootstrap execution role,
  so the GitHub deploy role carries only that fallback's permissions (CloudFormation on `DropDeck-*`, the asset
  bucket, the bootstrap version parameter, `iam:PassRole` on the execution role to CloudFormation).
- **GitHub sends immutable OIDC subjects** for this repo (`repo:simonkp@5468350/cs5224-dropdeck@1405294986:...`);
  the role trusts both that and the name-based form (`-c githubSubPrefix`).
- **CloudTrail lookups are denied** by SCP, so deploy and auth failures are diagnosed from CI and Lambda logs.
- Open questions for the module staff: the lease end date (sandboxes are wiped when it ends) and what happens
  at US$50. If the lease ends before marking, staging and the cohort drop move to a member's own account.
