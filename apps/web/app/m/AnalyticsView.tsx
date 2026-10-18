'use client';

import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, ChartNoAxesCombined, Check, Layers3, RefreshCw, TrendingUp, Trophy } from 'lucide-react';
import type { Order } from '@dropdeck/shared';
import { singaporeDay, trackingOf, trackingCsv, type OrderTracking, type SalesTotals } from '@dropdeck/shared/merchant-analytics';
import { api, apiText, ApiRequestError } from '../../lib/api';
import { price, message } from '../../lib/format';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { ViewHeader, type ConsoleCtx } from './shared';
import { REMINDER_BATCH_LIMIT, reminderProblem, type ReminderOrder, type PaymentReminder } from '@dropdeck/shared/payment-reminders';
import { PaymentReminderPanel } from './PaymentReminderPanel';

interface Comparison extends SalesTotals { dropId:string;title:string;stock:number;sellThrough:number|null }
interface Report {
  enabled:boolean;capabilities:{tier:string;advancedPreview:boolean;reminderMode?:'ses'|'disabled'|'demo'};generatedAt:string;from:string;to:string;
  totals:SalesTotals;days:Array<{day:string;orders:number;confirmedCents:number;paidCents:number}>;legacyDates:boolean;
  scope:{drops:number;availableDrops:number;partial:boolean;maxOrdersPerDrop:number;retentionLimited?:boolean};
  comparisons?:Comparison[];variants?:Array<SalesTotals&{dropId:string;variantId:string;name:string;dropTitle:string;stock:number}>;insights?:string[];
  previous?:{from:string;to:string;confirmedCents:number;changePercent:number|null};
}
type Tab='overview'|'inventory'|'payments'|'fulfillment'|'advanced';
const field='h-10 w-full rounded-xl border border-field bg-surface px-3 text-sm';
const label='flex flex-col gap-1.5 text-xs font-bold text-muted';
function download(text:string,name:string) {const href=URL.createObjectURL(new Blob([text],{type:'text/csv'}));const a=document.createElement('a');a.href=href;a.download=name;a.click();URL.revokeObjectURL(href);}

