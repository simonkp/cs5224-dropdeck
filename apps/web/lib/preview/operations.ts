/** Explicit local-only operator fixtures. This module is excluded from normal builds. */
import type { MerchantProfile } from '@dropdeck/shared';
import { invoicePreview, TIERS, type Tier } from '@dropdeck/shared/plans';
export function operatorPreview(path:string,url:URL,profile:MerchantProfile,method='GET',body:Record<string,unknown>={}):Response {
  const now=Date.now();const month=url.searchParams.get('month')??new Date(now).toISOString().slice(0,7);
  const usage={month,drops:4,cancelled:0,sessions:3600,orders:140,revenueCents:168000};
  const reply=(body:unknown)=>Response.json(body);
  if(path==='/admin/tenants/preview'&&method==='PATCH') {
    if(!TIERS.includes(body.tier as Tier))return Response.json({code:'VALIDATION',message:'Invalid plan'},{status:400});
    profile.tier=body.tier as Tier;
    return reply(profile);
  }
  const tier=profile.tier;const invoice=invoicePreview(tier,usage);
  if(path==='/admin/tenants')return reply({month,tenants:[{tenantId:'preview',name:profile.name,slug:profile.slug,tier,usage,invoice,live:1,scheduled:1}],totals:{shops:1,liveNow:1,drops:4,sessions:3600,orders:140,gmvCents:168000,billedSgd:invoice.totalSgd}});
  if(path==='/admin/analytics')return reply({generatedAt:now,shops:1,partial:false,planMix:TIERS.map(value=>({tier:value,shops:Number(value===tier)})),trend:Array.from({length:6},(_,i)=>({month:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5))-6+i,1)).toISOString().slice(0,7),sessions:600+i*600,drops:i+1,orders:20+i*24})),merchants:[{tenantId:'preview',name:profile.name,tier,sessions:3600,drops:4,previewSgd:invoice.totalSgd}]});
  if(path==='/admin/health')return reply({enabled:true,generatedAt:now,collectorAt:now-20000,collectorFailures:0,mailMode:'ses',rows:[
    {tenantId:'preview',dropId:'live',title:'Saturday sourdough',lifecycle:'Live',observedAt:now-20000,heartbeatAt:now-5000,publicationAttemptAt:now-4000,publicLastModifiedAt:now-4000,sourceVersion:4,publicVersion:4,severity:'healthy',inventory:{counterUnits:42,activeUnits:11,orderUnits:31,expiredUnits:0,partial:false,sampledAt:now-20000}},
    {tenantId:'preview',dropId:'delayed',title:'Kopi Lab micro-lot',lifecycle:'Live',observedAt:now-15000,heartbeatAt:now-160000,publicationFailureAt:now-10000,publicationAttemptAt:now-10000,publicLastModifiedAt:now-180000,sourceVersion:6,publicVersion:5,severity:'critical',inventory:{counterUnits:30,activeUnits:3,orderUnits:22,expiredUnits:2,partial:false,sampledAt:now-15000}},
  ]});
  if(path.startsWith('/admin/health/')) {
    const range=url.searchParams.get('range')??'1h';const n=range==='24h'?24:range==='1h'?60:15;const period=range==='24h'?3600000:60000;
    const buckets=Array.from({length:n},(_,i)=>({at:now-(n-i)*period,counts:{requests:10+i*2,ticketsIssued:6+i,claimAttempts:4,newHolds:3,otpAccepted:2,otpDelivered:2,errors5xx:path.includes('delayed')?2:0,latencyMs:1200,latencySamples:10}}));
    const totals:Record<string,number>={};for(const b of buckets)for(const [k,v]of Object.entries(b.counts))totals[k]=(totals[k]??0)+v;
    return reply({generatedAt:now,range,partial:false,buckets,totals,history:[{at:now-180000,severity:'warning',issues:['Inventory sample differs; concurrent writes or missing confirmation records may explain it']}]});
  }
  return Response.json({code:'NOT_FOUND',message:'Unknown operator preview endpoint'},{status:404});
}
