'use client';

import type { Drop, Order, OrderStatus } from '@dropdeck/shared';
import { orderMatchesStatus, trackingOf } from '@dropdeck/shared/merchant-analytics';
import { Download, Upload } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { Card, SectionTitle } from '../../components/ui/card';
import { Segmented } from '../../components/ui/segmented';
import { Skeleton } from '../../components/ui/skeleton';
import { api, apiText } from '../../lib/api';
import { price } from '../../lib/format';
import { cn } from '../../lib/utils';
import { ShareSheet, type ShareTarget } from './ShareSheet';
import { absolute, dropUrl, StateBadge, ViewHeader, type ConsoleCtx } from './shared';

interface Live {
  state: Drop['state'];
  variants: Array<{ id: string; name: string; stock: number; out: number }>;
  activeHolds: number;
  orders: number;
  unitsOrdered: number;
  queue: { earlyCount: number | null; lateTickets: number };
}

interface Report {
  stock: number;
  orders: number;
  units: { ordered: number; paid: number; unpaid: number; noShow: number };
  revenueCents: { ordered: number; paid: number; outstanding: number };
  sellThrough: number;
  secondsToSellOut: number | null;
  byVariant: Array<{ id: string; name: string; stock: number; ordered: number; paid: number }>;
}

const STATUS: Array<{ value: OrderStatus; label: string; activeClass: string }> = [
  { value: 'confirmed', label: 'Awaiting', activeClass: 'bg-surface text-warn shadow-[0_1px_3px_rgba(16,17,20,0.12)]' },
  { value: 'paid', label: 'Paid', activeClass: 'bg-ok text-white' },
  { value: 'no-show', label: 'No-show', activeClass: 'bg-danger text-white' },
];
type Filter = 'all' | OrderStatus;

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[18px] border border-line bg-surface p-3.5">
      <span className="text-xs font-bold tracking-[0.05em] text-muted uppercase">{label}</span>
      <span className="tabular text-[28px] leading-[1.05] font-extrabold">{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </div>
  );
}

export function OrdersView({ ctx, drop, loading }: { ctx: ConsoleCtx; drop?: Drop; loading?: boolean }) {
  if (loading) return <div className="flex flex-col gap-3 p-4 lg:p-8"><Skeleton className="h-12" /><Skeleton className="h-40" /></div>;
  if (!drop) return <><ViewHeader title="Drop not found" back={() => ctx.go({ view: 'drops' })} /><p className="p-4 text-muted lg:px-8">It may have been deleted.</p></>;
  return <Orders key={drop.dropId} ctx={ctx} drop={drop} />;
}

