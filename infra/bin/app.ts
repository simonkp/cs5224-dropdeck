#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DropDeckStack } from '../lib/dropdeck-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

const app = new App();
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-1' };

// Refuse to synth against an account that isn't ours (e.g. a work profile left as [default]).
// Accepts the cdk.json array or a comma-separated `-c allowedAccounts=...` for a personal dev account.
const allowedCtx = (app.node.tryGetContext('allowedAccounts') as string[] | string | undefined) ?? [];
const allowedAccounts = Array.isArray(allowedCtx) ? allowedCtx : allowedCtx.split(',').map((a) => a.trim());
if (env.account && !allowedAccounts.includes(env.account)) {
  throw new Error(`Account ${env.account} is not in cdk.json "allowedAccounts"; check AWS_PROFILE.`);
}

// Per-stage settings live in cdk.json under "stageSettings" (so CI deploys staging with them); -c flags override.
const stageSettings = ((app.node.tryGetContext('stageSettings') ?? {}) as Record<string, Record<string, unknown>>)[stage] ?? {};
const setting = (name: string): string | undefined => {
  const v = app.node.tryGetContext(name) ?? stageSettings[name];
  return v === undefined || v === '' ? undefined : String(v);
};

const stack = new DropDeckStack(app, `DropDeck-${stage}`, {
  env,
  stage,
  budgetUsd: Number(app.node.tryGetContext('budgetUsd') ?? 10),
  budgetEmail: String(app.node.tryGetContext('budgetEmail') ?? ''),
  webOrigins: (app.node.tryGetContext('webOrigins') as string[] | undefined) ?? [],
  ticketBlockSize: Number(app.node.tryGetContext('ticketBlockSize') ?? 10),
  mailFrom: setting('mailFrom'),
  resendFallback: setting('resendFallback') === 'true',
  domainName: setting('domainName'),
  certificateArn: setting('certificateArn'),
  sesDomain: setting('sesDomain'),
  signupEmailFromSes: setting('signupEmailFromSes') === 'true',
});
Tags.of(stack).add('Project', 'DropDeck');
Tags.of(stack).add('Stage', stage);

// One-off per shared account: lets GitHub Actions deploy through the CDK bootstrap roles.
const githubRepo = String(app.node.tryGetContext('githubRepo') ?? '');
const githubSubPrefix = String(app.node.tryGetContext('githubSubPrefix') ?? '') || undefined;
if (githubRepo) new GithubOidcStack(app, 'DropDeck-GithubOidc', { env, githubRepo, githubSubPrefix });
