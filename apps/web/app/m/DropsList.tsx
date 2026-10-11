'use client';

import type { Drop } from '@dropdeck/shared';
import { Copy, ExternalLink, MoreHorizontal, Pencil, Plus, Trash2, Upload, XCircle, CalendarCheck, CalendarX } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ConfirmSheet } from '../../components/ui/dialog';
import { Skeleton } from '../../components/ui/skeleton';
import { api } from '../../lib/api';
import { day, dayTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Checklist } from './Checklist';
import { ShareSheet, type ShareTarget } from './ShareSheet';
import { absolute, dropUrl, entryOpened, StateBadge, ViewHeader, type ConsoleCtx } from './shared';

interface Summary { dropId: string; stock: number; reserved: number; orders: number; paidOrders: number; awaitingOrders: number; partial: boolean }

type Action = 'schedule' | 'unschedule' | 'cancel' | 'duplicate' | 'delete';
type Filter = 'all' | 'Live' | 'Scheduled' | 'Draft' | 'ended';

const FILTERS: Array<[Filter, string]> = [['all', 'All'], ['Live', 'Live'], ['Scheduled', 'Scheduled'], ['Draft', 'Drafts'], ['ended', 'Ended']];
const matches = (d: Drop, f: Filter) => f === 'all' || (f === 'ended' ? d.state === 'Closed' || d.state === 'Cancelled' : d.state === f);
/** Live first, then upcoming soonest first, drafts, then the rest newest first. */
const rank = (d: Drop) => ({ Live: 0, Scheduled: 1, Draft: 2, Closed: 3, Cancelled: 4 })[d.state];
const sortDrops = (ds: Drop[]) => [...ds].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.openAt.localeCompare(b.openAt) : b.openAt.localeCompare(a.openAt)));

function summary(d: Drop): string {
  const units = d.variants.reduce((n, v) => n + v.stock, 0);
  if (d.state === 'Draft') return `${units} units · not scheduled yet`;
  if (d.state === 'Scheduled') return `${dayTime(d.openAt)} · ${units} units`;
  if (d.state === 'Live') return `Ends ${dayTime(d.endAt)}`;
  return `${d.state === 'Cancelled' ? 'Cancelled' : 'Ended'} ${day(d.endAt)} · ${units} units`;
}

