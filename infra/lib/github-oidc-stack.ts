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
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