function Orders({ ctx, drop }: { ctx: ConsoleCtx; drop: Drop }) {
  const { onError } = ctx;
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [saving, setSaving] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [share, setShare] = useState<ShareTarget | null>(null);
  const isLive = drop.state === 'Live';

  const load = useCallback(async () => {
    try {
      const [o, r, l] = await Promise.all([
        api<Order[]>(`/m/drops/${drop.dropId}/orders`),
        api<Report>(`/m/drops/${drop.dropId}/report`),
        drop.state === 'Live' ? api<Live>(`/m/drops/${drop.dropId}/live`) : Promise.resolve(null),
      ]);
      setOrders(o);
      setReport(r);
      setLive(l);
      setUpdatedAt(Date.now()); setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [drop]);

  useEffect(() => {
    void load();
    if (!isLive) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, [isLive, load]);

  const setStatus = async (o: Order, status: OrderStatus) => {
    if (o.status === status) return;
    setSaving(o.ref);
    setOrders((os) => os?.map((x) => (x.ref === o.ref ? { ...x, status } : x)) ?? null); // feels instant; rolled back on error
    try {
      const updated = await api<Order>(`/m/orders/${o.ref}`, { method: 'PATCH', body: { dropId: drop.dropId, status } });
      setOrders((os) => os?.map((x) => (x.ref === o.ref ? updated : x)) ?? null);
      setReport(await api<Report>(`/m/drops/${drop.dropId}/report`));
    } catch (e) {
      setOrders((os) => os?.map((x) => (x.ref === o.ref ? o : x)) ?? null);
      onError(e);
    } finally {
      setSaving(null);
    }
  };

  const download = async () => {
    try {
      const csv = await apiText(`/m/drops/${drop.dropId}/export.csv`);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${drop.title.replace(/[^\w-]+/g, '-').toLowerCase()}-orders.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(e);
    }
  };

  const shown = orders?.filter((o) => filter === 'all' || orderMatchesStatus(o,filter)) ?? null;
  const count = (f: Filter) => orders?.filter((o) => f === 'all' || orderMatchesStatus(o,f)).length ?? 0;
  const out = live?.variants.reduce((n, v) => n + v.out, 0) ?? 0;
  const stock = drop.variants.reduce((n, v) => n + v.stock, 0);

  return (
    <>
      {loadError && <div role="status" className="m-4 rounded-xl bg-warn-tint p-3 text-sm text-warn">Could not refresh orders. Last available values shown. <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div>}
      <ViewHeader
        title={drop.title}
        back={() => ctx.go({ view: 'drops' })}
        sub={<span className="flex items-center gap-2 lg:mt-1"><StateBadge state={drop.state} />{isLive && updatedAt && <span className="text-xs text-muted">Updated {Math.max(0, Math.round((now - updatedAt) / 1000))} s ago</span>}</span>}
        actions={drop.state !== 'Draft' && (
          <Button variant="outline" size="icon" aria-label="Share link" onClick={() => setShare({ title: drop.title, url: absolute(dropUrl(drop)), shopUrl: ctx.profile?.slugClaimed ? absolute(`/s/${ctx.profile.slug}/`) : undefined, shopName: ctx.profile?.name })}><Upload /></Button>
        )}
      />
      <div className="flex flex-col gap-4 px-4 pt-4 pb-8 lg:px-8">
        {isLive && (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            <Tile label="Reserved" value={<>{out}<span className="text-base text-muted"> / {stock}</span></>} sub="held or sold" />
            <Tile label="Tickets issued" value={live ? (live.queue.earlyCount ?? 0) + live.queue.lateTickets : '…'} sub={live?.queue.earlyCount === null ? "Draw not counted yet; late tickets only" : "Upper bound, including admitted buyers"} />
            <Tile label="Holds open" value={live?.activeHolds ?? '…'} sub="checking out now" />
            <Tile label="Orders" value={live?.orders ?? '…'} sub={live ? `${live.unitsOrdered} units` : undefined} />
          </div>
        )}
        {isLive && live && (
          <Card className="flex flex-col gap-3.5 rounded-[18px] p-4">
            <SectionTitle className="text-lg">Stock</SectionTitle>
            {live.variants.map((v) => (
              <div key={v.id} className="flex flex-col gap-1.5">
                <div className="flex justify-between text-sm font-bold"><span>{v.name}</span><span className="tabular">{v.out} / {v.stock} out</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-ink transition-[width] duration-700" style={{ width: `${(v.out / Math.max(1, v.stock)) * 100}%` }} /></div>
              </div>
            ))}
          </Card>
        )}

        {report && (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {!isLive && <Tile label="Orders" value={report.orders} sub={`${report.units.ordered} of ${report.stock} units (${Math.round(report.sellThrough * 100)}%)`} />}
            <Tile label="Paid" value={price(report.revenueCents.paid)} sub={`${report.units.paid} units`} />
            <Tile label="Awaiting" value={price(report.revenueCents.outstanding)} sub={`${report.units.unpaid} units`} />
            <Tile label="No-shows" value={report.units.noShow} sub="units" />
            {report.secondsToSellOut !== null && <Tile label="Sold out in" value={`${Math.floor(report.secondsToSellOut / 60)}m ${report.secondsToSellOut % 60}s`} sub="from opening" />}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <SectionTitle className="text-lg">Orders</SectionTitle>
            <Button variant="outline" onClick={() => void download()} disabled={!orders?.length}><Download />CSV</Button>
          </div>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0" role="tablist" aria-label="Filter orders">
            {([['all', 'All'], ['confirmed', 'Awaiting'], ['paid', 'Paid'], ['no-show', 'No-show']] as Array<[Filter, string]>).map(([f, label]) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={cn('h-9 shrink-0 cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] font-bold', filter === f && 'border-ink bg-ink text-bg')}>
                {label} {count(f)}
              </button>
            ))}
          </div>

          <p className="text-[13px] text-muted">Orders are kept for 180 days after the drop, then deleted with the buyers&apos; details. Download the CSV to keep them longer.</p>
          {!shown && <><Skeleton className="h-32" /><Skeleton className="h-32" /></>}
          {shown?.length === 0 && <p className="text-sm text-muted">{orders?.length ? 'No orders match this filter.' : 'No orders yet.'}</p>}

          <div className="grid gap-2.5 sm:grid-cols-2 lg:hidden">
            {shown?.map((o) => (
              <article key={o.ref} className="flex flex-col gap-2.5 rounded-[18px] border border-line bg-surface p-3.5">
                <div className="flex items-baseline justify-between"><span className="font-mono text-sm font-semibold tracking-wide">{o.ref}</span><span className="tabular font-extrabold">{price(o.amountCents)}</span></div>
                <div className="flex flex-col gap-0.5"><strong>{o.name}</strong><span className="truncate text-[13px] text-muted">{o.qty} × {o.variantName} · {o.email}</span></div>
                <Segmented label={`Order status for ${o.ref}`} value={o.status} disabled={saving === o.ref} onChange={(s) => void setStatus(o, s)} options={STATUS} className="rounded-xl" />
                {o.tracking&&<p className="text-xs text-muted">Payment: {trackingOf(o).paymentStatus==='unknown'?'not recorded':trackingOf(o).paymentStatus} · Attendance: {trackingOf(o).attendanceStatus==='no_show'?'no-show':'normal'}</p>}
              </article>
            ))}
          </div>

          {shown && shown.length > 0 && (
            <div className="hidden overflow-x-auto rounded-[20px] border border-line bg-surface lg:block">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs font-bold tracking-[0.05em] text-muted uppercase">
                    {['Ref', 'Buyer', 'Item', 'Amount', 'Status'].map((h) => <th key={h} className={cn('border-b border-line px-4 py-3', h === 'Amount' && 'text-right')}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((o) => (
                    <tr key={o.ref} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 font-mono font-semibold">{o.ref}</td>
                      <td className="px-4 py-3"><div className="font-bold">{o.name}</div><div className="text-xs text-muted">{o.email}</div></td>
                      <td className="px-4 py-3">{o.qty} × {o.variantName}</td>
                      <td className="tabular px-4 py-3 text-right font-bold">{price(o.amountCents)}</td>
                      <td className="w-[280px] px-4 py-3"><Segmented label={`Order status for ${o.ref}`} value={o.status} disabled={saving === o.ref} onChange={(s) => void setStatus(o, s)} options={STATUS} />{o.tracking&&<p className="mt-1 text-xs text-muted">Payment: {trackingOf(o).paymentStatus==='unknown'?'not recorded':trackingOf(o).paymentStatus} · Attendance: {trackingOf(o).attendanceStatus==='no_show'?'no-show':'normal'}</p>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <ShareSheet target={share} onClose={() => setShare(null)} />
    </>
  );
}
