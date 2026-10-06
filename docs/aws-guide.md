# AWS guide: how DropDeck runs on AWS

A short tour for anyone new to AWS or CloudFormation. It explains how our code becomes running AWS resources, and
where to look in the AWS console. For commands, see [`handover.md`](handover.md); for the parts and how they talk,
see the diagram in [`architecture.svg`](architecture.svg).

## The idea in one sentence

**CloudFormation builds AWS resources from a written description, and keeps them matching it.** Instead of clicking
through the console to make a table, five functions, an API and a website, we describe them in code. CloudFormation
creates them, updates them when the code changes, and deletes them together when asked.

## From our code to AWS

```
infra/lib/dropdeck-stack.ts      what we write (TypeScript, using AWS CDK)
        │  cdk synth
        ▼
CloudFormation template          one big JSON file listing every resource (generated; never edit it)
        │  cdk deploy
        ▼
Stack "DropDeck-dev-simon"       the real resources in AWS, managed as one unit
```

- **CDK** (Cloud Development Kit) is a library for writing infrastructure as code. A line like `new TableV2(...)`
  becomes a DynamoDB table in the template.
- **A template** is the generated JSON. Ours lists about 90 resources per stage (93 for staging, which also has a budget).
- **A stack** is one deployed copy of a template. Deploying the same code with `-c stage=staging` and
  `-c stage=dev-simon` gives two separate stacks: that is how one codebase gives us several environments.

## What happens during a deploy

1. **Synth.** CDK turns the TypeScript into a template and bundles each Lambda function's code.
2. **Upload.** The bundles and the website files go to an S3 bucket made by the `CDKToolkit` stack. That bucket is
   what "bootstrap" sets up, once per account.
3. **Change set.** CloudFormation compares the new template with what is running and works out the difference, for
   example "update the Claim function, leave the table alone".
4. **Apply.** It makes only those changes, in the right order (the table before the functions that use it).
5. **Rollback.** If any step fails, CloudFormation undoes the whole deploy and puts the stack back to its last
   working state. Nothing is left half-changed.

A small code change usually deploys in under a minute. The first deploy of a stage takes about 5 minutes, mostly
CloudFront setting up its global network.

## What is in a DropDeck stack

| Kind | Count | What it is for |
| --- | --- | --- |
| Lambda functions | 7 | Our 5 (Ticket, Claim, Checkout, MerchantApi, Controller) plus 2 CDK helpers: one uploads the website, one empties the bucket when the stack is deleted |
| API Gateway routes | 21 | Every buyer and merchant endpoint (see [`api.md`](api.md)), with the permissions that let them call the functions |
| IAM roles and policies | 15 | What each function is allowed to do, e.g. Claim may write to the table but not to S3 |
| DynamoDB table | 1 | All data: drops, stock, holds, orders |
| S3 bucket + CloudFront | 8 | The website and the `drop.json` / `state.json` files, served from the edge, with their caching rules |
| Cognito | 3 | Merchant sign-in: user pool, login domain, app client |
| Scheduler group | 1 | Holds each drop's "open" and "tick" schedules (created at run time by our code, not by the stack) |
| Log groups | 5 | One per function, kept a month |
| Budget | 1 | US$10 a month alarm, staging only |

## Our stacks

| Stack | What it is | Leave it alone? |
| --- | --- | --- |
| `DropDeck-staging` | The staging environment; GitHub deploys it on every push to `main` | Change it only through `main` |
| `DropDeck-dev-<name>` | Someone's personal environment | Its owner's to change or delete |
| `DropDeck-GithubOidc` | The role GitHub uses to deploy staging | **Yes**: staging deploys stop without it |
| `CDKToolkit` | CDK's one-time setup: the upload bucket and a few roles | **Yes**: every deploy uses it |
| `StackSet-Isb-…` | Made by the NUS Innovation Sandbox to manage the account | **Yes**: not ours |

## Finding your way in the console

