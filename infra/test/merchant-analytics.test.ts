import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DropDeckStack } from '../lib/dropdeck-stack.js';

describe('merchant analytics deployment',()=>{
  const template=Template.fromStack(new DropDeckStack(new App(),'MerchantAnalytics',{env:{account:'123456789012',region:'ap-southeast-1'},stage:'test',budgetUsd:10,budgetEmail:'',webOrigins:[],merchantAnalyticsEnabled:true,growthAnalyticsPreviewEnabled:true}));
  it('enables core analytics and Growth preview without provisioning a paid BI service',()=>{
    template.hasResourceProperties('AWS::Lambda::Function',{Environment:{Variables:Match.objectLike({MERCHANT_ANALYTICS_ENABLED:'1',GROWTH_ANALYTICS_PREVIEW_ENABLED:'1'})}});
    const resources=template.toJSON().Resources as Record<string,{Type:string}>;
    expect(Object.values(resources).some(r=>r.Type.startsWith('AWS::QuickSight::'))).toBe(false);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/quicksight:|bedrock:/i);
    template.resourceCountIs('AWS::DynamoDB::GlobalTable',1);
    template.resourceCountIs('AWS::SQS::Queue',0);
  });
  it('protects every analytics and tracking route with Cognito',()=>{
    for(const key of ['GET /m/analytics','GET /m/analytics/export.csv','GET /m/order-worklist','GET /m/drops/{dropId}/inventory','PATCH /m/orders/{ref}/tracking','GET /m/orders/{ref}/history'])template.hasResourceProperties('AWS::ApiGatewayV2::Route',{RouteKey:key,AuthorizationType:'JWT'});
  });
});
