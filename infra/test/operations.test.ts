import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack } from '../lib/dropdeck-stack.js';

const synth=(enabled:boolean)=>Template.fromStack(new DropDeckStack(new App(),enabled?'Monitored':'Minimal',{
  env:{account:'123456789012',region:'ap-southeast-1'},stage:'test',budgetUsd:10,budgetEmail:'',webOrigins:[],
  operationsEnabled:enabled,mailFrom:'DropDeck <codes@example.com>',
}));
describe('read-only operations infrastructure',()=>{
  const template=synth(true);
  it('is opt-in and adds no monitoring resources to an unconfigured stage',()=>{
    const minimal=synth(false);minimal.resourceCountIs('AWS::CloudWatch::Dashboard',0);minimal.resourceCountIs('AWS::Logs::SubscriptionFilter',0);
  });
  it('collects logs, edge 429s and scheduled health independently of the buyer path',()=>{
    template.resourceCountIs('AWS::Logs::SubscriptionFilter',6);
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage',{AccessLogSettings:{DestinationArn:Match.anyValue(),Format:Match.stringLikeRegexp('requestId.*status.*path')}});
    template.hasResourceProperties('AWS::Events::Rule',{ScheduleExpression:'rate(1 minute)'});
    template.hasResourceProperties('AWS::Logs::MetricFilter',{MetricTransformations:Match.arrayWith([Match.objectLike({MetricName:'ApiGateway429'})])});
  });
  it('uses encrypted queues, partial-batch failures and a DLQ for SES events',()=>{
    template.resourceCountIs('AWS::SQS::Queue',2);
    template.hasResourceProperties('AWS::SQS::Queue',{SqsManagedSseEnabled:true,RedrivePolicy:Match.objectLike({maxReceiveCount:3})});
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping',{FunctionResponseTypes:['ReportBatchItemFailures']});
    template.resourceCountIs('AWS::SES::ConfigurationSet',1);template.resourceCountIs('AWS::SES::ConfigurationSetEventDestination',1);
  });
  it('has a dashboard, alarms for missing collectors, and no notification recipient hardcoded',()=>{
    template.resourceCountIs('AWS::CloudWatch::Dashboard',1);
    template.hasResourceProperties('AWS::CloudWatch::Alarm',{MetricName:'ApproximateAgeOfOldestMessage',Threshold:120});
    expect(JSON.stringify(template.findResources('AWS::CloudWatch::Alarm'))).toMatch(/ThrottledRequests/);
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).toMatch(/configuration-set/);
    template.hasResourceProperties('AWS::CloudWatch::Alarm',{TreatMissingData:'breaching',ComparisonOperator:'LessThanThreshold',MetricName:'CollectionRuns'});
    template.hasResourceProperties('AWS::CloudWatch::Alarm',{MetricName:'UnresolvedIncidentPresent',Statistic:'Maximum',EvaluationPeriods:3,DatapointsToAlarm:3});
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable',{GlobalSecondaryIndexes:Match.arrayWith([Match.objectLike({IndexName:'GSI1',Projection:{ProjectionType:'KEYS_ONLY'}})])});
    const subscriptions=Object.values(template.findResources('AWS::SNS::Subscription')) as Array<{Properties:{Protocol:string}}>;
    expect(subscriptions.every(s=>s.Properties.Protocol==='sqs')).toBe(true);
  });
  it('does not grant the collector stock-write or SES sending permissions',()=>{
    const policies=Object.entries(template.findResources('AWS::IAM::Policy')).filter(([id])=>id.includes('CollectorServiceRoleDefaultPolicy'));
    expect(policies).toHaveLength(1);
    const policy=policies[0]![1] as {Properties:{PolicyDocument:{Statement:Array<{Action:string|string[];Resource:unknown}>}}};
    for(const statement of policy.Properties.PolicyDocument.Statement) {
      const actions=Array.isArray(statement.Action)?statement.Action:[statement.Action];
      expect(actions).not.toContain('ses:SendEmail');
      if(actions.some(a=>['dynamodb:UpdateItem','dynamodb:PutItem','dynamodb:DeleteItem','dynamodb:BatchWriteItem'].includes(a))) expect(JSON.stringify(statement.Resource)).toContain('OperationsSnapshots');
    }
  });
});
