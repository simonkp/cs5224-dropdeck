import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, strip, table } from '@dropdeck/shared/ddb';
import { ApiError, keys, type Drop, type MerchantProfile, type Order } from '@dropdeck/shared';
import { analyticsCapabilities } from '@dropdeck/shared/plans';
import { summarizeSales, singaporeDay, trackingOf } from '@dropdeck/shared/merchant-analytics';
import { listDrops } from './repo.js';

export const analyticsEnabled = () => process.env.MERCHANT_ANALYTICS_ENABLED === '1';
export async function merchantCapabilities(t: string) {
  const r = await ddb.send(new GetCommand({ TableName: table(), Key: keys.profile(t), ConsistentRead:true }));
  const tier = r.Item?.tier as MerchantProfile['tier'] | undefined;
  return { tier: tier === 'growth' || tier === 'event' ? tier : 'starter', ...analyticsCapabilities(tier, process.env.GROWTH_ANALYTICS_PREVIEW_ENABLED === '1'), enabled: analyticsEnabled(), quickSightConnected: false as const };
}
function isoDay(value: string | undefined, fallback: string) {
  const day=value??fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10)!==day) throw new ApiError('VALIDATION','Use valid YYYY-MM-DD dates');
  return day;
}
export async function analyticsReport(t: string, q: Record<string,string|undefined>) {
  const capabilities=await merchantCapabilities(t);
  if (!capabilities.enabled) return { enabled:false, capabilities };
  const advanced=q.advanced==='1';
  if (advanced&&!capabilities.advancedPreview) throw new ApiError('PLAN_LIMIT','Advanced analytics preview is available only on Growth');
  const to=isoDay(q.to,singaporeDay(Date.now())); const from=isoDay(q.from,new Date(Date.parse(to)-6*86400000).toISOString().slice(0,10));
  const max=advanced?90:31; const span=(Date.parse(to)-Date.parse(from))/86400000+1;
  if(span<1||span>max||to>singaporeDay(Date.now()))throw new ApiError('VALIDATION',`Choose a range of 1–${max} days ending no later than today`);
  try{await ddb.send(new UpdateCommand({TableName:table(),Key:{PK:`T#${t}`,SK:`ANALYTICS_READ#${new Date().toISOString().slice(0,16)}`},UpdateExpression:'ADD n :one SET #ttl=:ttl',ConditionExpression:'attribute_not_exists(n) OR n<:max',ExpressionAttributeNames:{'#ttl':'ttl'},ExpressionAttributeValues:{':one':1,':max':30,':ttl':Math.floor(Date.now()/1000)+3600}}));}
  catch(e){if((e as {name?:string}).name==='ConditionalCheckFailedException')throw new ApiError('RATE_LIMITED','Up to 30 analytics refreshes per minute',60);throw e;}
  const all=await listDrops(t);
  const wanted=q.dropId?all.filter(d=>d.dropId===q.dropId):all.filter(d=>d.state!=='Draft').sort((a,b)=>b.openAt.localeCompare(a.openAt));
  if(q.dropId&&!wanted.length)throw new ApiError('NOT_FOUND','Drop not found');
  const drops=wanted.slice(0,20);
  let partial=wanted.length>drops.length; const orders:Order[]=[]; const pages:Array<{dropId:string;partial:boolean}>=[];
  // One bounded page per drop, four at a time. Coverage is explicit even when the selected date is absent.
  for(let i=0;i<drops.length;i+=4){
    const batch=await Promise.all(drops.slice(i,i+4).map(async drop=>{
      const prefix=keys.orderPrefix(t,drop.dropId);
      const r=await ddb.send(new QueryCommand({TableName:table(),KeyConditionExpression:'PK=:p AND begins_with(SK,:s)',ExpressionAttributeValues:{':p':prefix.PK,':s':prefix.SKPrefix},Limit:500,ConsistentRead:true}));
      const valid=(r.Items??[]).filter(o=>Number(o.ttl??(Date.parse(drop.endAt)/1000+180*86400))*1000>Date.now()).map(o=>strip<Order>(o)!);
      return {drop,orders:valid,partial:Boolean(r.LastEvaluatedKey)};
    }));
    for(const page of batch){orders.push(...page.orders);partial ||=page.partial;pages.push({dropId:page.drop.dropId,partial:page.partial});}
  }
  const filtered=q.variantId?orders.filter(o=>o.variantId===q.variantId):orders;
  const filteredDrops:Drop[]=q.variantId?drops.map(d=>({...d,variants:d.variants.filter(v=>v.id===q.variantId)})):drops;
  const report=summarizeSales(filtered,filteredDrops,from,to,advanced);
  const retentionLimited=Date.parse(from)-(advanced?span*86400000:0)<Date.now()-180*86400000||drops.some(d=>Date.parse(d.endAt)+180*86400000<=Date.now());
  return {enabled:true,capabilities,from,to,advanced,preview:advanced,generatedAt:new Date().toISOString(),scope:{drops:drops.length,availableDrops:wanted.length,maxOrdersPerDrop:500,partial,pages,retainedOnly:true,retentionLimited},...report};
}
export async function orderWorklist(t:string,q:Record<string,string|undefined>){
  const caps=await merchantCapabilities(t);if(!caps.enabled)return {enabled:false,rows:[]};
  if(!q.dropId)throw new ApiError('VALIDATION','Select a drop for order tracking');
  const r=await ddb.send(new GetCommand({TableName:table(),Key:keys.drop(t,q.dropId)}));if(!r.Item)throw new ApiError('NOT_FOUND','Drop not found');
  const prefix=keys.orderPrefix(t,q.dropId);let start:Record<string,string>|undefined;
  if(q.cursor){try{start=JSON.parse(Buffer.from(q.cursor,'base64url').toString());}catch{throw new ApiError('VALIDATION','Invalid cursor');}
    if(!start||Object.keys(start).some(k=>!['PK','SK'].includes(k))||start.PK!==prefix.PK||typeof start.SK!=='string'||!start.SK.startsWith(prefix.SKPrefix))throw new ApiError('VALIDATION','Invalid cursor');}
  const page=await ddb.send(new QueryCommand({TableName:table(),KeyConditionExpression:'PK=:p AND begins_with(SK,:s)',ExpressionAttributeValues:{':p':prefix.PK,':s':prefix.SKPrefix},ExclusiveStartKey:start,ConsistentRead:true,Limit:50}));
  const ttl=Date.parse(String(r.Item.endAt))+180*86400000;
  const rows=(page.Items??[]).filter(i=>Number(i.ttl??ttl/1000)*1000>Date.now()).map(i=>strip<Order>(i)!).filter(o=>{
    const tr=trackingOf(o);
    return (!q.payment||q.payment===tr.paymentStatus)&&(!q.fulfillment||q.fulfillment===tr.fulfillmentStatus)&&(!q.method||q.method===tr.fulfillmentMethod);
  });
  return {enabled:true,rows,nextCursor:page.LastEvaluatedKey?Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url'):undefined,scope:'Filtered page of 50 evaluated orders; continue paging when no matches appear.'};
}
export async function inventorySnapshot(t:string,dropId:string){
  if(!analyticsEnabled())throw new ApiError('NOT_IMPLEMENTED','Merchant analytics is not enabled');
  const source=await ddb.send(new GetCommand({TableName:table(),Key:keys.drop(t,dropId),ConsistentRead:true}));
  const drop=strip<Drop>(source.Item);if(!drop)throw new ApiError('NOT_FOUND','Drop not found');
  const prefix=keys.orderPrefix(t,dropId);
  const page=await ddb.send(new QueryCommand({TableName:table(),KeyConditionExpression:'PK=:p AND begins_with(SK,:s)',ExpressionAttributeValues:{':p':prefix.PK,':s':prefix.SKPrefix},Limit:500,ConsistentRead:true}));
  const retained=(page.Items??[]).filter(o=>Number(o.ttl??(Date.parse(drop.endAt)/1000+180*86400))*1000>Date.now());
  const wanted=drop.variants.flatMap(v=>Array.from({length:drop.shardCount},(_,i)=>keys.stockShard(t,dropId,v.id,i)));
  const rows:Record<string,unknown>[]=[];let unprocessed=false;
  if(drop.state==='Live')for(let i=0;i<wanted.length;i+=100){
    const r=await ddb.send(new BatchGetCommand({RequestItems:{[table()]:{Keys:wanted.slice(i,i+100),ConsistentRead:true}}}));rows.push(...r.Responses?.[table()]??[]);unprocessed ||=Boolean(r.UnprocessedKeys?.[table()]?.Keys?.length);
  }
  const variants=drop.variants.map(v=>{
    const keysForVariant=new Set(Array.from({length:drop.shardCount},(_,i)=>keys.stockShard(t,dropId,v.id,i).PK));
    const shards=rows.filter(r=>keysForVariant.has(String(r.PK)));const out=shards.reduce((n,r)=>n+Number(r.sold??0),0);const confirmedUnits=retained.filter(o=>o.variantId===v.id).reduce((n,o)=>n+Number(o.qty),0);
    const complete=drop.state==='Live'&&!unprocessed&&shards.length===drop.shardCount&&Number.isFinite(out)&&out>=0&&out<=v.stock&&out>=confirmedUnits;
    return {id:v.id,name:v.name,stock:v.stock,out,confirmedUnits,complete,available:complete?v.stock-out:null};
  });
  return {state:drop.state,generatedAt:new Date().toISOString(),ordersPartial:Boolean(page.LastEvaluatedKey),variants,partial:drop.state==='Live'&&variants.some(v=>!v.complete)};
}
export async function exportAnalytics(t:string,q:Record<string,string|undefined>){
  // Rate-limit exports with a tenant-scoped quota rather than creating another asynchronous service.
  const report=await analyticsReport(t,{...q,advanced:'1'});
  if(!report.enabled)throw new ApiError('NOT_IMPLEMENTED','Merchant analytics is not enabled');
  if('scope'in report&&(report.scope.partial||report.scope.retentionLimited))throw new ApiError('VALIDATION','Select a smaller, complete retained drop report before exporting');
  try{await ddb.send(new UpdateCommand({TableName:table(),Key:{PK:`T#${t}`,SK:`ANALYTICS_EXPORT#${new Date().toISOString().slice(0,13)}`},UpdateExpression:'ADD n :one SET #ttl=:ttl',ConditionExpression:'attribute_not_exists(n) OR n<:max',ExpressionAttributeNames:{'#ttl':'ttl'},ExpressionAttributeValues:{':one':1,':max':2,':ttl':Math.floor(Date.now()/1000)+86400}}));}
  catch(e){if((e as {name?:string}).name==='ConditionalCheckFailedException')throw new ApiError('RATE_LIMITED','Up to two advanced exports per hour',3600);throw e;}
  const rows='days'in report?report.days:[];
  return ['day,orders,confirmed_sgd,recorded_paid_sgd',...rows.map(d=>[d.day,d.orders,(d.confirmedCents/100).toFixed(2),(d.paidCents/100).toFixed(2)].join(','))].join('\r\n')+'\r\n';
}
