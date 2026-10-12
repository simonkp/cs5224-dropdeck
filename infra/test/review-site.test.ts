import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ReviewSiteStack } from '../lib/review-site-stack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = Template.fromStack(new ReviewSiteStack(new App(), 'Review', {
  env: { account: '123456789012', region: 'ap-southeast-1' },
  assetPath: path.resolve(here, './fixtures/review-site'),
}));

describe('isolated design review site', () => {
  it('serves static assets privately through one CloudFront distribution', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, BlockPublicPolicy: true }) });
    expect(Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))).toHaveLength(0);
    expect(Object.keys(template.findResources('AWS::Cognito::UserPool'))).toHaveLength(0);
    expect(Object.keys(template.findResources('AWS::DynamoDB::GlobalTable'))).toHaveLength(0);
  });
});
