import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import {
  AllowedMethods, CachePolicy, Distribution, Function as CfFunction, FunctionCode, FunctionEventType,
  ViewerProtocolPolicy, CacheQueryStringBehavior, CacheHeaderBehavior, CacheCookieBehavior,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AccountRecovery, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export interface DropDeckStackProps extends StackProps {
  stage: string;
  budgetUsd: number;
  budgetEmail: string;
  webOrigins: string[];
}

/**
 * Everything one stage needs. Rule: nothing that bills by the hour.
 * See docs/decisions/ for why each piece is (or is not) here.
 */
export class DropDeckStack extends Stack {
  constructor(scope: Construct, id: string, props: DropDeckStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const ephemeral = stage !== 'prod';

    // ---- Data: one on-demand table, sparse GSI1 for hold expiry ----
    const table = new TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [{
        indexName: 'GSI1',
        partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
        sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      }],
    });

    // ---- Edge: private bucket behind CloudFront ----
    const bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: ephemeral,
    });
    const origin = S3BucketOrigin.withOriginAccessControl(bucket);

    // state.json: short TTL, and the cache key ignores query strings, headers and cookies,
    // so cache-busting cannot turn polls into origin fetches (denial-of-wallet defence).
    const statePolicy = new CachePolicy(this, 'StateJsonPolicy', {
      defaultTtl: Duration.seconds(2),
      minTtl: Duration.seconds(1),
      maxTtl: Duration.seconds(5),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const dropJsonPolicy = new CachePolicy(this, 'DropJsonPolicy', {
      defaultTtl: Duration.seconds(30),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(60),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
    });

    // /d/{tenant}/{drop} and other extension-less paths map onto the static export.
    const rewrite = new CfFunction(this, 'RewriteFn', {
      code: FunctionCode.fromInline(`function handler(event) {
  var r = event.request; var uri = r.uri;
  if (uri.endsWith('/')) { r.uri = uri + 'index.html'; return r; }
  var last = uri.split('/').pop();
  if (last.indexOf('.') !== -1) return r;
  if (uri.indexOf('/d/') === 0) { r.uri = '/d/index.html'; return r; }
  r.uri = uri + '/index.html'; return r;
}`),
    });

    const distribution = new Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: rewrite, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        'd/*/state.json': { origin, cachePolicy: statePolicy, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_GET_HEAD },
        'd/*/drop.json': { origin, cachePolicy: dropJsonPolicy, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_GET_HEAD },
      },
    });
    const siteUrl = `https://${distribution.distributionDomainName}`;

    // ---- Merchant identity ----
    const userPool = new UserPool(this, 'Merchants', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    const userPoolClient = new UserPoolClient(this, 'ConsoleClient', {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true, userPassword: true },
    });

    // ---- Scheduling ----
    const scheduleGroup = new CfnScheduleGroup(this, 'ScheduleGroup', { name: `dropdeck-${stage}` });

    // ---- Functions ----
    const fn = (name: string, entry: string, extra: { memory?: number; timeout?: number } = {}) => {
      const logGroup = new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, name, {
        entry: path.join(repoRoot, entry),
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: extra.memory ?? 512,
        timeout: Duration.seconds(extra.timeout ?? 10),
        logGroup,
        environment: { TABLE_NAME: table.tableName, BUCKET_NAME: bucket.bucketName, STAGE: stage },
        bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22' },
      });
    };

    const merchantFn = fn('MerchantApi', 'services/merchant-api/src/handler.ts');
    const ticketFn = fn('Ticket', 'services/ticket/src/handler.ts', { memory: 256 });
    const claimFn = fn('Claim', 'services/claim/src/handler.ts');
    const checkoutFn = fn('Checkout', 'services/checkout/src/handler.ts');
    const controllerFn = fn('Controller', 'services/controller/src/handler.ts', { timeout: 70 });

    for (const f of [merchantFn, ticketFn, claimFn, checkoutFn, controllerFn]) table.grantReadWriteData(f);
    bucket.grantPut(merchantFn);
    bucket.grantDelete(merchantFn);
    bucket.grantPut(controllerFn);
    checkoutFn.addToRolePolicy(new PolicyStatement({ actions: ['ses:SendEmail'], resources: ['*'] }));

    const schedulerRole = new Role(this, 'SchedulerRole', { assumedBy: new ServicePrincipal('scheduler.amazonaws.com') });
    controllerFn.grantInvoke(schedulerRole);
    merchantFn.addEnvironment('CONTROLLER_ARN', controllerFn.functionArn);
    merchantFn.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    merchantFn.addEnvironment('SCHEDULE_GROUP', scheduleGroup.name!);
    controllerFn.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    controllerFn.addEnvironment('SCHEDULE_GROUP', scheduleGroup.name!);
    const scheduleArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`;
    for (const f of [merchantFn, controllerFn]) {
      f.addToRolePolicy(new PolicyStatement({ actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'], resources: [scheduleArn] }));
      f.addToRolePolicy(new PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }));
    }

    // ---- API ----
    const api = new HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: [siteUrl, ...props.webOrigins],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        maxAge: Duration.hours(1),
      },
    });
    // Stage-wide throttling; re-tuned from the 10x load test result.
    const cfnStage = api.defaultStage!.node.defaultChild as CfnStage;
    cfnStage.defaultRouteSettings = { throttlingBurstLimit: 2000, throttlingRateLimit: 1000 };

    const authorizer = new HttpUserPoolAuthorizer('MerchantAuth', userPool, { userPoolClients: [userPoolClient] });
    const merchantIntegration = new HttpLambdaIntegration('MerchantInt', merchantFn);
    const merchantRoutes: Array<[HttpMethod, string]> = [
      [HttpMethod.GET, '/m/profile'], [HttpMethod.PUT, '/m/profile'],
      [HttpMethod.GET, '/m/drops'], [HttpMethod.POST, '/m/drops'],
      [HttpMethod.GET, '/m/drops/{dropId}'], [HttpMethod.PATCH, '/m/drops/{dropId}'], [HttpMethod.DELETE, '/m/drops/{dropId}'],
      [HttpMethod.POST, '/m/drops/{dropId}/schedule'], [HttpMethod.POST, '/m/drops/{dropId}/unschedule'],
      [HttpMethod.POST, '/m/drops/{dropId}/cancel'], [HttpMethod.POST, '/m/drops/{dropId}/duplicate'],
      [HttpMethod.GET, '/m/drops/{dropId}/live'], [HttpMethod.GET, '/m/drops/{dropId}/orders'],
      [HttpMethod.PATCH, '/m/orders/{ref}'], [HttpMethod.GET, '/m/drops/{dropId}/export.csv'],
      [HttpMethod.GET, '/m/drops/{dropId}/report'],
    ];
    for (const [method, p] of merchantRoutes) {
      api.addRoutes({ path: p, methods: [method], integration: merchantIntegration, authorizer });
    }
    api.addRoutes({ path: '/api/d/{tenantId}/{dropId}/ticket', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('TicketInt', ticketFn) });
    api.addRoutes({ path: '/api/d/{tenantId}/{dropId}/claim', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('ClaimInt', claimFn) });
    const checkoutInt = new HttpLambdaIntegration('CheckoutInt', checkoutFn);
    api.addRoutes({ path: '/api/holds/{holdId}', methods: [HttpMethod.GET], integration: checkoutInt });
    api.addRoutes({ path: '/api/holds/{holdId}/otp', methods: [HttpMethod.POST], integration: checkoutInt });
    api.addRoutes({ path: '/api/holds/{holdId}/confirm', methods: [HttpMethod.POST], integration: checkoutInt });

    // ---- Web app (static export) + runtime config ----
    const webOut = path.join(repoRoot, 'apps/web/out');
    const runtimeConfig = Source.jsonData('config.json', {
      apiUrl: api.apiEndpoint, userPoolId: userPool.userPoolId, userPoolClientId: userPoolClient.userPoolClientId, stage,
    });
    new BucketDeployment(this, 'DeployWeb', {
      destinationBucket: bucket,
      sources: existsSync(webOut) ? [Source.asset(webOut), runtimeConfig] : [runtimeConfig],
      prune: false, // never delete d/* objects written by the services
      distribution,
      distributionPaths: ['/index.html', '/config.json', '/d/index.html', '/m/index.html'],
    });

    // ---- Cost guard ----
    if (props.budgetEmail) {
      new CfnBudget(this, 'Budget', {
        budget: { budgetName: `dropdeck-${stage}`, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.budgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [50, 80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
        })),
      });
    }

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
