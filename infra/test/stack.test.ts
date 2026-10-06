import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack, REWRITE_FN } from '../lib/dropdeck-stack.js';
import { ROUTES } from '../../services/merchant-api/src/handler.js';

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
  it('serves every shop URL from /s/index.html, but not its shop.json or uploaded images', () => {
    expect(rewrite('/s/tb-sourdough/')).toBe('/s/index.html');
    expect(rewrite('/s/tb-sourdough')).toBe('/s/index.html');
    expect(rewrite('/s/tb-sourdough/shop.json')).toBe('/s/tb-sourdough/shop.json');
    expect(rewrite('/b/t1/0123456789abcdef0123456789abcdef.png')).toBe('/b/t1/0123456789abcdef0123456789abcdef.png');
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

describe('email codes', () => {
  const synth = (stage: string, mailFrom?: string) => Template.fromStack(new DropDeckStack(new App(), 'M', {
    env: { account: '123456789012', region: 'ap-southeast-1' }, stage, budgetUsd: 10, budgetEmail: '', webOrigins: [], mailFrom,
  }));
  it('runs in log mode without a sender, and never on prod', () => {
    expect(JSON.stringify(synth('dev-x').toJSON())).toContain('"MAIL_MODE":"log"');
    expect(() => synth('prod')).toThrow(/mailFrom/);
  });
  it('scopes SES sending to the sender domain', () => {
    const json = JSON.stringify(synth('staging', 'DropDeck <codes@drop.example>').toJSON());
    expect(json).toContain('"MAIL_MODE":"ses"');
    expect(json).toContain('identity/drop.example');
    expect(json).not.toMatch(/"Action":"ses:SendEmail","Effect":"Allow","Resource":"\*"/);
  });
});

describe('shop pages and uploads', () => {
  const behaviors = () => {
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: { CacheBehaviors: Array<Record<string, unknown>> } } };
    return dist.Properties.DistributionConfig.CacheBehaviors;
  };
  it('caches shop.json like drop.json, and serves uploads without the rewrite and with nosniff', () => {
    const byPath = Object.fromEntries(behaviors().map((b) => [b.PathPattern, b]));
    expect(byPath['s/*/shop.json']!.CachePolicyId).toEqual(byPath['d/*/drop.json']!.CachePolicyId);
    expect(byPath['b/*']!.FunctionAssociations).toBeUndefined();
    expect(byPath['b/*']!.ResponseHeadersPolicyId).toBeDefined();
  });
  it('refreshes the shop page HTML on deploy', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', { DistributionPaths: Match.arrayWith(['/s/index.html']) });
  });
  it('registers exactly the routes the merchant handler serves', () => {
    const keys = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
    expect(keys.filter((k) => / \/m\//.test(k)).sort()).toEqual([...ROUTES].sort());
  });
});

describe('branded sign-in', () => {
  it('uses the newer managed login with one branding style for the console client', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
  });
  it('stays on the Essentials plan, never Plus', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'ESSENTIALS' });
  });
});
