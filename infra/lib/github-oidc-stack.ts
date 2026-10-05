import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Effect, OpenIdConnectProvider, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcProps extends StackProps {
  /** owner/name, e.g. team8/dropdeck */
  githubRepo: string;
  /**
   * The repo's OIDC subject prefix when it uses GitHub's immutable subjects (owner and repo IDs embedded, e.g.
   * `repo:simonkp@5468350/cs5224-dropdeck@1405294986`). Read it with
   * `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` (field sub_claim_prefix).
   */
  githubSubPrefix?: string;
}

/** Keyless deploys: GitHub's OIDC token is exchanged for a role that may only assume the CDK bootstrap roles. */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcProps) {
    super(scope, id, props);
    const provider = new OpenIdConnectProvider(this, 'GithubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    const role = new Role(this, 'DeployRole', {
      roleName: 'dropdeck-github-deploy',
      assumedBy: new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        // The deploy job declares `environment: staging`, which makes GitHub put the environment (not the ref) in `sub`.
        // A list under StringEquals is an OR: the name-based subject and, if given, the immutable (ID-based) one.
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': [`repo:${props.githubRepo}`, ...(props.githubSubPrefix ? [props.githubSubPrefix] : [])]
            .map((prefix) => `${prefix}:environment:staging`),
        },
      }),
    });
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      // The CDK CLI tags the sessions it opens on the bootstrap roles, which needs sts:TagSession as well.
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    // Fallback for accounts whose SCPs forbid assuming the bootstrap roles (the NUS Innovation Sandbox does).
    // The CLI then deploys with this role's own credentials but still hands CloudFormation the bootstrap
    // execution role, so all that is needed here is what the CLI itself does: no IAM or service admin.
    const q = 'hnb659fds';
    role.addToPolicy(new PolicyStatement({
      actions: ['cloudformation:*'],
      resources: [
        `arn:aws:cloudformation:${this.region}:${this.account}:stack/DropDeck-*/*`,
        `arn:aws:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`,
      ],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['cloudformation:DescribeStacks', 'cloudformation:ValidateTemplate', 'cloudformation:GetTemplateSummary'],
      resources: ['*'],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation', 's3:GetEncryptionConfiguration'],
      resources: [`arn:aws:s3:::cdk-${q}-assets-${this.account}-${this.region}`, `arn:aws:s3:::cdk-${q}-assets-${this.account}-${this.region}/*`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${q}/*`],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-${q}-cfn-exec-role-${this.account}-${this.region}`],
      conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
    }));
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
