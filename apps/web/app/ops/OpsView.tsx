'use client';

import type { Tier, Usage } from '@dropdeck/shared';
import { ChevronLeft, ChevronRight, ExternalLink, LogOut, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { api, ApiRequestError } from '../../lib/api';
import { clearSession, getAccessToken, signedInEmail, signedInGroups, signIn, signOut } from '../../lib/auth';
import { message } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Mark } from '../../components/mark';
import { BusinessAnalytics } from './BusinessAnalytics';
import { OperationsView } from './OperationsView';

// Browser-safe subpath (the package index pulls in node:crypto).
import { PLANS, TIERS } from '@dropdeck/shared/plans';

interface Row {
  tenantId: string;
  name: string;
  slug?: string;
  email?: string;
  tier: Tier;
  usage: Usage | null;
  invoice: { lines: Array<{ label: string; sgd: number }>; totalSgd: number };
  live: number;
  scheduled: number;
}
interface Overview {
  month: string;
  tenants: Row[];
  totals: { shops: number; liveNow: number; drops: number; sessions: number; orders: number; gmvCents: number; billedSgd: number };
}

const thisMonth = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const sgd = (n: number) => `S$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const money = (cents: number) => `S$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number | undefined) => (n ?? 0).toLocaleString();

export default function OpsView() {
  const [state, setState] = useState<'loading' | 'signedOut' | 'forbidden' | 'ready'>('loading');
  useEffect(() => {
    getAccessToken().then((t) => {
      if (!t) return setState('signedOut');
      setState(signedInGroups().includes('operators') ? 'ready' : 'forbidden');
    });
  }, []);

  return (
    <div className="min-h-dvh bg-bg">
      <header className="bg-[#101114] text-[#f3f3f5]">
        <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-4 lg:px-8">
          <span className="flex items-center gap-2.5"><Mark /><span className="font-display text-xl font-extrabold">dropdeck</span><span className="rounded-full bg-volt/15 px-2.5 py-0.5 text-xs font-bold text-volt">ops</span></span>
          {state !== 'signedOut' && state !== 'loading' && (
            <span className="flex items-center gap-3 text-sm text-[#a1a5ae]">
              <span className="hidden sm:inline">{signedInEmail()}</span>
              <Button variant="ghost" size="sm" className="text-[#a1a5ae] hover:bg-[#22242a] hover:text-white" onClick={() => void signOut()}><LogOut />Sign out</Button>
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-6 lg:px-8">
        {state === 'loading' && <Skeleton className="h-40" />}
        {state === 'signedOut' && (
          <Card className="mx-auto flex max-w-md flex-col gap-3 p-6">
            <h1 className="font-display text-2xl font-extrabold">DropDeck operators</h1>
            <p className="text-sm text-muted">Sign in with your DropDeck account. Only members of the operators group can use this page.</p>
            <Button variant="ink" size="lg" onClick={() => signIn('/ops/').catch((e) => toast.error(message(e)))}>Sign in</Button>
          </Card>
        )}
        {state === 'forbidden' && (
          <Card className="mx-auto flex max-w-md flex-col gap-3 p-6">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-warn-tint text-warn"><ShieldAlert className="size-6" /></span>
            <h1 className="font-display text-2xl font-extrabold">This page is for DropDeck operators</h1>
            <p className="text-sm text-muted">You are signed in as {signedInEmail()}, which is not in the operators group. Shops manage their drops in the <a className="font-semibold text-ink underline" href="/m/">merchant console</a>.</p>
          </Card>
        )}
        {state === 'ready' && <Workspace />}
      </main>
    </div>
  );
}

function Workspace() {
  const [view,setView]=useState<'shops'|'operations'>('shops');
  return <><nav aria-label="Operator views" className="mb-6 flex gap-2"><Button variant={view==='shops'?'ink':'outline'} onClick={()=>setView('shops')} aria-pressed={view==='shops'}>Shops & billing</Button><Button variant={view==='operations'?'ink':'outline'} onClick={()=>setView('operations')} aria-pressed={view==='operations'}>Operations</Button></nav>{view==='shops'?<Dashboard/>:<OperationsView/>}</>;
}

function Dashboard() {
  const [month, setMonth] = useState(thisMonth);
  const [data, setData] = useState<Overview | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [analyticsRevision, setAnalyticsRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>(`/admin/tenants?month=${month}`));
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) { clearSession(); window.location.reload(); return; }
      toast.error(message(e));
    }
  }, [month]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const setTier = async (row: Row, tier: Tier) => {
    setSaving(row.tenantId);
    try {
      await api(`/admin/tenants/${encodeURIComponent(row.tenantId)}`, { method: 'PATCH', body: { tier } });
      setAnalyticsRevision((revision) => revision + 1);
      toast.success(`${row.name} is now on ${PLANS[tier].label}`);
      await load();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setSaving(null);
    }
  };

  const t = data?.totals;
  const tiles: Array<[string, string]> = t ? [
    ['Shops', num(t.shops)], ['Live now', num(t.liveNow)], ['Drops', num(t.drops)], ['Buyer sessions', num(t.sessions)],
    ['Orders', num(t.orders)], ['Shop sales', money(t.gmvCents)], ['Billable (preview)', sgd(t.billedSgd)],
  ] : [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-3xl font-extrabold tracking-tight">Shops</h1>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface p-1" aria-label="Month">
          <Button variant="ghost" size="icon" className="size-9" aria-label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}><ChevronLeft /></Button>
          <span className="tabular w-20 text-center text-sm font-bold">{month}</span>
          <Button variant="ghost" size="icon" className="size-9" aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth((m) => shiftMonth(m, 1))}><ChevronRight /></Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        {data ? tiles.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 rounded-[18px] border border-line bg-surface p-3.5">
            <span className="text-xs font-bold tracking-[0.05em] text-muted uppercase">{label}</span>
            <span className="tabular text-2xl font-extrabold">{value}</span>
          </div>
        )) : Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-[76px]" />)}
      </div>
      <p className="text-[13px] text-muted">Usage is counted when each drop finishes. Billable is a preview from the plans (decision 0007); no payment is taken.</p>
      <BusinessAnalytics month={month} refreshVersion={analyticsRevision}/>

      {data && data.tenants.length === 0 && <Card><p className="text-sm text-muted">No shops yet.</p></Card>}
      {data && data.tenants.length > 0 && (
        <div className="overflow-x-auto rounded-[20px] border border-line bg-surface">
          <table className="w-full min-w-[920px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-bold tracking-[0.05em] text-muted uppercase">
                {['Shop', 'Plan', 'Drops', 'Sessions', 'Orders', 'Sales', 'Bill (preview)', 'Now'].map((h) => (
                  <th key={h} className={cn('border-b border-line px-4 py-3', !['Shop', 'Plan'].includes(h) && 'text-right')}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((r) => (
                <tr key={r.tenantId} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 font-bold">
                      {r.name}
                      {r.slug && <a href={`/s/${r.slug}/`} target="_blank" rel="noreferrer" aria-label={`Open ${r.name}'s shop page`} className="text-muted hover:text-ink"><ExternalLink className="size-3.5" /></a>}
                    </div>
                    <div className="text-xs text-muted">{r.email ?? 'no sign-in'} · <span className="font-mono">{r.tenantId.slice(0, 8)}</span></div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      aria-label={`Plan for ${r.name}`}
                      value={r.tier}
                      disabled={saving === r.tenantId}
                      onChange={(e) => void setTier(r, e.target.value as Tier)}
                      className="h-9 rounded-lg border border-field bg-surface px-2 font-semibold"
                    >
                      {TIERS.map((tier) => <option key={tier} value={tier}>{PLANS[tier].label}</option>)}
                    </select>
                  </td>
                  <td className="tabular px-4 py-3 text-right">{num(r.usage?.drops)}{r.usage?.cancelled ? <span className="text-muted"> +{r.usage.cancelled} cancelled</span> : null}</td>
                  <td className="tabular px-4 py-3 text-right">{num(r.usage?.sessions)}</td>
                  <td className="tabular px-4 py-3 text-right">{num(r.usage?.orders)}</td>
                  <td className="tabular px-4 py-3 text-right">{money(r.usage?.revenueCents ?? 0)}</td>
                  <td className="tabular px-4 py-3 text-right" title={r.invoice.lines.map((l) => `${l.label}: ${sgd(l.sgd)}`).join('\n')}>
                    <div className="font-bold">{sgd(r.invoice.totalSgd)}</div>
                    {r.invoice.lines.slice(1).map((l) => <div key={l.label} className="text-xs text-muted">{l.label}</div>)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs">
                    {r.live > 0 && <span className="mr-1 rounded-full bg-ok px-2 py-0.5 font-bold text-white">{r.live} live</span>}
                    {r.scheduled > 0 && <span className="text-muted">{r.scheduled} scheduled</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
