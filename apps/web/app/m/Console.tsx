'use client';

// Types only from @dropdeck/shared at runtime-sensitive spots: its index pulls in node:crypto via tokens.ts.
import type { Drop, MerchantProfile } from '@dropdeck/shared';
import { ArrowRight, LayoutGrid, LogOut, Shuffle, ShieldCheck, Store, CreditCard, User, Download } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { api, ApiRequestError } from '../../lib/api';
import { clearSession, getAccessToken, signedInEmail, signIn, signOut } from '../../lib/auth';
import { brandStyle, initials } from '../../lib/brand';
import { message } from '../../lib/format';
import { cn } from '../../lib/utils';
import { DropEditor } from './DropEditor';
import { DropsList } from './DropsList';
import { OrdersView } from './OrdersView';
import { ShopSettings } from './ShopSettings';
import { ViewHeader, type ConsoleCtx, type Route } from './shared';
import { useAssetUrl } from '../../lib/assets';

function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const id = q.get('drop') ?? '';
  switch (q.get('view')) {
    case 'shop': return { view: 'shop' };
    case 'account': return { view: 'account' };
    case 'new': return { view: 'new' };
    case 'edit': return id ? { view: 'edit', id } : { view: 'drops' };
    case 'orders': return id ? { view: 'orders', id } : { view: 'drops' };
    default: return { view: 'drops' };
  }
}

function routeSearch(r: Route): string {
  if (r.view === 'drops') return '';
  const q = new URLSearchParams({ view: r.view });
  if ('id' in r) q.set('drop', r.id);
  return `?${q}`;
}

/** Console views live in the query string (?view=orders&drop=…): one static page, and the back button works. */
function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>({ view: 'drops' });
  useEffect(() => {
    setRoute(parseRoute(window.location.search));
    const onPop = () => setRoute(parseRoute(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((r: Route) => {
    window.history.pushState(null, '', `/m/${routeSearch(r)}`);
    setRoute(r);
    window.scrollTo({ top: 0 });
  }, []);
  return [route, go];
}

export const Mark = ({ className }: { className?: string }) => (
  <span className={cn('flex size-[30px] items-center justify-center rounded-[9px] bg-volt text-[#101114]', className)}>
    <Download className="size-[18px]" strokeWidth={2.6} />
  </span>
);

export default function Console() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    getAccessToken().then((t) => {
      setSignedIn(Boolean(t));
      setReady(true);
    });
  }, []);

  if (!ready) return <div className="mx-auto flex max-w-md flex-col gap-3 p-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (!signedIn) return <Welcome />;
  return <SignedIn />;
}

function Welcome() {
  const feats: Array<[ReactNode, string, string]> = [
    [<Shuffle key="s" />, 'Random draw', 'Fast fingers and refresh bots don’t win.'],
    [<ShieldCheck key="sh" />, 'Never oversells', 'Stock is held while people check out.'],
    [<CreditCard key="c" />, 'Paid by PayNow', 'Track paid and no-shows, export to CSV.'],
  ];
  return (
    <div className="dark flex min-h-dvh flex-col bg-[#101114] text-[#f3f3f5]">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <header className="flex h-16 items-center gap-2.5"><Mark /><span className="font-display text-xl font-extrabold tracking-tight">dropdeck</span></header>
        <main className="flex flex-1 flex-col gap-8 pt-9">
          <div className="flex flex-col gap-3.5">
            <span className="text-[13px] font-bold tracking-[0.1em] text-volt uppercase">For small shops</span>
            <h1 className="font-display text-[44px] leading-[0.98] font-extrabold tracking-[-0.03em]">Sell out fairly. No bots, no overselling.</h1>
            <p className="text-base leading-relaxed text-[#a1a5ae]">Run a limited drop from your phone. Buyers get a random place in line, and you never sell more than you have.</p>
          </div>
          <div className="flex flex-col gap-[18px]">
            {feats.map(([icon, title, text]) => (
              <div key={title} className="flex items-start gap-3.5">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-volt/12 text-volt [&_svg]:size-5">{icon}</span>
                <span className="flex flex-col gap-0.5"><strong className="text-base">{title}</strong><span className="text-sm text-[#a1a5ae]">{text}</span></span>
              </div>
            ))}
          </div>
        </main>
        <Button variant="volt" size="lg" className="mt-8 w-full font-extrabold" onClick={() => signIn().catch((e) => toast.error(message(e)))}>
          Sign in or create an account<ArrowRight strokeWidth={2.4} />
        </Button>
      </div>
    </div>
  );
}

function ShopChip({ profile }: { profile: MerchantProfile | null }) {
  const logo = useAssetUrl(profile?.logoUrl);
  const name = profile?.name ?? 'Your shop';
  return logo
    ? <img src={logo} alt="" className="size-9 shrink-0 rounded-[10px] object-cover" />
    : <span style={brandStyle(profile?.colour, false)} className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand font-display text-[13px] font-extrabold text-brand-fg">{initials(name)}</span>;
}

const NAV: Array<{ view: 'drops' | 'shop' | 'account'; label: string; icon: ReactNode }> = [
  { view: 'drops', label: 'Drops', icon: <LayoutGrid /> },
  { view: 'shop', label: 'Shop', icon: <Store /> },
  { view: 'account', label: 'Account', icon: <User /> },
];

