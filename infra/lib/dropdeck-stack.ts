import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import {
  AllowedMethods, CachePolicy, Distribution, Function as CfFunction, FunctionCode, FunctionEventType,
  HeadersFrameOption, HeadersReferrerPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy, CacheQueryStringBehavior,
  CacheHeaderBehavior, CacheCookieBehavior, SecurityPolicyProtocol } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  AccountRecovery, CfnManagedLoginBranding, CfnUserPoolGroup, FeaturePlan, ManagedLoginVersion, OAuthScope, UserPool,
  UserPoolClient, UserPoolClientIdentityProvider, UserPoolEmail,
} from 'aws-cdk-lib/aws-cognito';
import { AttributeType, Billing, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';
import { Operations } from './operations.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** CloudFront Function (viewer request). Exported for the unit test, which runs it in Node. */
export const REWRITE_FN = `function handler(event) {
  var r = event.request; var uri = r.uri;
  var last = uri.split('/').pop();
  if (last.indexOf('.') !== -1) return r;
  if (uri.indexOf('/d/') === 0) { r.uri = '/d/index.html'; return r; }
  if (uri.indexOf('/s/') === 0) { r.uri = '/s/index.html'; return r; }
  if (uri.endsWith('/')) { r.uri = uri + 'index.html'; return r; }
  r.uri = uri + '/index.html'; return r;
}`;
const repoRoot = path.resolve(here, '../..');

/**
 * Sign-in page branding (managed login). The style is designed in the Cognito branding editor, exported with
 * `aws cognito-idp describe-managed-login-branding-by-client` and committed here; until then Cognito's default style
 * is used. See infra/assets/README.md.
 */
function loginBranding(): Pick<CfnManagedLoginBranding, 'settings' | 'assets' | 'useCognitoProvidedValues'> {
  const dir = path.join(here, '../assets');
  const settingsFile = path.join(dir, 'managed-login.json');
  if (!existsSync(settingsFile)) return { useCognitoProvidedValues: true, settings: undefined, assets: undefined };
  const asset = (file: string, category: string, colorMode: string) => ({
    category, colorMode, extension: path.extname(file).slice(1).toUpperCase(), bytes: readFileSync(path.join(dir, file)).toString('base64'),
  });
  const assets = [
    ['login-logo-light.png', 'FORM_LOGO', 'LIGHT'], ['login-logo-dark.png', 'FORM_LOGO', 'DARK'], ['favicon.ico', 'FAVICON_ICO', 'DYNAMIC'],
  ].filter(([file]) => existsSync(path.join(dir, file!))).map(([file, category, mode]) => asset(file!, category!, mode!));
  return { useCognitoProvidedValues: false, settings: JSON.parse(readFileSync(settingsFile, 'utf8')), assets };
}

export interface DropDeckStackProps extends StackProps {
  /** Opt-in per stage after reviewing monitoring cost and notification configuration. */
  operationsEnabled?: boolean;
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
  /**
   * The site on our own domain (e.g. drops.example.com), with an ACM certificate for it that must be in us-east-1
   * (CloudFront's rule). Both or neither. docs/domain-setup.md has the steps.
   */
  domainName?: string;
  certificateArn?: string;
  /** Verify this domain in SES for sending; the DKIM CNAME records to add at the registrar are stack outputs. */
  sesDomain?: string;
  /**
   * Send Cognito's sign-up and password emails through SES from mailFrom instead of Cognito's built-in sender
   * (about 50 a day). Only once SES has production access, or sign-ups to unverified addresses fail.
   */
  signupEmailFromSes?: boolean;
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
    // Stages holding real merchants' data get backups and deletion protection; dev stages stay throwaway.
    const durable = stage === 'staging' || stage === 'prod';

    // ---- Data: one on-demand table, sparse GSI1 for hold expiry ----
    const table = new TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: durable },
      deletionProtection: durable,
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

    // Security headers for every page and JSON file (uploads under b/* keep the managed policy). The console keeps
    // tokens in sessionStorage, so it must not be frameable and should only talk to our API and Cognito. Next's
    // static export inlines its bootstrap script, hence 'unsafe-inline' for scripts; there is no user HTML anywhere.
    // Wildcards for the API and Cognito hosts avoid a cycle (the API's CORS already depends on the distribution).
    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            `connect-src 'self' https://*.execute-api.${this.region}.amazonaws.com https://*.auth.${this.region}.amazoncognito.com`,
            "frame-ancestors 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
        strictTransportSecurity: { override: true, accessControlMaxAge: Duration.days(365), includeSubdomains: true },
        frameOptions: { override: true, frameOption: HeadersFrameOption.DENY },
        contentTypeOptions: { override: true },
        referrerPolicy: { override: true, referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true }],
      },
    });

    if (Boolean(props.domainName) !== Boolean(props.certificateArn)) throw new Error('domainName and certificateArn go together');
    if (props.signupEmailFromSes && !props.mailFrom) throw new Error('signupEmailFromSes needs mailFrom (a verified SES sender)');
    const distribution = new Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      ...(props.domainName && props.certificateArn
        ? {
          domainNames: [props.domainName],
          certificate: Certificate.fromCertificateArn(this, 'SiteCert', props.certificateArn),
          minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
        }
        : {}),
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [{ function: rewrite, eventType: FunctionEventType.VIEWER_REQUEST }],
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        'd/*/state.json': { origin, cachePolicy: statePolicy, responseHeadersPolicy: securityHeaders, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_GET_HEAD },
        'd/*/drop.json': { origin, cachePolicy: dropJsonPolicy, responseHeadersPolicy: securityHeaders, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_GET_HEAD },
        's/*/shop.json': { origin, cachePolicy: dropJsonPolicy, responseHeadersPolicy: securityHeaders, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS, allowedMethods: AllowedMethods.ALLOW_GET_HEAD },
        // Merchant uploads: immutable, content-addressed keys. No rewrite function, and nosniff so a browser only
        // ever treats them as the image type S3 stored.
        'b/*': {
          origin, cachePolicy: CachePolicy.CACHING_OPTIMIZED, viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD, responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });
    // The public address: our domain when there is one; the cloudfront.net name keeps working either way.
    const cloudfrontUrl = `https://${distribution.distributionDomainName}`;
    const siteUrl = props.domainName ? `https://${props.domainName}` : cloudfrontUrl;
    const siteOrigins = props.domainName ? [siteUrl, cloudfrontUrl] : [siteUrl];

    // ---- Merchant identity ----
    const userPool = new UserPool(this, 'Merchants', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // Essentials is what managed login (the branded sign-in page) needs; it bills per monthly active user, with a
      // free tier, never by the hour. Plus is never used (a test guards it).
      featurePlan: FeaturePlan.ESSENTIALS,
      ...(props.signupEmailFromSes && props.mailFrom
        ? {
          email: UserPoolEmail.withSES({
            fromEmail: props.mailFrom.replace(/^.*<|>$/g, ''),
            fromName: 'DropDeck',
            sesRegion: this.region,
            sesVerifiedDomain: props.mailFrom.replace(/^.*<|>$/g, '').split('@')[1],
          }),
        }
        : {}),
      removalPolicy: ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });
    // Managed login (hosted UI) with the authorization-code + PKCE flow: a static site needs no SRP code.
    const userPoolDomain = userPool.addDomain('LoginDomain', {
      cognitoDomain: { domainPrefix: `dropdeck-${stage}-${this.account}` },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const loginOrigins = [...siteOrigins, ...devOrigins];
    const userPoolClient = new UserPoolClient(this, 'ConsoleClient', {
      userPool,
      generateSecret: false,
      // Sign-in errors never reveal whether an email has an account.
      preventUserExistenceErrors: true,
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
    // With the newer managed login, an app client without a style gets an error page, so the style ships with it.
    // DropDeck's own staff: members can use the /ops/ page and the /admin/* API. Membership is added by hand
    // (docs/handover.md, "Make someone an operator").
    new CfnUserPoolGroup(this, 'Operators', { userPoolId: userPool.userPoolId, groupName: 'operators', description: 'DropDeck operators (ops page and admin API)' });

    new CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      ...loginBranding(),
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
        projectRoot: repoRoot,
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: extra.memory ?? 512,
        timeout: Duration.seconds(extra.timeout ?? 10),
        logGroup,
        environment: { TABLE_NAME: table.tableName, BUCKET_NAME: bucket.bucketName, STAGE: stage },
        bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22' },
      });
    };

    // 15 s: a profile save republishes every published drop page of the shop.
    const merchantFn = fn('MerchantApi', 'services/merchant-api/src/handler.ts', { timeout: 15 });
    const ticketFn = fn('Ticket', 'services/ticket/src/handler.ts', { memory: 256 });
    ticketFn.addEnvironment('BLOCK_SIZE', String(props.ticketBlockSize ?? 10));
    const claimFn = fn('Claim', 'services/claim/src/handler.ts');
    const checkoutFn = fn('Checkout', 'services/checkout/src/handler.ts');
    const controllerFn = fn('Controller', 'services/controller/src/handler.ts', { timeout: 70 });
    const adminFn = fn('AdminApi', 'services/admin-api/src/handler.ts', { timeout: 15 });
    adminFn.addEnvironment('USER_POOL_ID', userPool.userPoolId);
    userPool.grant(adminFn, 'cognito-idp:ListUsers');

    for (const f of [merchantFn, ticketFn, claimFn, checkoutFn, controllerFn]) table.grantReadWriteData(f);
    table.grantReadWriteData(adminFn);
    // Services write only their own prefixes, never the web app's files (index.html, _next/, config.json).
    const objects = (...prefixes: string[]) => prefixes.map((p) => bucket.arnForObjects(`${p}/*`));
    merchantFn.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject'], resources: objects('d', 's', 'b', 'p') }));
    controllerFn.addToRolePolicy(new PolicyStatement({ actions: ['s3:PutObject'], resources: objects('d', 's', 'p') }));

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
        allowOrigins: [...siteOrigins, ...devOrigins],
        allowMethods: [CorsHttpMethod.ANY],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
        maxAge: Duration.hours(1),
      },
    });
    // Stage-wide throttling; re-tuned from the 10x load test result.
    const cfnStage = api.defaultStage!.node.defaultChild as CfnStage;
    cfnStage.defaultRouteSettings = { throttlingBurstLimit: 2000, throttlingRateLimit: 1000 };
    // Joining a queue gets its own share, so a flood of tickets on one drop cannot starve claims and checkout for
    // every shop; uploads are slow, human actions.
    cfnStage.routeSettings = {
      // Raw CloudFormation (the L1 property is untyped), so the keys are PascalCase.
      'POST /api/d/{tenantId}/{dropId}/ticket': { ThrottlingBurstLimit: 1200, ThrottlingRateLimit: 600 },
      'POST /m/uploads': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    };

    const authorizer = new HttpUserPoolAuthorizer('MerchantAuth', userPool, { userPoolClients: [userPoolClient] });
    const merchantIntegration = new HttpLambdaIntegration('MerchantInt', merchantFn);
    const merchantRoutes: Array<[HttpMethod, string]> = [
      [HttpMethod.GET, '/m/overview'],
      [HttpMethod.GET, '/m/profile'], [HttpMethod.PUT, '/m/profile'],
      [HttpMethod.GET, '/m/slugs/{slug}'], [HttpMethod.POST, '/m/uploads'], [HttpMethod.GET, '/m/usage'],
      [HttpMethod.GET, '/m/drops'], [HttpMethod.POST, '/m/drops'],
      [HttpMethod.GET, '/m/drops/{dropId}'], [HttpMethod.PATCH, '/m/drops/{dropId}'], [HttpMethod.DELETE, '/m/drops/{dropId}'],
      [HttpMethod.POST, '/m/drops/{dropId}/schedule'], [HttpMethod.POST, '/m/drops/{dropId}/unschedule'],
      [HttpMethod.POST, '/m/drops/{dropId}/cancel'], [HttpMethod.POST, '/m/drops/{dropId}/duplicate'],
      [HttpMethod.GET, '/m/drops/{dropId}/live'], [HttpMethod.GET, '/m/drops/{dropId}/orders'],
      [HttpMethod.PATCH, '/m/orders/{ref}'], [HttpMethod.GET, '/m/drops/{dropId}/export.csv'],
      [HttpMethod.GET, '/m/drops/{dropId}/report'],
    ];
    for (const [method, p] of merchantRoutes) {
      const routes = api.addRoutes({ path: p, methods: [method], integration: merchantIntegration, authorizer });
      if (p === '/m/uploads') for (const r of routes) cfnStage.node.addDependency(r);
    }
    // Operator routes: same authorizer; the handler requires the operators group.
    const adminIntegration = new HttpLambdaIntegration('AdminInt', adminFn);
    api.addRoutes({ path: '/admin/tenants', methods: [HttpMethod.GET], integration: adminIntegration, authorizer });
    api.addRoutes({ path: '/admin/tenants/{tenantId}', methods: [HttpMethod.PATCH], integration: adminIntegration, authorizer });
    for(const path of ['/admin/analytics','/admin/health','/admin/health/{tenantId}/{dropId}']) api.addRoutes({path,methods:[HttpMethod.GET],integration:adminIntegration,authorizer});
    if(props.operationsEnabled) new Operations(this,'Operations',{stage,repoRoot,table,bucket,apiId:api.apiId,apiStage:cfnStage,
      producers:[ticketFn,claimFn,checkoutFn,controllerFn,merchantFn],admin:adminFn,checkout:checkoutFn,mailFrom:props.mailFrom});
    const ticketRoutes = api.addRoutes({ path: '/api/d/{tenantId}/{dropId}/ticket', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('TicketInt', ticketFn) });
    // The stage's per-route throttles name these routes, so they must exist before the stage is updated.
    for (const r of ticketRoutes) cfnStage.node.addDependency(r);
    api.addRoutes({ path: '/api/d/{tenantId}/{dropId}/claim', methods: [HttpMethod.POST], integration: new HttpLambdaIntegration('ClaimInt', claimFn) });
    const checkoutInt = new HttpLambdaIntegration('CheckoutInt', checkoutFn);
    api.addRoutes({ path: '/api/holds/{holdId}', methods: [HttpMethod.GET], integration: checkoutInt });
    api.addRoutes({ path: '/api/holds/{holdId}/otp', methods: [HttpMethod.POST], integration: checkoutInt });
    api.addRoutes({ path: '/api/holds/{holdId}/confirm', methods: [HttpMethod.POST], integration: checkoutInt });

    // ---- Web app (static export) + runtime config ----
    const webOut = path.join(repoRoot, 'apps/web/out');
    const runtimeConfig = Source.jsonData('config.json', {
      apiUrl: api.apiEndpoint, userPoolId: userPool.userPoolId, userPoolClientId: userPoolClient.userPoolClientId,
      authDomain: userPoolDomain.baseUrl(), stage, mailMode: props.mailFrom ? 'ses' : 'log', siteUrl,
    });
    new BucketDeployment(this, 'DeployWeb', {
      destinationBucket: bucket,
      sources: existsSync(webOut) ? [Source.asset(webOut), runtimeConfig] : [runtimeConfig],
      prune: false, // never delete d/, s/ or b/ objects written by the services
      distribution,
      distributionPaths: [
        '/index.html', '/config.json', '/d/index.html', '/s/index.html', '/m/index.html', '/m/callback/index.html',
        '/ops/index.html', '/privacy/index.html',
      ],
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
    new CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName, description: 'CNAME target for your domain at the registrar' });
    if (props.sesDomain) {
      // SES domain identity with Easy DKIM: add these three CNAMEs at the registrar, then SES marks it verified.
      const identity = new EmailIdentity(this, 'MailDomain', { identity: Identity.domain(props.sesDomain) });
      identity.dkimRecords.forEach((r, i) => new CfnOutput(this, `DkimRecord${i + 1}`, { value: `${r.name} CNAME ${r.value}` }));
    }
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'AuthDomain', { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
