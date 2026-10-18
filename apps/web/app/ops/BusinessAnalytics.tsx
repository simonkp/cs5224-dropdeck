'use client';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { api } from '../../lib/api';
import { PLANS, type Tier } from '@dropdeck/shared/plans';

interface Analytics {
  generatedAt:number; shops:number; partial:boolean; nextCursor?:string;
  planMix:Array<{tier:Tier;shops:number}>;
  trend:Array<{month:string;sessions:number;orders:number;drops:number}>;
  merchants:Array<{tenantId:string;name:string;tier:Tier;sessions:number;drops:number;previewSgd:number}>;
}
export function BusinessAnalytics({month}:{month:string}) {
  const [data,setData]=useState<Analytics|null>(null);const [cursor,setCursor]=useState<string>();const [previous,setPrevious]=useState<Array<string|undefined>>([]);
  const [error,setError]=useState(false);const [retry,setRetry]=useState(0);
  useEffect(()=>{setCursor(undefined);setPrevious([]);},[month]);
  useEffect(()=>{
    let active=true;setData(null);setError(false);
    api<Analytics>(`/admin/analytics?month=${month}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`).then(r=>{if(active)setData(r);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[month,cursor,retry]);
  if(error) return <Card><p role="status">Business analytics could not load. <Button variant="outline" size="sm" onClick={()=>setRetry(n=>n+1)}>Retry</Button></p></Card>;
  if(!data) return <Card><p className="text-sm text-muted">Loading business analytics…</p></Card>;
  const max=Math.max(1,...data.trend.map(r=>r.sessions));
  return <section aria-label="Business analytics" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-display text-xl font-extrabold">Business analytics</h2><div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={!previous.length} onClick={()=>{setCursor(previous.at(-1));setPrevious(p=>p.slice(0,-1));}}>Previous shops</Button>
      <Button size="sm" variant="outline" disabled={!data.nextCursor} onClick={()=>{setPrevious(p=>[...p,cursor]);setCursor(data.nextCursor);}}>Next shops</Button>
    </div></div>
    <p className="text-xs text-muted">Charts cover this page of {data.shops} shops, not all merchants. Usage is posted when drops finish. Plan mix is current; bills are previews using current plans.</p>
    {data.partial&&<p role="status" className="text-sm text-warn">Some usage records could not be read. These figures are incomplete.</p>}
    <div className="grid gap-3 lg:grid-cols-2">
      <Card><h3 className="mb-3 font-bold">Current plan mix</h3><div className="flex flex-col gap-3">{data.planMix.map(p=><div key={p.tier}><div className="mb-1 flex justify-between text-sm"><span>{PLANS[p.tier].label}</span><strong>{p.shops} shops</strong></div><div className="h-2 rounded bg-sunken"><div className="h-2 rounded bg-volt" style={{width:`${data.shops?p.shops/data.shops*100:0}%`}}/></div></div>)}</div></Card>
      <Card><h3 className="mb-3 font-bold">Monthly buyer sessions</h3><div className="flex flex-col gap-2">{data.trend.map(m=><div key={m.month} className="grid grid-cols-[64px_1fr_65px] items-center gap-2 text-xs"><span>{m.month}</span><div className="h-3 rounded bg-sunken"><div className="h-3 rounded bg-ink" style={{width:`${m.sessions/max*100}%`}}/></div><span className="text-right tabular">{m.sessions.toLocaleString()}</span></div>)}</div><p className="mt-3 text-xs text-muted">Selected shops across six months. Sessions do not represent unique people.</p></Card>
    </div>
    <Card><h3 className="mb-3 font-bold">Usage and billing preview · {month}</h3><div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="text-xs uppercase text-muted"><tr>{['Merchant','Current plan','Drops','Sessions / included','Bill preview'].map(s=><th key={s} className="py-2 pr-3">{s}</th>)}</tr></thead><tbody>{data.merchants.map(m=><tr key={m.tenantId} className="border-t border-line"><td className="py-3 pr-3 font-bold">{m.name}</td><td>{PLANS[m.tier].label}</td><td className="tabular">{m.drops}</td><td className="tabular">{m.sessions.toLocaleString()} / {PLANS[m.tier].sessionsIncluded?.toLocaleString()??'not session-metered'}</td><td className="tabular">S${m.previewSgd.toFixed(2)}</td></tr>)}</tbody></table></div></Card>
  </section>;
}
