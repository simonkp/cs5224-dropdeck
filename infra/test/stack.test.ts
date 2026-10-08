import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack, REWRITE_FN } from '../lib/dropdeck-stack.js';
import { ROUTES } from '../../services/merchant-api/src/handler.js';
import { ROUTES as ADMIN_ROUTES } from '../../services/admin-api/src/handler.js';

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

describe('security', () => {
  const policy = () => Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))
    .map((r) => (r as { Properties: { ResponseHeadersPolicyConfig: Record<string, any> } }).Properties.ResponseHeadersPolicyConfig)[0]!;

  it('sends security headers on pages and JSON: CSP that forbids framing, HSTS, nosniff, referrer policy', () => {
    const cfg = policy();
    const csp: string = cfg.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy['Fn::Join']
      ? JSON.stringify(cfg.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy)
      : cfg.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(cfg.SecurityHeadersConfig.FrameOptions.FrameOption).toBe('DENY');
    expect(cfg.SecurityHeadersConfig.StrictTransportSecurity.AccessControlMaxAgeSec).toBeGreaterThanOrEqual(31536000);
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: { DefaultCacheBehavior: Record<string, unknown>; CacheBehaviors: Array<Record<string, unknown>> } } };
    expect(dist.Properties.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    for (const b of dist.Properties.DistributionConfig.CacheBehaviors) expect(b.ResponseHeadersPolicyId, String(b.PathPattern)).toBeDefined();
  });

  it('lets services write only their data prefixes, never the web app files', () => {
    type Pol = { Properties: { Roles: unknown; PolicyDocument: { Statement: Array<{ Action: string | string[]; Resource: unknown }> } } };
    // The CDK deployment custom resource uploads the web app itself, so it alone writes the whole bucket.
    const fnPolicies = (Object.values(template.findResources('AWS::IAM::Policy')) as Pol[])
      .filter((p) => !JSON.stringify(p.Properties.Roles).includes('CustomCDKBucketDeployment'));
    const writes = fnPolicies.flatMap((p) => p.Properties.PolicyDocument.Statement)
      .filter((st) => [st.Action].flat().some((a) => /^s3:(PutObject|DeleteObject)/.test(a)));
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      for (const r of [w.Resource].flat()) expect(JSON.stringify(r)).toMatch(/\/(d|s|b|p)\/\*"/);
    }
  });

  it('backs up and protects the table on staging, not on throwaway dev stages', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', { Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false } })]) });
    const staging = Template.fromStack(new DropDeckStack(new App(), 'Staging', {
      env: { account: '123456789012', region: 'ap-southeast-1' }, stage: 'staging', budgetUsd: 10, budgetEmail: '', webOrigins: [],
    }));
    staging.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true })]),
    });
  }, 30_000);

  it('hides whether an email has an account, and throttles ticket floods separately', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', { PreventUserExistenceErrors: 'ENABLED' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: Match.objectLike({ 'POST /api/d/{tenantId}/{dropId}/ticket': Match.objectLike({ ThrottlingRateLimit: 600 }) }),
    });
  });

  it('has an operators group and registers exactly the admin handler routes', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'operators' });
    const keys = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey);
    expect(keys.filter((k) => / \/admin\//.test(k)).sort()).toEqual([...ADMIN_ROUTES].sort());
  });
});

describe('own domain (optional)', () => {
  const synth = (extra: Record<string, unknown>) => Template.fromStack(new DropDeckStack(new App(), 'Dom', {
    env: { account: '123456789012', region: 'ap-southeast-1' }, stage: 'staging', budgetUsd: 10, budgetEmail: '', webOrigins: [], ...extra,
  }));
  it('changes nothing without a domain', () => {
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0] as { Properties: { DistributionConfig: Record<string, unknown> } };
    expect(dist.Properties.DistributionConfig.Aliases).toBeUndefined();
    template.resourceCountIs('AWS::SES::EmailIdentity', 0);
  });
  it('serves the site on the domain, keeps the cloudfront.net name for sign-in, and verifies the mail domain', () => {
    const t = synth({
      domainName: 'drops.example.com', certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
      sesDomain: 'example.com', mailFrom: 'DropDeck <codes@example.com>', signupEmailFromSes: true,
    });
    t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Aliases: ['drops.example.com'] }) });
    t.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'example.com' });
    t.hasResourceProperties('AWS::Cognito::UserPool', { EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER' }) });
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain('https://drops.example.com/m/callback/');
  });
  it('refuses half a configuration', () => {
    expect(() => synth({ domainName: 'drops.example.com' })).toThrow(/go together/);
    expect(() => synth({ signupEmailFromSes: true })).toThrow(/mailFrom/);
  });
});