1. Open the [NUS AWS portal](https://nus-aws-cloud.awsapps.com/start), click your account, then `nusisb_IsbUsersPS`.
2. Check the region at the top right says **Asia Pacific (Singapore)**. Most things only show in their own region.
3. Use the search box at the top to jump to a service.

### CloudFormation: one place to see everything

Open **CloudFormation → Stacks** and click a stack:

| Tab | Use it for |
| --- | --- |
| **Events** | The deploy log, newest first. **When a deploy fails, look here first**: the earliest red `CREATE_FAILED` or `UPDATE_FAILED` row says why |
| **Resources** | Everything the stack owns. Each name links to that resource in its own service |
| **Outputs** | Useful values: `SiteUrl`, `ApiUrl`, `TableName`, `UserPoolId`. Our scripts read these |
| **Template** | The generated JSON, if you are curious |

### Other services worth knowing

| Service | What you can see |
| --- | --- |
| **Lambda → Functions** | Each function's code size, settings and **Monitor** tab (calls, errors, duration) |
| **CloudWatch → Log groups** | What each function printed. **Logs Insights** can search them; queries are in [`api.md`](api.md) |
| **DynamoDB → Tables → Explore items** | The actual data: drops, stock counters, holds, orders |
| **S3 → Buckets** | The website files and each drop's `drop.json` / `state.json` under `d/` |
| **EventBridge → Scheduler → Schedules** | Upcoming drop openings (`open-…`) and running drops (`tick-…`) |
| **Cognito → User pools** | Merchant accounts that have signed up |
| **Billing and Cost Management** | What the account has spent. The console home page shows it too |

## Stack statuses

| Status | Meaning | What to do |
| --- | --- | --- |
| `CREATE_COMPLETE`, `UPDATE_COMPLETE` | Healthy; the last deploy worked | Nothing |
| `…_IN_PROGRESS` | A deploy or delete is running | Wait |
| `UPDATE_ROLLBACK_COMPLETE` | The last deploy failed and was undone; the stack still runs its previous version | Read **Events**, fix the cause, deploy again |
| `ROLLBACK_COMPLETE` | The very first deploy failed | Delete the stack, fix the cause, deploy again |
| `DELETE_FAILED` | Something could not be deleted | Read **Events**; usually retry the delete |

## Rules of thumb

- **Change infrastructure in code, then deploy.** Editing a stack's resource by hand in the console is invisible to
  CloudFormation ("drift"), and the next deploy may quietly undo it. Looking around in the console is always safe.
- **Deleting a stack deletes everything in it**, including the table's data and the merchant accounts. We set it up
  this way on purpose so test environments clean up fully. Only a stage named `prod` would keep its data.
- **Stacks do not share anything** except the account they live in. Breaking `dev-<you>` cannot affect staging.
- **Costs are close to zero when idle.** Nothing in a stack bills by the hour; you pay per request, per stored item and
  per log line. The whole sandbox account had cost US$0.04 in October 2026 by the 6th, with two stages running and the load tests done.

## Where this lives in the repo

| File | What it defines |
| --- | --- |
| `infra/bin/app.ts` | Which stacks exist, the stage name, and the list of accounts we may deploy to |
| `infra/lib/dropdeck-stack.ts` | Everything in a DropDeck stage, top to bottom |
| `infra/lib/github-oidc-stack.ts` | The role GitHub uses to deploy |
| `infra/test/stack.test.ts` | Checks on the generated template, e.g. "no NAT gateway", "state.json caching ignores query strings" |
| `.github/workflows/ci.yml` | The pipeline: tests on every pull request, staging deploy on every push to `main` |

## A first look, hands on

1. In **CloudFormation**, open `DropDeck-dev-simon` (or your own stack) → **Events**, and scroll to the bottom: that
   is the first deploy, step by step.
2. Open **Resources**, find the DynamoDB table, click it, then **Explore items**: the demo shop's drops and orders.
3. Back in **Resources**, click the Claim function, then **Monitor**: every claim buyers have made.
4. Open **Outputs** and visit `SiteUrl`: the site those resources serve.
