'use client';
import { useEffect, useState } from 'react';
import type { DropHealth, DropTelemetry, OpsRange } from '@dropdeck/shared/operations';
import { healthIssues } from '@dropdeck/shared/operations';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { api, ApiRequestError } from '../../lib/api';
import { cn } from '../../lib/utils';

interface HealthPage { enabled:boolean;generatedAt:number;rows:DropHealth[];nextCursor?:string;collectorAt?:number;collectorFailures?:number;collectorMore?:boolean;dashboardUrl?:string;mailMode?:string }
type Telemetry=DropTelemetry&{history:Array<{at:number;issues:string[];severity:string}>};
const time=(at?:number)=>at?new Date(at).toLocaleString('en-SG',{timeZone:'Asia/Singapore'}):'Unknown';
const palette={healthy:'bg-ok/10 text-ok',warning:'bg-warn-tint text-warn',critical:'bg-danger-tint text-danger',unknown:'bg-sunken text-muted'};
function status(row:DropHealth,now:number) {return !row.observedAt||now-row.observedAt>180000||row.inventory?.partial?'unknown':row.severity??'unknown';}

export function OperationsView() {
  const [data,setData]=useState<HealthPage|null>(null);const [error,setError]=useState(false);const [cursor,setCursor]=useState<string>();
  const [previous,setPrevious]=useState<Array<string|undefined>>([]);const [selected,setSelected]=useState<string>();
  const [retry,setRetry]=useState(0);const [range,setRange]=useState<OpsRange>('1h');const [filter,setFilter]=useState('');const [attention,setAttention]=useState(false);
  const [detail,setDetail]=useState<Telemetry|null>(null);const [detailError,setDetailError]=useState(false);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{
    let active=true;setData(null);setError(false);setSelected(undefined);
    const load=async()=>{if(active)setNow(Date.now());try{const result=await api<HealthPage>(`/admin/health${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);if(active){setData(result);setError(false);setNow(Date.now());}}catch(e){if(active){setError(true);if(e instanceof ApiRequestError&&[401,403].includes(e.status))setData(null);}}};
    void load();const timer=setInterval(()=>{if(!document.hidden)void load();},15000);
    return()=>{active=false;clearInterval(timer);};
  },[cursor,retry]);
  useEffect(()=>{
    if(!selected){setDetail(null);return;}
    let active=true;setDetail(null);setDetailError(false);
    const load=async()=>{try{const r=await api<Telemetry>(`/admin/health/${selected}?range=${range}`);if(active){setDetail(r);setDetailError(false);}}catch{if(active)setDetailError(true);}};
    void load();const timer=setInterval(()=>{if(!document.hidden)void load();},30000);
    return()=>{active=false;clearInterval(timer);};
  },[selected,range,retry]);
  if(data&&!data.enabled)return <Card><h2 className="font-bold">Operations monitoring is not configured</h2><p className="mt-2 text-sm text-muted">Deploy this stage with monitoring enabled to collect health data.</p></Card>;
  const rows=data?.rows??[];
  const visible=rows.filter(r=>(!attention||status(r,now)!=='healthy')&&`${r.title} ${r.tenantId} ${r.dropId}`.toLowerCase().includes(filter.toLowerCase()));
  const row=rows.find(r=>`${r.tenantId}/${r.dropId}`===selected);
  const totals=detail?.totals;
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="font-display text-3xl font-extrabold">Operations</h1><p className="mt-1 text-sm text-muted">Health evidence and incident diagnostics · Singapore time</p></div><div className="flex gap-2"><Button variant="outline" onClick={()=>setRetry(n=>n+1)}>Refresh</Button>{data?.dashboardUrl&&<Button variant="ink" asChild><a href={data.dashboardUrl} target="_blank" rel="noreferrer">CloudWatch dashboard</a></Button>}</div></div>
    {error&&<Card><p role="status" className="text-warn">Health could not refresh. {data?'Last available data is shown.':'Retry to load operations data.'}</p></Card>}
    {!data&&!error&&<p className="text-muted">Loading health snapshots…</p>}
    {data&&<>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Drops on this page',rows.length],['Need attention',rows.filter(r=>['critical','warning'].includes(status(r,now))).length],['Unknown',rows.filter(r=>status(r,now)==='unknown').length],['Collection failures',data.collectorFailures??0]].map(([label,value])=><Card key={label}><p className="text-xs font-bold uppercase text-muted">{label}</p><strong className="mt-2 block font-display text-3xl">{value}</strong></Card>)}</div>
      <p className="text-xs text-muted">Last collection: {time(data.collectorAt)}. Health samples are collected in bounded batches each minute; this view refreshes every 15 seconds. {data.collectorMore?'Other drops remain in the collection cycle.':''}</p>
      {(!data.collectorAt||now-data.collectorAt>180000)&&<p role="status" className="rounded-xl bg-warn-tint p-3 text-sm text-warn">Collector data is missing or delayed. Health is not confirmed.</p>}
      <div className="flex flex-wrap items-center gap-3"><input className="min-w-[220px] flex-1 rounded-xl border border-field bg-surface px-3 py-2 text-sm" aria-label="Filter drops on this page" placeholder="Filter this page by drop or merchant ID" value={filter} onChange={e=>setFilter(e.target.value)}/><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={attention} onChange={e=>setAttention(e.target.checked)}/>Needs attention only</label></div>
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface"><table className="w-full min-w-[830px] text-left text-sm"><thead className="bg-sunken text-xs uppercase text-muted"><tr>{['Drop / merchant','Health','Controller heartbeat','Last public write (S3)','Inventory sample'].map(s=><th className="p-3" key={s}>{s}</th>)}</tr></thead><tbody>{visible.map(r=><tr key={`${r.tenantId}/${r.dropId}`} className={cn('border-t border-line',selected===`${r.tenantId}/${r.dropId}`&&'bg-sunken')}><td className="p-3"><button className="text-left font-bold underline underline-offset-4" onClick={()=>setSelected(`${r.tenantId}/${r.dropId}`)}>{r.title??r.dropId}</button><p className="mt-1 text-xs text-muted">{r.lifecycle??'Unknown'} · {r.tenantId.slice(0,8)}</p></td><td className="p-3"><span className={cn('rounded-full px-2 py-1 text-xs font-bold',palette[status(r,now)])}>{status(r,now)}</span></td><td className="p-3 text-xs">{time(r.heartbeatAt)}</td><td className="p-3 text-xs">{time(r.publicLastModifiedAt)}</td><td className="p-3 text-xs">{!r.inventory||r.inventory.partial?'Incomplete':`${r.inventory.counterUnits} in counters · ${r.inventory.activeUnits} active + ${r.inventory.orderUnits} ordered`}<p className="text-muted">Diagnostic sample; not a stock-release authorization</p></td></tr>)}</tbody></table></div>
      {!visible.length&&<Card><p className="text-sm text-muted">{rows.length?'No drops match this page’s filters.':'No drops observed yet. Newly scheduled drops and controller activity register automatically; older drops appear after their next publication or controller run.'}</p></Card>}
      <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={!previous.length} onClick={()=>{setCursor(previous.at(-1));setPrevious(p=>p.slice(0,-1));}}>Previous drops</Button><Button size="sm" variant="outline" disabled={!data.nextCursor} onClick={()=>{setPrevious(p=>[...p,cursor]);setCursor(data.nextCursor);}}>Next drops</Button></div>
    </>}
    {row&&<section aria-label="Drop diagnostics" className="flex flex-col gap-3">
      <Card><h2 className="font-display text-xl font-extrabold">{row.title??row.dropId}</h2><p className="mt-1 break-all font-mono text-xs text-muted">{row.tenantId} / {row.dropId}</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{healthIssues(row,now).map(issue=><li key={issue}>{issue}</li>)}</ul><p className="mt-3 text-xs text-muted">Snapshot observed: {time(row.observedAt)} · Source revision {row.sourceVersion??'unknown'} / public revision {row.publicVersion??'unknown'}. Last publication attempt: {time(row.publicationAttemptAt)}.</p></Card>
      <div className="flex flex-wrap items-center gap-2"><span className="mr-2 text-sm font-bold">Request telemetry</span>{(['15m','1h','24h'] as const).map(r=><Button size="sm" variant={range===r?'ink':'outline'} key={r} onClick={()=>setRange(r)} aria-pressed={range===r}>{r}</Button>)}</div>
      {detailError&&<p role="status" className="text-warn">Request telemetry could not refresh.</p>}
      {!detail&&!detailError&&<p className="text-muted">Loading request telemetry…</p>}
      {detail&&<>
        {!detail.buckets.length&&<Card><p className="text-sm text-muted">No telemetry in this window. This may mean no traffic or delayed ingestion; it does not establish healthy service.</p></Card>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[['Tickets issued','ticketsIssued'],['Claim attempts','claimAttempts'],['New holds','newHolds'],['Confirm attempts','confirmAttempts'],['API 5xx','errors5xx'],['Application 429s','app429'],['Edge 429s (ticket/claim)','edge429'],['Mean handler latency','latency']].map(([label,key])=><Card key={key}><p className="text-xs font-bold uppercase text-muted">{label}</p><strong className="mt-1 block text-2xl tabular">{!detail.buckets.length?'—':key==='latency'?(totals?.latencySamples?`${Math.round((totals.latencyMs??0)/totals.latencySamples)} ms`:'—'):(totals?.[key!]??0).toLocaleString()}</strong></Card>)}</div>
        <Card><h3 className="font-bold">Requests over time</h3><div className="mt-3 flex h-24 items-end gap-1" role="img" aria-label={`${detail.buckets.length} minute or hour buckets; total ${totals?.requests??0} requests`}>{detail.buckets.map(b=><div key={b.at} className="min-w-1 flex-1 rounded-t bg-ink" style={{height:`${Math.max(2,(b.counts.requests??0)/Math.max(1,...detail.buckets.map(x=>x.counts.requests??0))*100)}%`}} title={`${time(b.at)}: ${b.counts.requests??0} requests`}/>)}</div><p className="mt-2 text-xs text-muted">Handler attempts, including retries. p50/p95 service latency is available in CloudWatch. Counts are diagnostic estimates, not billing or unique-buyer counts.{detail.partial?' This window is incomplete.':''}</p></Card>
        <Card><h3 className="font-bold">Checkout email delivery</h3><p className="mt-1 text-xs text-muted">{data?.mailMode==='log'?'This stage uses test mode; no OTP emails are sent.':'SES acceptance means sending has started. Delivered means the recipient mail server accepted the message; inbox placement is not confirmed.'}</p><dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{[['Accepted by SES','otpAccepted'],['Delivered','otpDelivered'],['Verified at checkout','otpVerified'],['Send failures','otpFailed'],['Delivery delays','otpDelayed'],['Bounces','otpBounce'],['Complaints','otpComplaint'],['Rejected by SES','otpRejected']].map(([label,key])=><div key={key}><dt className="text-xs text-muted">{label}</dt><dd className="text-xl font-bold tabular">{data?.mailMode==='log'||!detail.buckets.length?'—':totals?.[key!]??0}</dd></div>)}</dl></Card>
        <Card><h3 className="font-bold">Recent health changes</h3>{!detail.history.length?<p className="mt-2 text-sm text-muted">No recorded health transitions.</p>:<ol className="mt-3 space-y-3">{detail.history.map(h=><li key={h.at} className="border-l-2 border-line pl-3 text-sm"><strong>{h.severity}</strong><span className="ml-2 text-xs text-muted">{time(h.at)}</span><p>{h.issues.length?h.issues.join(' · '):'Previously detected issues cleared in the latest sample.'}</p></li>)}</ol>}</Card>
      </>}
    </section>}
  </div>;
}
