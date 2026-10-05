import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack } from '../lib/dropdeck-stack.js';

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