const section = (r: Route): 'drops' | 'shop' | 'account' => (r.view === 'shop' || r.view === 'account' ? r.view : 'drops');

function SignedIn() {
  const [route, go] = useRoute();
  const [profile, setProfile] = useState<MerchantProfile | null | undefined>(undefined);
  const [drops, setDrops] = useState<Drop[] | null>(null);

  const onError = useCallback((e: unknown) => {
    if (e instanceof ApiRequestError && e.status === 401) {
      clearSession(); // otherwise a token the API rejects (not just an expired one) reloads forever
      window.location.reload();
      return;
    }
    toast.error(message(e));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api<MerchantProfile | null>('/m/profile'), api<Drop[]>('/m/drops')]);
      setProfile(p);
      setDrops(d);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  // A new merchant sets up their shop first.
  const view: Route = profile === null && route.view !== 'account' ? { view: 'shop' } : route;
  const ctx: ConsoleCtx = { profile: profile ?? null, drops, refresh, go, onError, setProfile };
  const current = section(view);
  const focused = view.view === 'new' || view.view === 'edit';

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-[260px] shrink-0 flex-col gap-6 bg-[#101114] px-4 py-5 text-[#f3f3f5] lg:flex">
        <div className="flex items-center gap-2.5 px-2"><Mark /><span className="font-display text-xl font-extrabold">dropdeck</span></div>
        <div className="flex items-center gap-2.5 rounded-[14px] bg-[#1a1c21] p-2.5">
          <ShopChip profile={profile ?? null} />
          <span className="flex min-w-0 flex-col"><strong className="truncate text-sm">{profile?.name ?? 'Your shop'}</strong><span className="truncate text-xs text-[#a1a5ae]">{signedInEmail()}</span></span>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAV.map((n) => (
            <a
              key={n.view}
              href={`/m/${routeSearch({ view: n.view })}`}
              onClick={(e) => { e.preventDefault(); go({ view: n.view }); }}
              aria-current={current === n.view ? 'page' : undefined}
              className={cn('flex h-11 items-center gap-2.5 rounded-xl px-3 text-[15px] font-bold text-[#a1a5ae] no-underline [&_svg]:size-[18px]', current === n.view && 'bg-[#22242a] text-white')}
            >
              {n.icon}{n.label}
            </a>
          ))}
        </nav>
        <Button variant="ghost" className="mt-auto justify-start text-[#a1a5ae] hover:bg-[#22242a] hover:text-white" onClick={() => void signOut()}><LogOut />Sign out</Button>
      </aside>

      <div className={cn('min-w-0 flex-1', !focused && 'pb-[96px] lg:pb-0')}>
        <div className="mx-auto w-full max-w-[1120px]">
          {profile === undefined ? (
            <div className="flex flex-col gap-3 p-4 lg:p-8"><Skeleton className="h-10 w-40" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
          ) : view.view === 'drops' ? <DropsList ctx={ctx} />
            : view.view === 'new' ? <DropEditor ctx={ctx} />
            : view.view === 'edit' ? <DropEditor ctx={ctx} drop={drops?.find((d) => d.dropId === view.id)} loading={drops === null} />
            : view.view === 'orders' ? <OrdersView ctx={ctx} drop={drops?.find((d) => d.dropId === view.id)} loading={drops === null} />
            : view.view === 'shop' ? <ShopSettings ctx={ctx} />
            : <Account profile={profile} />}
        </div>
      </div>

      {!focused && (
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface px-2 pb-[max(1.1rem,env(safe-area-inset-bottom))] lg:hidden">
          {NAV.map((n) => (
            <a
              key={n.view}
              href={`/m/${routeSearch({ view: n.view })}`}
              onClick={(e) => { e.preventDefault(); go({ view: n.view }); }}
              aria-current={current === n.view ? 'page' : undefined}
              className={cn('flex flex-1 flex-col items-center gap-1 pt-2 text-[11px] font-bold text-muted no-underline', current === n.view && 'text-ink')}
            >
              <span className={cn('flex h-[30px] w-[52px] items-center justify-center rounded-full [&_svg]:size-5', current === n.view && 'bg-volt text-[#101114]')}>{n.icon}</span>
              {n.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

function Account({ profile }: { profile: MerchantProfile | null }) {
  return (
    <>
      <ViewHeader title="Account" />
      <div className="flex max-w-xl flex-col gap-3.5 px-4 lg:px-8">
        <Card className="flex items-center gap-3.5">
          <ShopChip profile={profile} />
          <span className="flex min-w-0 flex-col"><strong className="truncate">{profile?.name ?? 'Your shop'}</strong><span className="truncate text-sm text-muted">Signed in as {signedInEmail()}</span></span>
        </Card>
        {profile?.slugClaimed && (
          <Card className="flex flex-col gap-1">
            <span className="text-sm font-semibold">Your shop page</span>
            <a className="truncate text-sm font-semibold text-ink underline underline-offset-4" href={`/s/${profile.slug}/`} target="_blank" rel="noreferrer">{window.location.origin}/s/{profile.slug}/</a>
          </Card>
        )}
        <Button variant="danger" size="lg" className="w-full" onClick={() => void signOut()}><LogOut />Sign out</Button>
      </div>
    </>
  );
}