export function DropsList({ ctx }: { ctx: ConsoleCtx }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ drop: Drop; action: 'cancel' | 'delete' } | null>(null);
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [summaryError, setSummaryError] = useState(false);
  const [updated, setUpdated] = useState('');
  const ids = sortDrops(ctx.drops ?? []).filter(d => d.state !== 'Draft' && d.state !== 'Scheduled').slice(0,20).map(d => d.dropId).join(',');
  const loadSummary = useCallback(async () => {
    if (!ids) { setSummaries([]); return; }
    try {
      const r = await api<{ summaries: Summary[]; generatedAt: string }>(`/m/overview?ids=${encodeURIComponent(ids)}`);
      setSummaries(r.summaries); setUpdated(r.generatedAt); setSummaryError(false);
    } catch { setSummaryError(true); }
  }, [ids]);
  useEffect(() => { void loadSummary(); }, [loadSummary, ctx.drops]);
  const totals = summaries.reduce((n,s) => n+s.awaitingOrders,0);
  const partial = summaries.some(s => s.partial);
  const progress = (d: Drop) => {
    const s = summaries.find(s => s.dropId === d.dropId);
    if (!s) return <span className="text-sm text-muted">{d.variants.reduce((n,v) => n+v.stock,0)} units{d.state === 'Live' && ' · loading progress'}</span>;
    return <div className="flex min-w-[140px] flex-col gap-1.5"><span className="text-sm font-bold">{s.reserved}{s.partial && d.state !== 'Live' ? '+' : ''} / {s.stock} {d.state === 'Live' ? 'reserved' : 'ordered'}</span><div className="h-2 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-ok" style={{ width: `${Math.min(100,s.stock ? s.reserved/s.stock*100 : 0)}%` }} /></div><span className="text-xs text-muted">{s.paidOrders}{s.partial ? '+' : ''} paid · {s.awaitingOrders}{s.partial ? '+' : ''} awaiting payment</span></div>;
  };
  const shopUrl = ctx.profile?.slugClaimed ? absolute(`/s/${ctx.profile.slug}/`) : undefined;

  const act = async (d: Drop, action: Action) => {
    setBusy(d.dropId);
    try {
      if (action === 'delete') await api(`/m/drops/${d.dropId}`, { method: 'DELETE' });
      else await api(`/m/drops/${d.dropId}/${action}`, { method: 'POST' });
      toast.success({ schedule: 'Scheduled. Your link is ready to share.', unschedule: 'Moved back to drafts', cancel: 'Drop cancelled', duplicate: 'Copied as a new draft', delete: 'Draft deleted' }[action]);
      setConfirming(null);
      await ctx.refresh();
    } catch (e) {
      ctx.onError(e);
    } finally {
      setBusy(null);
    }
  };

  const openShare = (d: Drop) => setShare({ title: d.title, subtitle: d.state === 'Scheduled' ? day(d.openAt) : undefined, url: absolute(dropUrl(d)), shopUrl, shopName: ctx.profile?.name });

  const all = ctx.drops ? sortDrops(ctx.drops) : null;
  const shown = all?.filter((d) => matches(d, filter)) ?? null;
  const count = (f: Filter) => all?.filter((d) => matches(d, f)).length ?? 0;
  const newDrop = (
    <Button variant="volt" className="h-12 rounded-2xl px-5 text-[15px] font-extrabold" onClick={() => ctx.go({ view: 'new' })}><Plus strokeWidth={2.6} />New drop</Button>
  );

  return (
    <>
      <ViewHeader title="Drops" actions={<div className="hidden lg:block">{newDrop}</div>} />
      {/* Bottom room on phones so the last card scrolls clear of the floating New drop button. */}
      <div className="flex flex-col gap-3 px-4 pb-20 lg:px-8 lg:pb-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[[count('Live'), 'Live now'], [count('Scheduled'), 'Scheduled'], [updated ? `${totals}${partial ? '+' : ''}` : '—', 'Awaiting payment']].map(([value,label]) => <Card key={label} className="flex flex-col gap-2 p-4"><span className="text-xs font-bold tracking-wide text-muted uppercase">{label}</span><strong className="font-display text-3xl font-extrabold">{value}</strong></Card>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>{summaryError ? 'Progress could not refresh. Last available values shown.' : updated ? `Snapshot ${new Date(updated).toLocaleTimeString()} · up to 20 recent/live drops${partial ? ' · partial counts (500 orders per drop)' : ''}` : 'Progress loads for live and ended drops.'}</span><Button variant="ghost" size="sm" onClick={() => void loadSummary()}>Refresh progress</Button></div>
        {all && <Checklist profile={ctx.profile} drops={all} go={ctx.go} onShare={openShare} />}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:px-0" role="tablist" aria-label="Filter drops">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn('h-9 shrink-0 cursor-pointer rounded-full border border-line bg-surface px-3.5 text-[13px] font-bold', filter === f && 'border-ink bg-ink text-bg')}
            >
              {label}{f !== 'all' && count(f) > 0 ? ` ${count(f)}` : ''}
            </button>
          ))}
        </div>

        {!shown && <><Skeleton className="h-40" /><Skeleton className="h-40" /></>}
        {shown?.length === 0 && (
          <Card className="flex flex-col items-start gap-3 p-5">
            <h2 className="font-display text-xl font-bold">{filter === 'all' ? 'No drops yet' : 'Nothing here'}</h2>
            <p className="text-sm text-muted">{filter === 'all' ? 'Create a drop, then schedule it to get a link to share.' : 'No drops match this filter.'}</p>
            {filter === 'all' && newDrop}
          </Card>
        )}

        {/* Phones and tablets: cards. */}
        <div className="grid gap-3 sm:grid-cols-2 lg:hidden">
          {shown?.map((d) => <DropCard key={d.dropId} d={d} busy={busy === d.dropId} ctx={ctx} onAct={act} onConfirm={(action) => setConfirming({ drop: d, action })} onShare={() => openShare(d)} progress={progress(d)} />)}
        </div>

        {/* Desktop: a table. */}
        {shown && shown.length > 0 && (
          <div className="hidden overflow-x-auto rounded-[20px] border border-line bg-surface lg:block">
            <table className="w-full border-collapse text-[15px]">
              <thead>
                <tr className="text-left text-xs font-bold tracking-[0.05em] text-muted uppercase">
                  <th className="border-b border-line px-4 py-3">Drop</th><th className="border-b border-line px-4 py-3">Status</th>
                  <th className="border-b border-line px-4 py-3">When</th><th className="border-b border-line px-4 py-3">Progress</th><th className="border-b border-line px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.dropId} className="border-b border-line last:border-0">
                    <td className="px-4 py-3.5 font-bold">{d.title}</td>
                    <td className="px-4 py-3.5"><StateBadge state={d.state} /></td>
                    <td className="px-4 py-3.5 text-muted">{d.state === 'Draft' ? 'Not scheduled' : dayTime(d.openAt)}</td>
                    <td className="px-4 py-3.5 text-muted">{progress(d)}</td>
                    <td className="px-4 py-3.5"><div className="flex justify-end gap-2"><Actions d={d} busy={busy === d.dropId} ctx={ctx} onAct={act} onConfirm={(action) => setConfirming({ drop: d, action })} onShare={() => openShare(d)} /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="fixed right-4 bottom-[104px] z-30 lg:hidden">{newDrop}</div>
      <ShareSheet target={share} onClose={() => setShare(null)} />
      <ConfirmSheet
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming?.action === 'cancel' ? `Cancel “${confirming.drop.title}”?` : `Delete “${confirming?.drop.title}”?`}
        description={confirming?.action === 'cancel' ? 'New reservations stop and active holds are voided. Confirmed orders remain; contact those buyers about collection or any refund. This cannot be undone.' : 'The draft is removed for good.'}
        confirmLabel={confirming?.action === 'cancel' ? 'Cancel drop' : 'Delete draft'}
        danger
        busy={busy !== null}
        onConfirm={() => confirming && void act(confirming.drop, confirming.action)}
      />
    </>
  );
}

