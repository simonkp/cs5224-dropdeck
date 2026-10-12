import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AllowedMethods, CachePolicy, Distribution, Function as CfFunction, FunctionCode, FunctionEventType,
  ResponseHeadersPolicy, ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import { REWRITE_FN } from './dropdeck-stack.js';

export interface ReviewSiteStackProps extends StackProps { assetPath?: string; redirectUrl?: string }

/** Separate, disposable CloudFront site for the simulated design gallery. No buyer API or merchant data. */
export class ReviewSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: ReviewSiteStackProps) {
    super(scope, id, props);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const reviewOut = props.assetPath ?? path.resolve(here, '../../apps/web/review-out');
    if (!existsSync(path.join(reviewOut, 'index.html'))) throw new Error('Run pnpm web:review-build before deploying the review site');

    const bucket = new Bucket(this, 'ReviewBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Once a connected dev stage replaces the simulated gallery, keep existing review links useful.
    // A viewer-request redirect also makes every former preview path inaccessible without deleting the stack.
    const redirect = props.redirectUrl?.replace(/\/$/, '');
    if (redirect && !/^https:\/\/[a-z0-9.-]+$/i.test(redirect)) throw new Error('redirectUrl must be an HTTPS origin');
    const redirectFn = redirect ? `function handler(event) {
  var uri = event.request.uri;
  if (uri === '/__preview/' || uri.indexOf('/d/preview/') === 0) uri = '/';
  return { statusCode: 302, statusDescription: 'Found', headers: {
    location: { value: ${JSON.stringify(redirect)} + uri }
  }};
}` : REWRITE_FN;
    const rewrite = new CfFunction(this, 'RewriteFn', { code: FunctionCode.fromInline(redirectFn) });
    const distribution = new Distribution(this, 'ReviewCdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: rewrite, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
    });
    new BucketDeployment(this, 'DeployReview', {
      destinationBucket: bucket,
      sources: [Source.asset(reviewOut)],
      distribution,
      distributionPaths: ['/*'],
    });
    new CfnOutput(this, 'ReviewUrl', { value: `https://${distribution.distributionDomainName}/` });
  }
}
