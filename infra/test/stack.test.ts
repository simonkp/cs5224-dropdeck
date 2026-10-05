import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack, REWRITE_FN } from '../lib/dropdeck-stack.js';

const template = Template.fromStack(new DropDeckStack(new App(), 'Test', {
  env: { account: '123456789012', region: 'ap-southeast-1' },
  stage: 'test', budgetUsd: 30, budgetEmail: 'ops@example.com', webOrigins: [],
}));

describe('cost guardrails: nothing bills by the hour', () => {
  it('has no VPC, NAT gateway or cache cluster', () => {
    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::NatGateway', 'AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::ServerlessCache', 'AWS::WAFv2::WebACL']) {
      expect(Object.keys(template.findResources(type))).toHaveLength(0);
    }
  });
  it('uses on-demand DynamoDB', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', { BillingMode: 'PAY_PER_REQUEST' });
  });
  it('caches state.json without query strings, headers or cookies', () => {
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 2,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          QueryStringsConfig: { QueryStringBehavior: 'none' },
          HeadersConfig: { HeaderBehavior: 'none' },
          CookiesConfig: { CookieBehavior: 'none' },
        }),
      }),
    });
  });
  it('throttles the API stage', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: Match.anyValue() }),
    });
  });
  it('alerts on budget', () => {
    template.resourceCountIs('AWS::Budgets::Budget', 1);
  });
});

describe('CloudFront rewrite', () => {
  // eslint-disable-next-line no-new-func
  const handler = new Function(`${REWRITE_FN}; return handler;`)() as (e: { request: { uri: string } }) => { uri: string };
  const rewrite = (uri: string) => handler({ request: { uri } }).uri;

  it('serves every drop URL, with or without a trailing slash, from /d/index.html', () => {
    expect(rewrite('/d/t1/d1/')).toBe('/d/index.html');
    expect(rewrite('/d/t1/d1')).toBe('/d/index.html');
  });
  it('leaves files alone, including the polled JSON', () => {
    expect(rewrite('/d/t1/d1/state.json')).toBe('/d/t1/d1/state.json');
    expect(rewrite('/_next/static/app.js')).toBe('/_next/static/app.js');
  });
  it('maps directories onto index.html', () => {
    expect(rewrite('/')).toBe('/index.html');
    expect(rewrite('/m/')).toBe('/m/index.html');
    expect(rewrite('/m/callback')).toBe('/m/callback/index.html');
  });
});

describe('merchant sign-in and signing keys', () => {
  it('uses the code flow with a callback on the site', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: ['code'],
      GenerateSecret: false,
    });
  });
  it('gives the buyer-path functions the token key parameter name', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function'))
      .filter((r) => (r as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables?.TOKEN_KEY_PARAM);
    expect(fns).toHaveLength(4);
  });
  it('allows localhost origins on dev stages only', () => {
    const synth = (stage: string) => JSON.stringify(Template.fromStack(new DropDeckStack(new App(), 'S', {
      env: { account: '123456789012', region: 'ap-southeast-1' },
      stage, budgetUsd: 30, budgetEmail: '', webOrigins: ['http://localhost:3000'],
    })).toJSON());
    expect(synth('staging')).not.toContain('localhost');
    expect(synth('dev-simon')).toContain('http://localhost:3000/m/callback/');
  });
});