export function AnalyticsView({ctx}:{ctx:ConsoleCtx}) {
  const [tab,setTab]=useState<Tab>('overview');const [dropId,setDropId]=useState('');
  const [to,setTo]=useState(()=>singaporeDay(Date.now()));const [from,setFrom]=useState(()=>new Date(Date.parse(singaporeDay(Date.now()))-6*86400000).toISOString().slice(0,10));
  const [data,setData]=useState<Report|null>(null);const [error,setError]=useState('');const [retry,setRetry]=useState(0);const [busy,setBusy]=useState(false);
  const [inventory,setInventory]=useState<{variants:Array<{id:string;name:string;stock:number;out:number;confirmedUnits:number;complete:boolean;available:number|null}>;partial:boolean;ordersPartial:boolean}|null>(null);
  const [inventoryError,setInventoryError]=useState(false);
  const query=new URLSearchParams({from,to,...(dropId?{dropId}:{}),...(tab==='advanced'?{advanced:'1'}:{})}).toString();
  useEffect(()=>{
    let active=true;
    const load=async()=>{try{const r=await api<Report>(`/m/analytics?${query}`);if(active){setData(r);setError('');}}
      catch(e){if(active){setError(message(e));if(e instanceof ApiRequestError&&[401,402,403].includes(e.status))setData(null);}}};
    setData(null);setError('');void load();
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},60000);
    return()=>{active=false;clearInterval(timer);};
  },[query,retry]);
  const selected=ctx.drops?.find(d=>d.dropId===dropId);
  useEffect(()=>{
    let active=true;setInventory(null);setInventoryError(false);
    if(tab!=='inventory'||!selected||selected.state!=='Live')return;
    const load=async()=>{try{const r=await api<NonNullable<typeof inventory>>(`/m/drops/${selected.dropId}/inventory`);if(active){setInventory(r);setInventoryError(false);}}catch{if(active)setInventoryError(true);}};
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);
    return()=>{active=false;clearInterval(timer);};
  },[tab,selected,retry]);
  const advanced=data?.capabilities.advancedPreview??ctx.profile?.tier==='growth';
  const tabs:Array<[Tab,string]>=[['overview','Overview'],['inventory','Inventory'],['payments','Payments'],['fulfillment','Pickup & delivery'],...(advanced?[['advanced','Advanced preview'] as [Tab,string]]:[])];
  return <>
    <ViewHeader title="Your business, in view" sub={<span className="text-sm text-muted">Sales, stock and the orders that need your attention.</span>} actions={<Button variant="outline" aria-label="Refresh analytics" onClick={()=>{setRetry(n=>n+1);void ctx.refresh();}}><RefreshCw className="size-4"/><span className="hidden sm:inline">Refresh</span></Button>}/>
    <div className="flex flex-col gap-5 px-4 pb-8 lg:px-8">
      <div className="flex gap-1 overflow-x-auto rounded-2xl bg-sunken p-1" aria-label="Analytics sections">{tabs.map(([key,name])=><button key={key} onClick={()=>setTab(key)} aria-pressed={tab===key} className={cn('shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold text-muted',tab===key&&'bg-surface text-ink shadow-sm')}>{name}</button>)}</div>
      <div className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-3">
        <label className={label}>Drop<select className={field} value={dropId} onChange={e=>setDropId(e.target.value)}><option value="">All recent drops</option>{ctx.drops?.filter(d=>d.state!=='Draft').map(d=><option key={d.dropId} value={d.dropId}>{d.title}</option>)}</select></label>
        <label className={label}>From · Singapore time<input className={field} type="date" value={from} max={to} onChange={e=>setFrom(e.target.value)}/></label>
        <label className={label}>To · Singapore time<input className={field} type="date" value={to} min={from} max={singaporeDay(Date.now())} onChange={e=>setTo(e.target.value)}/></label>
      </div>
      {error&&<Card><p role="alert" className="text-sm text-danger">{error}{data?' Last available values are shown.':''}</p></Card>}
      {!data&&!error&&<Card><p role="status" className="text-sm text-muted">Loading your sales results…</p></Card>}
      {data&&!data.enabled&&<Card><h2 className="font-bold">Merchant analytics is not enabled</h2><p className="mt-2 text-sm text-muted">This stage has not enabled the merchant dashboard.</p></Card>}
      {data?.enabled&&<>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{data.scope.drops} of {data.scope.availableDrops} drops in this selection · updated {new Date(data.generatedAt).toLocaleTimeString('en-SG',{timeZone:'Asia/Singapore'})} SGT</span><span>SGD · merchant-recorded payments</span></div>
        {data.scope.partial&&<p role="status" className="rounded-xl bg-warn-tint p-3 text-sm text-warn">Partial results: this snapshot covers up to 20 drops and 500 retained orders per drop. Select an individual drop for a narrower report. Totals and comparisons may be incomplete.</p>}
        <p className="text-xs text-muted">Figures include retained order records only; order details expire 180 days after the drop.</p>
        {data.scope.retentionLimited&&<p role="status" className="rounded-xl bg-warn-tint p-3 text-sm text-warn">This selection or its comparison period extends into expired history. Missing records cannot be reconstructed; figures and changes may be incomplete.</p>}
        {data.legacyDates&&<p className="text-xs text-muted">Legacy orders use their reservation date. New orders use confirmation time. Detailed results include only retained order records.</p>}
        {tab==='advanced'&&<section aria-label="Growth analytics preview" className="relative isolate overflow-hidden rounded-[24px] bg-[#101114] p-5 text-white sm:p-7">
          <div aria-hidden="true" className="pointer-events-none absolute -top-20 -right-16 -z-10 size-64 rounded-full bg-volt/10 blur-3xl"/>
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-lg">
              <span className="inline-flex items-center gap-2 rounded-full border border-volt/20 bg-volt/10 px-3 py-1 text-[10px] font-extrabold tracking-[0.12em] text-volt"><span aria-hidden="true" className="size-1.5 rounded-full bg-volt"/>GROWTH · PREVIEW</span>
              <h2 className="mt-4 font-display text-[28px] leading-[1.08] font-extrabold tracking-[-0.03em] sm:text-[34px]">See what’s driving<br className="hidden sm:block"/> your sales.</h2>
              <p className="mt-3 max-w-sm text-sm leading-relaxed text-[#b8bdc7]">Compare your drops, discover your bestsellers and turn your shop’s results into a clearer next step.</p>
            </div>
            <div aria-hidden="true" className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-2xl border border-volt/20 bg-volt/10 text-volt sm:size-16"><ChartNoAxesCombined className="size-6 sm:size-8" strokeWidth={1.5}/></div>
          </div>
          <div className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-xs font-semibold text-[#e0e3e8]">{[{icon:Layers3,title:'Compare drops'},{icon:Trophy,title:'Find bestsellers'},{icon:TrendingUp,title:'Spot sales trends'}].map(({icon:Icon,title})=><span key={title} className="inline-flex items-center gap-2"><Icon aria-hidden="true" className="size-3.5 text-volt"/>{title}</span>)}</div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-4 text-[11px] text-[#949ba8]"><span>Built into DropDeck · uses your shop’s data</span><span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-1.5 rounded-full bg-[#949ba8]"/>QuickSight not connected</span></div>
        </section>}
        {(tab==='overview'||tab==='advanced')&&<>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
            ['Confirmed value',price(data.totals.confirmedCents),`${data.totals.orders} orders · ${data.totals.units} units`],
            ['Recorded paid',price(data.totals.paidCents),'Recorded by your shop'],['Awaiting payment',price(data.totals.awaitingCents),'Ready for reconciliation'],['Average order',data.totals.orders?price(Math.round(data.totals.confirmedCents/data.totals.orders)):'—','Confirmed value / orders'],
          ].map(([title,value,sub],i)=><div key={title} className={cn('rounded-2xl border border-line bg-surface p-4',i===0&&'border-[#101114] bg-[#101114] text-white')}><p className={cn('text-xs font-bold',i===0?'text-white/65':'text-muted')}>{title}</p><p className="mt-3 font-display text-3xl font-extrabold tracking-tight">{value}</p><p className={cn('mt-2 text-xs',i===0?'text-white/65':'text-muted')}>{sub}</p></div>)}</div>
          <SalesChart days={data.days}/>
          <div className="grid gap-3 sm:grid-cols-3">{[['Awaiting pickup / delivery',data.totals.fulfillmentOpen,'fulfillment'],['Past due',data.totals.overdue,'fulfillment'],['Unknown payment',price(data.totals.unknownCents),'payments']].map(([title,value,target])=><button key={title} onClick={()=>setTab(target as Tab)} className="flex items-center justify-between rounded-2xl border border-line bg-surface p-4 text-left"><span><span className="text-xs font-bold text-muted">{title}</span><strong className="mt-1 block text-xl">{value}</strong></span><ArrowUpRight className="size-4 text-muted"/></button>)}</div>
          <p className="text-xs text-muted">{data.totals.noShowUnits} no-show units · {data.totals.fulfillmentUnknown} orders with pickup / delivery status not recorded. Confirmed value includes no-shows and is not cash received.</p>
        </>}
        {tab==='advanced'&&<>
          <Card><h3 className="font-bold">What your results show</h3><ul className="mt-3 space-y-2 text-sm">{data.insights?.map(s=><li key={s} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-ok"/>{s}</li>)}</ul><p className="mt-3 text-xs text-muted">{data.previous?.changePercent==null?'Previous-period growth is unavailable without a nonzero baseline.':`${data.previous.changePercent.toFixed(1)}% change in confirmed value versus ${data.previous.from}–${data.previous.to}.`}{data.scope.partial?' Selection is incomplete; investigate before drawing conclusions.':''}</p></Card>
          <Card><h3 className="font-bold">Drop comparison</h3><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr>{['Drop','Orders','Confirmed','Paid','Sell-through*'].map(s=><th key={s} className="p-2">{s}</th>)}</tr></thead><tbody>{data.comparisons?.map(r=><tr key={r.dropId} className="border-t border-line"><td className="p-2"><button className="font-bold underline" onClick={()=>setDropId(r.dropId)}>{r.title}</button></td><td className="p-2">{r.orders}</td><td className="p-2">{price(r.confirmedCents)}</td><td className="p-2">{price(r.paidCents)}</td><td className="p-2">{r.sellThrough==null?'—':`${Math.round(r.sellThrough*100)}%`}</td></tr>)}</tbody></table></div><p className="mt-2 text-xs text-muted">*Units ordered in this date range / full drop allocation; includes no-shows.</p></Card>
          <Card><h3 className="font-bold">Top variants by confirmed value</h3>{data.variants?.length?data.variants.slice(0,5).map((v,i)=><div key={`${v.dropId}/${v.variantId}`} className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3"><span className="text-sm"><strong>{i+1}. {v.name}</strong><span className="block text-xs text-muted">{v.dropTitle} · {v.units} units</span></span><strong className="text-sm">{price(v.confirmedCents)}</strong></div>):<p className="mt-2 text-sm text-muted">No variant sales in this selection.</p>}</Card>
          <div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={busy||data.scope.partial||data.scope.retentionLimited} onClick={async()=>{setBusy(true);try{download(await apiText(`/m/analytics/export.csv?${query}`),'sales-summary.csv');}catch(e){ctx.onError(e);}finally{setBusy(false);}}}><ArrowDownToLine className="size-4"/>Export summary</Button><span className="text-xs text-muted">Complete selections only · two exports per hour</span><Button variant="outline" disabled>Natural-language questions · coming later</Button></div>
        </>}
        {tab==='inventory'&&<Card><h2 className="font-display text-xl font-extrabold">Drop inventory</h2><p className="mt-2 text-sm text-muted">Inventory is allocated per drop. Payment, pickup and delivery updates do not change stock.</p>{!selected?<p className="mt-4 text-sm">Select a drop to inspect its allocation.</p>:<>
          {inventory?.partial&&<p role="status" className="mt-3 text-sm text-warn">Stock readings are incomplete or disagree with retained orders. Availability is unknown for affected variants; refresh and investigate.</p>}
          {inventoryError&&<p role="status" className="mt-3 text-sm text-warn">Live inventory could not refresh. Displayed readings may be stale.</p>}
          {selected.variants.map(v=>{const live=inventory?.variants.find(x=>x.id===v.id);return <div key={v.id} className="mt-4 rounded-xl border border-line p-4"><div className="flex justify-between gap-3"><strong>{v.name}</strong><span className="text-sm">{v.stock} allocated</span></div><p className="mt-2 text-sm text-muted">{selected.state==='Live'?(live?`${live.out} held or confirmed · ${live.confirmedUnits}${inventory?.ordersPartial?'+':''} confirmed units · ${live.available==null?'available unknown':`${live.available} estimated available`}`:'Loading current stock…'):'Drop is not live. See the order report for retained confirmed sales.'}</p>{live&&<div className="mt-3 h-2 rounded-full bg-sunken"><div className="h-2 rounded-full bg-ink" style={{width:`${Math.min(100,live.out/Math.max(1,v.stock)*100)}%`}}/></div>}</div>;})}
          <Button variant="outline" className="mt-4" onClick={()=>ctx.go({view:'orders',id:selected.dropId})}>Open full drop report<ArrowUpRight className="size-4"/></Button>
          <p className="mt-3 text-xs text-muted">Live counters include active reservations and confirmed orders. Readings can race with checkout or include unreleased holds; they are diagnostic, not a stock-adjustment authorization.</p>
        </>}</Card>}
        {(tab==='payments'||tab==='fulfillment')&&<TrackingWorklist key={`${dropId}/${tab}`} ctx={ctx} dropId={dropId} kind={tab} reminderMode={data.capabilities.reminderMode??'disabled'} onSaved={()=>setRetry(n=>n+1)}/>}
        {!advanced&&<Card><h3 className="font-bold">Need a deeper view?</h3><p className="mt-1 text-sm text-muted">Cross-drop comparisons, variant rankings and calculated insights are available in the Growth preview. Contact DropDeck to change your plan.</p></Card>}
      </>}
    </div>
  </>;
}

function SalesChart({days}:{days:Report['days']}) {
  const max=Math.max(1,...days.map(d=>d.confirmedCents));
  return <Card><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-xl font-extrabold">Sales over time</h2><div className="flex gap-3 text-xs text-muted"><span>● Confirmed</span><span className="text-ok">● Recorded paid</span></div></div><p className="mt-1 text-xs text-muted">Order-date cohorts · SGD · Singapore time</p><div className="mt-5 overflow-x-auto"><div className="flex min-w-max items-end gap-3 border-b border-line pt-5" role="img" aria-label="Daily confirmed and recorded paid sales. Exact values are available in the table below.">{days.map(d=><div key={d.day} className="flex w-9 flex-col items-center gap-2"><div className="flex h-36 items-end gap-1"><div title={`${d.day}: confirmed ${price(d.confirmedCents)}`} className="w-3 rounded-t bg-ink" style={{height:`${d.confirmedCents/max*100}%`,minHeight:d.orders?3:1}}/><div title={`${d.day}: recorded paid ${price(d.paidCents)}`} className="w-3 rounded-t bg-ok" style={{height:`${d.paidCents/max*100}%`,minHeight:1}}/></div><span className="pb-2 text-[10px] text-muted">{d.day.slice(5)}</span></div>)}</div></div><details className="mt-4 text-xs"><summary className="cursor-pointer font-bold">View daily figures</summary><table className="mt-2 w-full text-left"><thead><tr><th>Date</th><th>Orders</th><th>Confirmed</th><th>Recorded paid</th></tr></thead><tbody>{days.map(d=><tr key={d.day}><td>{d.day}</td><td>{d.orders}</td><td>{price(d.confirmedCents)}</td><td>{price(d.paidCents)}</td></tr>)}</tbody></table></details></Card>;
}

function TrackingWorklist({ctx,dropId,kind,reminderMode,onSaved}:{ctx:ConsoleCtx;dropId:string;kind:'payments'|'fulfillment';reminderMode:'ses'|'disabled'|'demo';onSaved:()=>void}) {
  const [rows,setRows]=useState<ReminderOrder[]>([]);const [cursor,setCursor]=useState<string>();const [next,setNext]=useState<string>();const [filter,setFilter]=useState('');const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [selected,setSelected]=useState<Order>();const [revision,setRevision]=useState(0);
  const [checked,setChecked]=useState<string[]>([]);const [review,setReview]=useState<ReminderOrder[]>();
  const drop=ctx.drops?.find(d=>d.dropId===dropId);
  const canRemind=kind==='payments'&&reminderMode!=='disabled'&&Boolean(ctx.profile?.paynow?.trim())&&Boolean(drop&&['Live','Closed'].includes(drop.state));
  const eligible=rows.filter(o=>drop&&!reminderProblem(o,drop));
  useEffect(()=>{if(!dropId)return;let active=true;setLoading(true);setRows([]);setError('');setChecked([]);
    const q=new URLSearchParams({dropId,...(cursor?{cursor}:{}),...(filter?{[kind==='payments'?'payment':'fulfillment']:filter}:{})});
    api<{rows:ReminderOrder[];nextCursor?:string}>(`/m/order-worklist?${q}`).then(r=>{if(active){setRows(r.rows);setNext(r.nextCursor);}}).catch(e=>{if(active)setError(message(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
  },[dropId,cursor,kind,filter,revision]);
  if(!dropId)return <Card><p className="text-sm text-muted">Select a drop to manage its {kind==='payments'?'payments':'pickups and deliveries'}.</p></Card>;
  const columns='sm:grid-cols-[minmax(0,1fr)_7rem_9rem_1.25rem] sm:gap-x-6';
  return <Card>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <h2 className="font-display text-xl leading-tight font-extrabold sm:pb-2">{kind==='payments'?'Payment reconciliation':'Pickup & delivery worklist'}</h2>
      <label className={cn(label,'w-full sm:w-44 sm:shrink-0')}>Filter<select className={field} value={filter} onChange={e=>{setFilter(e.target.value);setCursor(undefined);}}><option value="">All statuses</option>{(kind==='payments'?['awaiting','paid','unknown']:['unknown','not_started','ready','shipped','collected','delivered','exception']).map(s=><option key={s} value={s}>{s.replaceAll('_',' ')}</option>)}</select></label>
    </div>
    <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted">Manage orders for the selected drop; sales-date filters do not apply. Status is recorded manually. Order details are kept for 180 days after drop end.</p>
    {kind==='payments'&&<div className="mt-5 rounded-xl border border-line bg-sunken p-3"><div className="flex flex-wrap items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs font-bold"><input type="checkbox" className="size-4 accent-ink" disabled={!canRemind||loading||!eligible.length} checked={eligible.length>0&&eligible.slice(0,REMINDER_BATCH_LIMIT).every(o=>checked.includes(o.ref))} onChange={e=>setChecked(e.target.checked?eligible.slice(0,REMINDER_BATCH_LIMIT).map(o=>o.ref):[])}/>Select up to {REMINDER_BATCH_LIMIT} awaiting orders on this page</label><Button variant="ink" size="sm" disabled={!canRemind||!checked.length||loading} onClick={()=>setReview(rows.filter(o=>checked.includes(o.ref)))}>Review reminders{checked.length?` (${checked.length})`:''}</Button></div><p className="mt-2 text-xs leading-relaxed text-muted">{reminderMode==='disabled'?'Email reminders are unavailable until an SES sender is configured for this stage.':!ctx.profile?.paynow?.trim()?'Add PayNow instructions in Shop settings before sending reminders.':!drop||!['Live','Closed'].includes(drop.state)?'Reminders are available for live or ended drops.':reminderMode==='demo'?'Local demo: selections and sending results are simulated; no emails are sent.':'Select unpaid orders to review a personalized payment reminder. One email per order; once every 24 hours.'}</p></div>}
    {review&&review.length>0&&drop&&ctx.profile&&reminderMode!=='disabled'&&<PaymentReminderPanel key={review.map(o=>o.ref).join('/')} orders={review} profile={ctx.profile} drop={drop} mode={reminderMode} onSent={()=>{setChecked([]);setSelected(undefined);setRevision(n=>n+1);}} onClose={()=>setReview(undefined)}/>}
    {error&&<p role="alert" className="mt-3 text-sm text-danger">{error}</p>}{loading&&<p className="mt-3 text-sm text-muted">Loading orders…</p>}
    {!loading&&!rows.length&&!error&&<p className="mt-4 text-sm text-muted">No matching retained orders on this page.</p>}
    <div aria-hidden="true" className={cn('mt-6 hidden border-b border-line pb-2 text-[11px] font-bold tracking-wide text-muted uppercase sm:grid',columns,kind==='payments'&&'sm:pl-8')}><span>Order / customer</span><span className="text-right">Amount</span><span className="text-right">Status</span><span/></div>
    <div className="mt-1 divide-y divide-line">{rows.map(o=>{
      const t=trackingOf(o);const status=kind==='payments'?t.paymentStatus:t.fulfillmentStatus;
      const statusLabel=status==='unknown'?'Not recorded':status.replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
      return <div key={o.ref} className="flex items-center gap-4">{kind==='payments'&&<input type="checkbox" aria-label={`Select order ${o.ref} for a payment reminder`} title={drop?reminderProblem(o,drop):undefined} className="size-4 shrink-0 accent-ink" disabled={!canRemind||Boolean(drop&&reminderProblem(o,drop))||(!checked.includes(o.ref)&&checked.length>=REMINDER_BATCH_LIMIT)} checked={checked.includes(o.ref)} onChange={e=>setChecked(current=>e.target.checked?[...current,o.ref]:current.filter(ref=>ref!==o.ref))}/>}<button data-testid="tracking-worklist-row" className={cn('grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_1.25rem] items-center gap-x-3 gap-y-1.5 py-4 text-left',columns)} onClick={()=>setSelected(o)}>
        <span className="col-start-1 row-span-2 row-start-1 min-w-0 sm:row-span-1"><strong className="block truncate text-sm">{o.name}</strong><span className="mt-1 block text-xs leading-relaxed break-words text-muted">{o.ref} · {o.qty} × {o.variantName}</span>{kind==='payments'&&o.paymentReminder&&<span className="mt-1 block text-[11px] text-muted">Reminder: {o.paymentReminder.status==='accepted'?reminderMode==='demo'?'simulated':'accepted by SES':o.paymentReminder.status==='failed'?'not sent':'check sending outcome'} · {new Date(o.paymentReminder.attemptedAt).toLocaleString('en-SG',{timeZone:'Asia/Singapore'})} SGT</span>}</span>
        <strong data-column="amount" className="col-start-2 row-start-1 text-right text-sm whitespace-nowrap tabular-nums">{price(o.amountCents)}</strong>
        <span data-column="status" className={cn('col-start-2 row-start-2 justify-self-end rounded-full bg-sunken px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-muted sm:col-start-3 sm:row-start-1',['paid','collected','delivered'].includes(status)&&'bg-ok-tint text-ok',status==='awaiting'&&'bg-warn-tint text-warn',status==='exception'&&'bg-danger-tint text-danger')}>{statusLabel}</span>
        <ArrowUpRight aria-hidden="true" className="col-start-3 row-span-2 row-start-1 size-4 justify-self-end text-muted sm:col-start-4 sm:row-span-1"/>
      </button></div>;
    })}</div>
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!cursor} onClick={()=>setCursor(undefined)}>First page</Button><Button variant="outline" disabled={!next||loading} onClick={()=>setCursor(next)}>Next page</Button></div><div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={()=>setRevision(n=>n+1)}>Refresh orders</Button><Button variant="outline" disabled={!rows.length||loading} onClick={()=>download(trackingCsv(rows),kind==='payments'?'payment-worklist-page.csv':'pickup-delivery-worklist-page.csv')}><ArrowDownToLine className="size-4"/>Export this page</Button></div></div>
    <p className="mt-3 text-xs leading-relaxed text-muted">Filters apply to each page. Continue to the next page if no orders match. Exports include this page’s order and tracking references, without buyer names, emails or notes; downloaded files follow your shop’s retention policy.</p>
    {selected&&<OrderEditor onReminder={canRemind&&drop&&!reminderProblem(rows.find(o=>o.ref===selected.ref)??selected,drop)?()=>setReview([rows.find(o=>o.ref===selected.ref)??selected]):undefined} key={`${selected.ref}/${selected.version??0}`} order={selected} reminderMode={reminderMode} onClose={()=>setSelected(undefined)} onSave={o=>{setSelected(o);setRevision(n=>n+1);onSaved();}}/>}
  </Card>;
}

function OrderEditor({order,onClose,onSave,onReminder,reminderMode}:{reminderMode:'ses'|'disabled'|'demo';order:Order;onClose:()=>void;onSave:(o:Order)=>void;onReminder?:()=>void}) {
  const [tracking,setTracking]=useState<OrderTracking>(()=>trackingOf(order));const [reason,setReason]=useState('');const [saving,setSaving]=useState(false);const [error,setError]=useState('');const [history,setHistory]=useState<{rows:Array<{at:string;actor:string;reason:string;version:number;after:OrderTracking}>;partial:boolean;paymentReminders?:{rows:Array<PaymentReminder&{actor:string}>;partial:boolean}}>();
  const edit=(key:keyof OrderTracking,value:string)=>setTracking(t=>({...t,[key]:value}));
  useEffect(()=>{let active=true;api<NonNullable<typeof history>>(`/m/orders/${order.ref}/history?dropId=${encodeURIComponent(order.dropId)}`).then(r=>{if(active)setHistory(r);}).catch(()=>{if(active)setError('Order history could not load.');});return()=>{active=false;};},[order]);
  return <section className="mt-5 rounded-2xl border border-line bg-sunken p-4" aria-label={`Tracking for ${order.ref}`}><div className="flex justify-between gap-2"><div><h3 className="font-bold">Order {order.ref}</h3><p className="text-xs text-muted">{order.name} · {order.email}</p></div><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>
    {onReminder&&<Button className="mt-4" variant="outline" onClick={onReminder}>Review payment reminder</Button>}
    <form onSubmit={async e=>{e.preventDefault();setSaving(true);setError('');try{const {paymentRecordedAt:_,dispatchedAt:__,completedAt:___,...fields}=tracking;const patch={...fields,fulfillBy:tracking.fulfillBy??null};onSave(await api<Order>(`/m/orders/${order.ref}/tracking`,{method:'PATCH',body:{dropId:order.dropId,expectedVersion:order.version??0,requestId:crypto.randomUUID(),patch,reason}}));}catch(err){setError(message(err));}finally{setSaving(false);}}} className="mt-4 grid gap-3 sm:grid-cols-2">
      {([
        ['paymentStatus','Payment',['awaiting','paid','unknown']],['fulfillmentMethod','Pickup / shipping method',['unassigned','pickup','shipping']],['fulfillmentStatus','Pickup / delivery status',['unknown','not_started','ready','shipped','collected','delivered','exception']],['attendanceStatus','Attendance',['normal','no_show']],
      ] as Array<[keyof OrderTracking,string,string[]]>).map(([key,title,values])=><label key={key} className={label}>{title}<select className={field} value={tracking[key]??''} onChange={e=>edit(key,e.target.value)}>{values.map(v=><option key={v} value={v}>{v.replaceAll('_',' ')}</option>)}</select></label>)}
      {([['paymentMethod','Payment method'],['paymentReference','Payment reference'],['carrier','Carrier'],['trackingReference','Tracking reference']] as Array<[keyof OrderTracking,string]>).map(([key,title])=><label key={key} className={label}>{title}<input className={field} value={tracking[key]??''} maxLength={120} onChange={e=>edit(key,e.target.value)}/></label>)}
      <label className={label}>Pickup / delivery due<input type="datetime-local" className={field} value={tracking.fulfillBy?new Date(Date.parse(tracking.fulfillBy)-new Date(tracking.fulfillBy).getTimezoneOffset()*60000).toISOString().slice(0,16):''} onChange={e=>setTracking(t=>({...t,fulfillBy:e.target.value?new Date(e.target.value).toISOString():undefined}))}/></label>
      <label className={label}>Correction / unpaid dispatch reason<input className={field} value={reason} maxLength={300} onChange={e=>setReason(e.target.value)}/></label>
      <label className={cn(label,'sm:col-span-2')}>Merchant note<textarea className="rounded-xl border border-field bg-surface p-3 text-sm" value={tracking.note??''} maxLength={500} onChange={e=>edit('note',e.target.value)}/></label>
      <p className="text-xs text-muted sm:col-span-2">No shipping address is stored here. Delivery and payment statuses are your shop’s records; no bank or courier is contacted.</p>
      {error&&<p role="alert" className="text-sm text-danger sm:col-span-2">{error}</p>}<Button type="submit" variant="ink" disabled={saving}>{saving?'Saving…':'Save tracking'}</Button>
    </form>
    {history?.paymentReminders&&<div className="mt-4 text-xs"><h4 className="font-bold">Payment reminder history</h4>{history.paymentReminders.rows.length?<ul className="mt-2 space-y-2">{history.paymentReminders.rows.map((r,i)=><li key={i}>{new Date(r.attemptedAt).toLocaleString('en-SG',{timeZone:'Asia/Singapore'})} SGT · {r.status==='accepted'?reminderMode==='demo'?'Simulated only':'Accepted by SES':r.status==='failed'?'Not sent':'Sending outcome uncertain'} · actor {r.actor.slice(0,8)}</li>)}</ul>:<p className="mt-1 text-muted">No reminders attempted.</p>}{history.paymentReminders.partial&&<p className="mt-1 text-warn">Reminder history is limited to 100 attempts and may be incomplete.</p>}</div>}
    <details className="mt-4 text-sm" open><summary className="cursor-pointer font-bold">Change history</summary>{history?.rows.length?<ol className="mt-3 space-y-3">{history.rows.map(h=><li key={h.version} className="border-l-2 border-line pl-3"><strong className="text-xs">Version {h.version} · {new Date(h.at).toLocaleString('en-SG',{timeZone:'Asia/Singapore'})} SGT</strong><p className="text-xs text-muted">Payment: {h.after.paymentStatus} · pickup / delivery: {h.after.fulfillmentStatus.replaceAll('_',' ')} · actor {h.actor.slice(0,8)}</p>{h.reason&&<p className="mt-1 text-xs">{h.reason}</p>}</li>)}</ol>:<p className="mt-2 text-xs text-muted">{history?'No recorded changes yet.':'Loading history…'}</p>}{history?.partial&&<p className="text-xs text-warn">History is limited to 100 records and may be incomplete.</p>}</details>
  </section>;
}