interface ItemProps {
  d: Drop;
  busy: boolean;
  ctx: ConsoleCtx;
  onAct: (d: Drop, a: Action) => Promise<void>;
  onConfirm: (a: 'cancel' | 'delete') => void;
  onShare: () => void;
  progress?: ReactNode;
}

function DropCard(p: ItemProps) {
  const { d } = p;
  return (
    <Card className={cn('flex flex-col gap-3 rounded-[20px] p-4', d.state === 'Live' && 'border-2 border-ok')}>
      <div className="flex items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display text-lg leading-tight font-bold">{d.title}</h2>
          <span className="text-[13px] text-muted">{summary(d)}</span>
          {d.state !== 'Live' && <span className="truncate text-[13px] text-muted">{d.variants.map((v) => v.name).join(', ')}</span>}
        </div>
        <StateBadge state={d.state} />
      </div>
      {p.progress}
      <div className="flex gap-2"><Actions {...p} stretch /></div>
    </Card>
  );
}

/** The main button for a drop's state, a share button where there is a link, and everything else in a menu. */
function Actions({ d, busy, ctx, onAct, onConfirm, onShare, stretch }: ItemProps & { stretch?: boolean }) {
  const editable = d.state === 'Draft' || (d.state === 'Scheduled' && !entryOpened(d));
  const grow = stretch ? 'flex-1' : '';
  let primary: ReactNode = null;
  if (d.state === 'Live') primary = <Button variant="ink" className={grow} onClick={() => ctx.go({ view: 'orders', id: d.dropId })}>Live view &amp; orders</Button>;
  else if (d.state === 'Draft') primary = <Button variant="ink" className={grow} disabled={busy} onClick={() => ctx.go({ view: 'edit', id: d.dropId })}>Finish & schedule</Button>;
  else if (d.state === 'Scheduled') primary = <Button variant="outline" className={grow} onClick={onShare}><Upload />Share</Button>;
  else primary = <Button variant="outline" className={grow} onClick={() => ctx.go({ view: 'orders', id: d.dropId })}>Orders &amp; report</Button>;

  const item = 'flex h-11 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-[15px] font-semibold outline-none data-[highlighted]:bg-sunken [&_svg]:size-[18px]';
  return (
    <>
      {primary}
      {editable && d.state !== 'Draft' && <Button variant="outline" className={grow} onClick={() => ctx.go({ view: 'edit', id: d.dropId })}>Edit</Button>}
      {d.state === 'Live' && <Button variant="outline" size="icon" aria-label="Share link" onClick={onShare}><Upload /></Button>}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button variant="outline" size="icon" aria-label={`More actions for ${d.title}`} disabled={busy}><MoreHorizontal /></Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-2xl border border-line bg-surface p-1.5 text-ink shadow-xl">
            {d.state !== 'Draft' && <DropdownMenu.Item className={item} onSelect={() => window.open(dropUrl(d), '_blank', 'noopener')}><ExternalLink />Open buyer page</DropdownMenu.Item>}
            {d.state === 'Draft' && <DropdownMenu.Item className={item} onSelect={() => ctx.go({ view: 'edit', id: d.dropId })}><Pencil />Edit</DropdownMenu.Item>}
            {d.state === 'Scheduled' && !entryOpened(d) && <DropdownMenu.Item className={item} onSelect={() => void onAct(d, 'unschedule')}><CalendarX />Unschedule</DropdownMenu.Item>}
            {d.state === 'Draft' && <DropdownMenu.Item className={item} onSelect={() => void onAct(d, 'schedule')}><CalendarCheck />Schedule</DropdownMenu.Item>}
            <DropdownMenu.Item className={item} onSelect={() => void onAct(d, 'duplicate')}><Copy />Duplicate</DropdownMenu.Item>
            {(d.state === 'Scheduled' || d.state === 'Live') && <DropdownMenu.Item className={cn(item, 'text-danger')} onSelect={() => onConfirm('cancel')}><XCircle />Cancel drop</DropdownMenu.Item>}
            {d.state === 'Draft' && <DropdownMenu.Item className={cn(item, 'text-danger')} onSelect={() => onConfirm('delete')}><Trash2 />Delete draft</DropdownMenu.Item>}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
