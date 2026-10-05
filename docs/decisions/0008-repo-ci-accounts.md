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
