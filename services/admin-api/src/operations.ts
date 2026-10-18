import { BatchGetCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, table } from '@dropdeck/shared/ddb';
import { ApiError, invoicePreview, keys, usageMonth, type MerchantProfile, type Usage } from '@dropdeck/shared';
import { healthIssues, type DropHealth, type OpsRange } from '@dropdeck/shared/operations';

export function decodeCursor(raw: string | undefined, partition: string): Record<string,string> | undefined {
  if(!raw) return;
  try {
    if(raw.length>2048) throw new Error();
    const value=JSON.parse(Buffer.from(raw,'base64url').toString());
    if(Object.keys(value).sort().join()!=='PK,SK' || value.PK!==partition || typeof value.SK!=='string' || value.SK.length>300) throw new Error();
    return value;
  } catch { throw new ApiError('VALIDATION','Invalid pagination cursor'); }
}
const cursor = (v: unknown) => v ? Buffer.from(JSON.stringify(v)).toString('base64url') : undefined;
export function monthsThrough(month: string) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ApiError('VALIDATION','Month must be YYYY-MM');
  const [year,m]=month.split('-').map(Number);
  return Array.from({length:6},(_,i)=>new Date(Date.UTC(year!,m!-6+i,1)).toISOString().slice(0,7));
}

/** Page-scoped business analytics. Never present a bounded page as a global/billable total. */
export async function analytics(month=usageMonth(Date.now()), after?: string) {
  const months=monthsThrough(month);
  const page=await ddb.send(new QueryCommand({TableName:table(),KeyConditionExpression:'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues:{':pk':'TENANTS',':sk':'T#'},Limit:25,ExclusiveStartKey:decodeCursor(after,'TENANTS')}));
  const ids=(page.Items??[]).map(r=>String(r.tenantId));
  const wanted=ids.flatMap(t=>[keys.profile(t),...months.map(m=>keys.usage(t,m))]);
  const items:Record<string,unknown>[]=[];let partial=false;
  for(let i=0;i<wanted.length;i+=100) {
    let pending=wanted.slice(i,i+100);
    for(let attempt=0;pending.length && attempt<3;attempt++) {
      const r=await ddb.send(new BatchGetCommand({RequestItems:{[table()]:{Keys:pending,ConsistentRead:true}}}));
      items.push(...r.Responses?.[table()]??[]);
      pending=(r.UnprocessedKeys?.[table()]?.Keys??[]) as typeof pending;
      if(pending.length && attempt<2) await new Promise(resolve=>setTimeout(resolve,25*2**attempt));
    }
    partial ||= pending.length>0;
  }
  const byKey=new Map(items.map(r=>[`${r.PK}/${r.SK}`,r]));
  const profiles=ids.map(t=>({t,p:byKey.get(`T#${t}/PROFILE`) as unknown as MerchantProfile|undefined}));
  const usage=(t:string,m:string)=>byKey.get(`T#${t}/USAGE#${m}`) as unknown as Usage|undefined;
  return {month,generatedAt:Date.now(),scope:'page',shops:ids.length,partial,nextCursor:cursor(page.LastEvaluatedKey),
    planMix:['starter','growth','event'].map(tier=>({tier,shops:profiles.filter(x=>(x.p?.tier??'starter')===tier).length})),
    trend:months.map(m=>({month:m,...ids.reduce((a,t)=>{const u=usage(t,m);return {drops:a.drops+(u?.drops??0),sessions:a.sessions+(u?.sessions??0),orders:a.orders+(u?.orders??0)};},{drops:0,sessions:0,orders:0})})),
    merchants:profiles.map(({t,p})=>({tenantId:t,name:p?.name??'(no profile)',tier:p?.tier??'starter',sessions:usage(t,month)?.sessions??0,
      drops:usage(t,month)?.drops??0,previewSgd:invoicePreview(p?.tier??'starter',usage(t,month)).totalSgd})).sort((a,b)=>b.sessions-a.sessions),
  };
}

export function healthRow(row: Record<string,unknown>, now=Date.now()): DropHealth {
  const result={} as Record<string,unknown>;
  for(const field of ['tenantId','dropId','title','lifecycle','observedAt','heartbeatAt','publicationAttemptAt','publicationSuccessAt','publicationFailureAt','shopFailureAt','shopSuccessAt','sourceVersion','mailMode','inventory']) if(row[field]!==undefined) result[field]=row[field];
  const pub=row.publicSnapshot as Record<string,unknown>|undefined;
  if(pub) for(const k of ['publicState','publicVersion','publicLastModifiedAt']) if(pub[k]!==null && pub[k]!==undefined) result[k]=pub[k];
  const health=result as unknown as DropHealth;
  health.issues=healthIssues(health,now);
  health.severity=!health.observedAt||now-health.observedAt>180_000||health.inventory?.partial ? 'unknown'
    : health.issues.some(s=>/heartbeat|failed|differs from database/.test(s)) ? 'critical' : health.issues.length ? 'warning' : 'healthy';
  return health;
}
const opsTable=()=>process.env.OPS_TABLE_NAME;
export async function healthOverview(after?:string) {
  const TableName=opsTable();
  if(!TableName) return {enabled:false,rows:[],generatedAt:Date.now()};
  const [page,collector]=await Promise.all([
    ddb.send(new QueryCommand({TableName,KeyConditionExpression:'PK = :pk',ExpressionAttributeValues:{':pk':'REGISTRY'},Limit:25,ExclusiveStartKey:decodeCursor(after,'REGISTRY')})),
    ddb.send(new GetCommand({TableName,Key:{PK:'META',SK:'COLLECTOR'}})),
  ]);
  return {enabled:true,generatedAt:Date.now(),scope:'page',mailMode:process.env.OPS_MAIL_MODE??'log',
    collectorAt:collector.Item?.at,collectorFailures:collector.Item?.failures??0,collectorMore:Boolean(collector.Item?.cursor),
    dashboardUrl:process.env.OPS_DASHBOARD_URL,rows:(page.Items??[]).filter(r=>Number(r.ttl)>Date.now()/1000).map(r=>healthRow(r)),nextCursor:cursor(page.LastEvaluatedKey)};
}
export async function dropTelemetry(t:string,d:string,range:OpsRange) {
  if(!/^[\w-]{1,128}$/.test(t)||!/^[\w-]{1,128}$/.test(d)) throw new ApiError('VALIDATION','Invalid drop identity');
  const TableName=opsTable();if(!TableName) throw new ApiError('NOT_FOUND','Operations monitoring is not configured');
  if(!['15m','1h','24h'].includes(range)) throw new ApiError('VALIDATION','Invalid time range');
  const now=Date.now();const duration=range==='15m'?900_000:range==='1h'?3600_000:86400_000;const period=range==='24h'?3600_000:60_000;
  const prefix=range==='24h'?'HOUR':'MIN';const PK=`DROP#${t}/${d}`;
  const [metrics,history]=await Promise.all([
    ddb.send(new QueryCommand({TableName,KeyConditionExpression:'PK = :pk AND SK BETWEEN :start AND :end',ExpressionAttributeValues:{':pk':PK,':start':`${prefix}#${Math.floor((now-duration)/period)*period}`,':end':`${prefix}#${now}`},Limit:65})),
    ddb.send(new QueryCommand({TableName,KeyConditionExpression:'PK = :pk AND begins_with(SK, :sk)',ExpressionAttributeValues:{':pk':PK,':sk':'INCIDENT#'},Limit:10,ScanIndexForward:false})),
  ]);
  const totals:Record<string,number>={};
  const buckets=(metrics.Items??[]).map(row=>{
    const counts=Object.fromEntries(Object.entries(row).filter(([key,value])=>typeof value==='number'&&!['at','ttl'].includes(key))) as Record<string,number>;
    for(const [k,v] of Object.entries(counts)) totals[k]=(totals[k]??0)+v;
    return {at:Number(row.at),counts};
  });
  return {generatedAt:now,range,buckets,totals,partial:Boolean(metrics.LastEvaluatedKey),history:(history.Items??[]).map(r=>({at:r.at,issues:r.issues,severity:r.severity}))};
}
