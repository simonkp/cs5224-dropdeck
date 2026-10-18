import path from 'node:path';
import { Duration, RemovalPolicy, CfnOutput, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, Billing, TableV2, Operation, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LogGroup, RetentionDays, SubscriptionFilter, FilterPattern, MetricFilter } from 'aws-cdk-lib/aws-logs';
import { LambdaDestination } from 'aws-cdk-lib/aws-logs-destinations';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { SqsSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { ConfigurationSet, EventDestination, EmailSendingEvent } from 'aws-cdk-lib/aws-ses';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Alarm, ComparisonOperator, Dashboard, GraphWidget, MathExpression, Metric, TreatMissingData, type IMetric } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';

export class Operations extends Construct {
  constructor(scope:Construct,id:string,props:{stage:string;repoRoot:string;table:TableV2;bucket:Bucket;apiId:string;apiStage:CfnStage;producers:NodejsFunction[];admin:NodejsFunction;checkout:NodejsFunction;mailFrom?:string}) {
    super(scope,id);
    const {stage}=props;
    const snapshots=new TableV2(this,'Snapshots',{partitionKey:{name:'PK',type:AttributeType.STRING},sortKey:{name:'SK',type:AttributeType.STRING},billing:Billing.onDemand(),timeToLiveAttribute:'ttl',removalPolicy:RemovalPolicy.RETAIN,
      globalSecondaryIndexes:[{indexName:'GSI1',partitionKey:{name:'GSI1PK',type:AttributeType.STRING},sortKey:{name:'GSI1SK',type:AttributeType.STRING},projectionType:ProjectionType.KEYS_ONLY}]});
    const logs=new LogGroup(this,'CollectorLogs',{retention:RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.DESTROY});
    const collector=new NodejsFunction(this,'Collector',{entry:path.join(props.repoRoot,'services/operations/src/handler.ts'),projectRoot:props.repoRoot,runtime:Runtime.NODEJS_22_X,architecture:Architecture.ARM_64,memorySize:512,timeout:Duration.seconds(60),logGroup:logs,
      environment:{TABLE_NAME:props.table.tableName,OPS_TABLE_NAME:snapshots.tableName,BUCKET_NAME:props.bucket.bucketName,STAGE:stage,OPS_ENABLED:'1'},
      bundling:{format:OutputFormat.ESM,minify:true,sourceMap:true,target:'node22'}});
    props.table.grantReadData(collector); snapshots.grantReadWriteData(collector);
    collector.addToRolePolicy(new PolicyStatement({actions:['s3:GetObject'],resources:[props.bucket.arnForObjects('d/*/state.json')]}));
    snapshots.grantReadData(props.admin);
    props.admin.addEnvironment('OPS_TABLE_NAME',snapshots.tableName);props.admin.addEnvironment('OPS_MAIL_MODE',props.mailFrom?'ses':'log');
    for(const [i,fn] of props.producers.entries()) {
      fn.addEnvironment('OPS_ENABLED','1');
      new SubscriptionFilter(this,`ApplicationEvents${i}`,{logGroup:fn.logGroup,destination:new LambdaDestination(collector),filterPattern:FilterPattern.allEvents()});
    }
    new Rule(this,'CollectEveryMinute',{schedule:Schedule.rate(Duration.minutes(1)),targets:[new LambdaFunction(collector,{retryAttempts:1,maxEventAge:Duration.minutes(2)})]});
    const access=new LogGroup(this,'ApiAccessLogs',{retention:RetentionDays.ONE_MONTH,removalPolicy:RemovalPolicy.DESTROY});
    props.apiStage.accessLogSettings={destinationArn:access.logGroupArn,format:JSON.stringify({stage,requestId:'$context.requestId',status:'$context.status',path:'$context.path',at:'$context.requestTimeEpoch',latencyMs:'$context.responseLatency',route:'$context.routeKey'})};
    new SubscriptionFilter(this,'EdgeEvents',{logGroup:access,destination:new LambdaDestination(collector),filterPattern:FilterPattern.literal('{ $.status = "429" }')});
    new MetricFilter(this,'Edge429',{logGroup:access,filterPattern:FilterPattern.literal('{ $.status = "429" }'),metricNamespace:'DropDeck/Operations',metricName:'ApiGateway429',metricValue:'1',dimensions:{Stage:'$.stage'}});
    const notifications=new Topic(this,'AlarmNotifications',{displayName:`DropDeck ${stage} operations alarms`});
    const dashboard=new Dashboard(this,'Dashboard',{dashboardName:`dropdeck-${stage}-operations`});
    const addAlarm=(id:string,metric:IMetric,threshold:number,evaluationPeriods=2,missing=TreatMissingData.NOT_BREACHING)=>{
      const alarm=new Alarm(this,id,{metric,threshold,evaluationPeriods,datapointsToAlarm:evaluationPeriods,comparisonOperator:ComparisonOperator.GREATER_THAN_THRESHOLD,treatMissingData:missing});alarm.addAlarmAction(new SnsAction(notifications));return alarm;
    };
    for(const fn of [...props.producers,collector]) {
      addAlarm(`${fn.node.id}Errors`,fn.metricErrors({period:Duration.minutes(5)}),0);
      addAlarm(`${fn.node.id}Throttles`,fn.metricThrottles({period:Duration.minutes(5)}),0);
    }
    const dbOperations=[Operation.GET_ITEM,Operation.BATCH_GET_ITEM,Operation.QUERY,Operation.SCAN,Operation.PUT_ITEM,Operation.UPDATE_ITEM,Operation.DELETE_ITEM,Operation.BATCH_WRITE_ITEM,Operation.TRANSACT_WRITE_ITEMS];
    for(const [name,db] of [['Application',props.table],['Operations',snapshots]] as const) {
      const throttles=db.metricThrottledRequestsForOperations({period:Duration.minutes(5),statistic:'Sum',operations:dbOperations});
      const errors=db.metricSystemErrorsForOperations({period:Duration.minutes(5),statistic:'Sum',operations:dbOperations});
      addAlarm(`${name}DatabaseThrottles`,throttles,0);addAlarm(`${name}DatabaseErrors`,errors,0);
      dashboard.addWidgets(new GraphWidget({title:`${name} DynamoDB: throttles`,left:[throttles],width:12}),new GraphWidget({title:`${name} DynamoDB: system errors`,left:[errors],width:12}));
    }
    for(const service of ['ticket','claim','checkout','otp']) {
      const metric=(name:string,statistic='Sum')=>new Metric({namespace:'DropDeck/Operations',metricName:name,dimensionsMap:{Stage:stage,Service:service},statistic,period:Duration.minutes(5)});
      addAlarm(`${service}FailureRate`,new MathExpression({expression:'IF((requests>=50) AND (errors>=10),100*errors/requests,0)',usingMetrics:{requests:metric('Requests'),errors:metric('Failures')},period:Duration.minutes(5)}),1);
      addAlarm(`${service}Latency`,new MathExpression({expression:'IF(requests>=50,p95,0)',usingMetrics:{requests:metric('Requests'),p95:metric('LatencyMs','p95')},period:Duration.minutes(5)}),1500);
      dashboard.addWidgets(new GraphWidget({title:`${service}: requests / server failures`,left:[metric('Requests'),metric('Failures')],width:12}),new GraphWidget({title:`${service}: latency p50 / p95 (ms)`,left:[metric('LatencyMs','p50'),metric('LatencyMs','p95')],width:12}));
    }
    const stageMetric=(name:string)=>new Metric({namespace:'DropDeck/Operations',metricName:name,dimensionsMap:{Stage:stage},statistic:'Sum',period:Duration.minutes(1)});
    const apiCount=new Metric({namespace:'AWS/ApiGateway',metricName:'Count',dimensionsMap:{ApiId:props.apiId},statistic:'Sum',period:Duration.minutes(5)});
    addAlarm('EdgeThrottleRate',new MathExpression({expression:'IF((requests>=50) AND (throttles>=20),100*throttles/requests,0)',usingMetrics:{requests:apiCount,throttles:stageMetric('ApiGateway429').with({period:Duration.minutes(5)})},period:Duration.minutes(5)}),5);
    addAlarm('CollectionFailures',stageMetric('CollectionErrors'),0);
    for(const name of ['PublicationFailures','OtpSendFailures','OtpDeliveryDelays','OtpBounces','OtpComplaints','OtpRejected']) addAlarm(name,stageMetric(name),0,1);
    const unresolvedPresence=stageMetric('UnresolvedIncidentPresent').with({statistic:'Maximum'});
    addAlarm('AffectedDrops',unresolvedPresence,0,3);
    // A silent scheduled collector must not appear healthy merely because it emits no errors.
    new Alarm(this,'CollectionMissing',{metric:stageMetric('CollectionRuns'),threshold:1,evaluationPeriods:3,comparisonOperator:ComparisonOperator.LESS_THAN_THRESHOLD,treatMissingData:TreatMissingData.BREACHING}).addAlarmAction(new SnsAction(notifications));
    dashboard.addWidgets(new GraphWidget({title:'API edge throttles (not OTP lockouts)',left:[stageMetric('ApiGateway429')],width:12}),new GraphWidget({title:'Affected drops in collector sample / collection failures',left:[stageMetric('AffectedDrops'),stageMetric('CollectionErrors')],width:12}));
    dashboard.addWidgets(new GraphWidget({title:'Unresolved detected incident present (0 or 1)',left:[unresolvedPresence],width:12}));
    dashboard.addWidgets(new GraphWidget({title:'OTP provider outcomes (not inbox confirmation)',left:[stageMetric('OtpAccepted'),stageMetric('OtpDelivered'),stageMetric('OtpSendFailures'),stageMetric('OtpDeliveryDelays')],width:12}),new GraphWidget({title:'Publication failures',left:[stageMetric('PublicationFailures')],width:12}));
    const dlq=new Queue(this,'DeliveryDLQ',{encryption:QueueEncryption.SQS_MANAGED,retentionPeriod:Duration.days(14)});
    const deliveryQueue=new Queue(this,'DeliveryEvents',{encryption:QueueEncryption.SQS_MANAGED,retentionPeriod:Duration.days(4),visibilityTimeout:Duration.minutes(6),deadLetterQueue:{queue:dlq,maxReceiveCount:3}});
    collector.addEventSource(new SqsEventSource(deliveryQueue,{batchSize:10,reportBatchItemFailures:true}));
    addAlarm('DeliveryBacklog',deliveryQueue.metricApproximateAgeOfOldestMessage({period:Duration.minutes(1),statistic:'Maximum'}),120,2);
    addAlarm('DeliveryDLQNotEmpty',dlq.metricApproximateNumberOfMessagesVisible({period:Duration.minutes(1),statistic:'Maximum'}),0,1);
    if(props.mailFrom) {
      const configuration=new ConfigurationSet(this,'CheckoutEmailEvents');
      const topic=new Topic(this,'DeliveryTopic');
      topic.addToResourcePolicy(new PolicyStatement({principals:[new ServicePrincipal('ses.amazonaws.com')],actions:['sns:Publish'],resources:[topic.topicArn],conditions:{StringEquals:{'AWS:SourceAccount':Stack.of(this).account},ArnEquals:{'AWS:SourceArn':Stack.of(this).formatArn({service:'ses',resource:'configuration-set',resourceName:configuration.configurationSetName})}}}));
      configuration.addEventDestination('Delivery',{destination:EventDestination.snsTopic(topic),events:[EmailSendingEvent.DELIVERY,EmailSendingEvent.DELIVERY_DELAY,EmailSendingEvent.BOUNCE,EmailSendingEvent.COMPLAINT,EmailSendingEvent.REJECT]});
      topic.addSubscription(new SqsSubscription(deliveryQueue,{rawMessageDelivery:true}));
      props.checkout.addEnvironment('SES_CONFIG_SET',configuration.configurationSetName);
      props.checkout.addToRolePolicy(new PolicyStatement({actions:['ses:SendEmail'],resources:[Stack.of(this).formatArn({service:'ses',resource:'configuration-set',resourceName:configuration.configurationSetName})]}));
    }
    const dashboardUrl=`https://${Stack.of(this).region}.console.aws.amazon.com/cloudwatch/home?region=${Stack.of(this).region}#dashboards/dashboard/${dashboard.dashboardName}`;
    props.admin.addEnvironment('OPS_DASHBOARD_URL',dashboardUrl);
    new CfnOutput(this,'DashboardUrl',{value:dashboardUrl});new CfnOutput(this,'AlarmTopicArn',{value:notifications.topicArn});
  }
}
