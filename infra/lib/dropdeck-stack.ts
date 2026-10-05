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
import { AccountRecovery, OAuthScope, UserPool, UserPoolClient, UserPoolClientIdentityProvider } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** CloudFront Function (viewer request). Exported for the unit test, which runs it in Node. */
export const REWRITE_FN = `function handler(event) {
  var r = event.request; var uri = r.uri;
  var last = uri.split('/').pop();
  if (last.indexOf('.') !== -1) return r;
  if (uri.indexOf('/d/') === 0) { r.uri = '/d/index.html'; return r; }
  if (uri.endsWith('/')) { r.uri = uri + 'index.html'; return r; }
  r.uri = uri + '/index.html'; return r;
}`;
const repoRoot = path.resolve(here, '../..');

export interface DropDeckStackProps extends StackProps {
  stage: string;
  budgetUsd: number;
  budgetEmail: string;
  webOrigins: string[];
  /** Late ticket numbers reserved per counter write; the fairness experiment varies it. */
  ticketBlockSize?: number;
  /**
   * Sender for email codes, e.g. "DropDeck <codes@dropdeck.example>", verified in SES. Unset means log mode: no
   * email is sent and the code is shown to the page, which only non-prod stages may use.
   */
  mailFrom?: string;
  /** Use Resend as the fallback sender; the key lives in SSM at /dropdeck/<stage>/resend-api-key. */
  resendFallback?: boolean;
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
    // Local dev servers (e.g. localhost:3000) may call the API and use the login callback only on dev stages.
    const devOrigins = stage.startsWith('dev') ? props.webOrigins : [];

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

    // /d/{tenant}/{drop}[/] and other extension-less paths map onto the static export.
    // The /d/ check comes first: with trailingSlash the canonical drop URL ends in '/'.
    const rewrite = new CfFunction(this, 'RewriteFn', {
      code: FunctionCode.fromInline(REWRITE_FN),
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
    // Managed login (hosted UI) with the authorization-code + PKCE flow: a static site needs no SRP code.
    const userPoolDomain = userPool.addDomain('LoginDomain', {
      cognitoDomain: { domainPrefix: `dropdeck-${stage}-${this.account}` },
    });
    const loginOrigins = [siteUrl, ...devOrigins];
    const userPoolClient = new UserPoolClient(this, 'ConsoleClient', {
      userPool,
      generateSecret: false,
      authFlows: { userSrp: true },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: loginOrigins.map((o) => `${o}/m/callback/`),
        logoutUrls: loginOrigins.map((o) => `${o}/m/`),
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
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
    ticketFn.addEnvironment('BLOCK_SIZE', String(props.ticketBlockSize ?? 10));
    const claimFn = fn('Claim', 'services/claim/src/handler.ts');
    const checkoutFn = fn('Checkout', 'services/checkout/src/handler.ts');
    const controllerFn = fn('Controller', 'services/controller/src/handler.ts', { timeout: 70 });

    for (const f of [merchantFn, ticketFn, claimFn, checkoutFn, controllerFn]) table.grantReadWriteData(f);
    bucket.grantPut(merchantFn);
    bucket.grantDelete(merchantFn);
    bucket.grantPut(controllerFn);

    // Signing keys: SecureStrings created by scripts/put-secrets.sh, read once per cold start (shared/secrets).
    const tokenKey = StringParameter.fromSecureStringParameterAttributes(this, 'TokenKey', { parameterName: `/dropdeck/${stage}/token-key` });
    const emailHashKey = StringParameter.fromSecureStringParameterAttributes(this, 'EmailHashKey', { parameterName: `/dropdeck/${stage}/email-hash-key` });
    for (const f of [ticketFn, claimFn, checkoutFn, controllerFn]) {
      tokenKey.grantRead(f);
      f.addEnvironment('TOKEN_KEY_PARAM', tokenKey.parameterName);
    }
    emailHashKey.grantRead(checkoutFn);
    checkoutFn.addEnvironment('EMAIL_HASH_KEY_PARAM', emailHashKey.parameterName);
    // Email codes (decision 0002).
    if (props.mailFrom) {
      const domain = props.mailFrom.replace(/^.*<|>$/g, '').split('@')[1];
      checkoutFn.addEnvironment('MAIL_MODE', 'ses');
      checkoutFn.addEnvironment('MAIL_FROM', props.mailFrom);
      checkoutFn.addToRolePolicy(new PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${domain}`, `arn:aws:ses:${this.region}:${this.account}:identity/*@${domain}`],
      }));
      if (props.resendFallback) {
        const resendKey = StringParameter.fromSecureStringParameterAttributes(this, 'ResendKey', { parameterName: `/dropdeck/${stage}/resend-api-key` });
        resendKey.grantRead(checkoutFn);
        checkoutFn.addEnvironment('RESEND_KEY_PARAM', resendKey.parameterName);
      }
    } else {
      if (stage === 'prod') throw new Error('prod needs mailFrom: log mode shows email codes to the page');
      checkoutFn.addEnvironment('MAIL_MODE', 'log');
    }

    const schedulerRole = new Role(this, 'SchedulerRole', { assumedBy: new ServicePrincipal('scheduler.amazonaws.com') });
    controllerFn.grantInvoke(schedulerRole);
    merchantFn.addEnvironment('CONTROLLER_ARN', controllerFn.functionArn);
    merchantFn.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    merchantFn.addEnvironment('SCHEDULE_GROUP', scheduleGroup.name!);
    controllerFn.addEnvironment('SCHEDULER_ROLE_ARN', schedulerRole.roleArn);
    controllerFn.addEnvironment('SCHEDULE_GROUP', scheduleGroup.name!);
    const scheduleArn = `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`;
    for (const f of [merchantFn, controllerFn]) {
      f.addToRolePolicy(new PolicyStatement({ actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'], resources: [scheduleArn] }));
      f.addToRolePolicy(new PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }));
    }

    // ---- API ----
    const api = new HttpApi(this, 'Api', {
      corsPreflight: {
        allowOrigins: [siteUrl, ...devOrigins],
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
      apiUrl: api.apiEndpoint, userPoolId: userPool.userPoolId, userPoolClientId: userPoolClient.userPoolClientId,
      authDomain: userPoolDomain.baseUrl(), stage, mailMode: props.mailFrom ? 'ses' : 'log',
    });
    new BucketDeployment(this, 'DeployWeb', {
      destinationBucket: bucket,
      sources: existsSync(webOut) ? [Source.asset(webOut), runtimeConfig] : [runtimeConfig],
      prune: false, // never delete d/* objects written by the services
      distribution,
      distributionPaths: ['/index.html', '/config.json', '/d/index.html', '/m/index.html', '/m/callback/index.html'],
    });

    // ---- Cost guard ----
    // No cost filter: it watches the whole account (dev stages included). Alerts at half and all of the limit,
    // i.e. US$5 and US$10 with the default budgetUsd of 10.
    if (props.budgetEmail) {
      new CfnBudget(this, 'Budget', {
        // The amount is in the name: changing it replaces the budget, and a fixed name would collide with the old one.
        budget: { budgetName: `dropdeck-${stage}-${props.budgetUsd}usd`, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: props.budgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [50, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
        })),
      });
    }

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AuthDomain', { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
