#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DropDeckStack } from '../lib/dropdeck-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

const app = new App();
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-1' };

const stack = new DropDeckStack(app, `DropDeck-${stage}`, {
  env,
  stage,
  budgetUsd: Number(app.node.tryGetContext('budgetUsd') ?? 30),
  budgetEmail: String(app.node.tryGetContext('budgetEmail') ?? ''),
  webOrigins: (app.node.tryGetContext('webOrigins') as string[] | undefined) ?? [],
});
Tags.of(stack).add('Project', 'DropDeck');
Tags.of(stack).add('Stage', stage);

// One-off per shared account: lets GitHub Actions deploy through the CDK bootstrap roles.
const githubRepo = String(app.node.tryGetContext('githubRepo') ?? '');
if (githubRepo) new GithubOidcStack(app, 'DropDeck-GithubOidc', { env, githubRepo });
