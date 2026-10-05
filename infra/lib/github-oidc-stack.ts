import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import { Effect, OpenIdConnectProvider, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface GithubOidcProps extends StackProps {
  /** owner/name, e.g. team8/dropdeck */
  githubRepo: string;
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
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:environment:staging`,
        },
      }),
    });
    role.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));
    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
