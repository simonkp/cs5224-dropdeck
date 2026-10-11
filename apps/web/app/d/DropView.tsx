'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicDrop, PublicState } from '@dropdeck/shared';
import { SearchX } from 'lucide-react';
import { useDocumentBrand } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { time } from '../../lib/format';
import { Buyer, Ended } from './BuyerView';
import { ClockEstimate, loadSession, pollInterval, queueStatus } from './buyer';
import {
  CalendarButton, Content, CountdownCard, Footer, Hero, HowItWorks, Page, RuleChips, ShopHeader, StateCard, StatusPill, TitleBlock, VariantGrid,
} from './parts';

function useDropPath() {
  const [ids, setIds] = useState<{ t: string; d: string } | null>(null);
  useEffect(() => {
    const [, prefix, t, d] = window.location.pathname.split('/');
    if (prefix === 'd' && t && d) setIds({ t, d });
  }, []);
  return ids;
}

export default function DropView() {
  const ids = useDropPath();
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [offset, setOffset] = useState(0); // server clock minus device clock
  const clock = useRef(new ClockEstimate());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [stale, setStale] = useState(false);
  const [offline, setOffline] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update(); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  const withStatus = (content: ReactNode) => <>{(stale || offline) && <div role="status" className="relative z-30 flex flex-wrap items-center justify-center gap-2 bg-warn-tint px-4 py-2 text-sm text-warn"><span>{offline ? 'You are offline.' : 'Live updates are delayed.'} {lastUpdated ? `Last updated ${new Date(lastUpdated).toLocaleTimeString()}.` : 'Waiting for live status.'} Your place is saved on this device.</span><Button variant="outline" size="sm" onClick={() => setRetry(n => n+1)}>Retry</Button></div>}{content}</>;
  useDocumentBrand(drop?.merchant);

  useEffect(() => {
    if (!ids) return;
    setError(null);
    fetch(`/d/${ids.t}/${ids.d}/drop.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Check the link with the shop. It may have been mistyped, or the drop is not scheduled yet.'))))
      .then((d: PublicDrop) => {
        setDrop(d);
        document.title = `${d.title} · ${d.merchant.name}`;
      })
      .catch((e: Error) => setError(e.message));
  }, [ids, retry]);

  // Poll the cached state object at a FIXED URL. Never add a cache-busting query string:
  // the CloudFront cache is what keeps polling cost independent of crowd size. How often depends on what can
  // change for this buyer right now (pollInterval); a tab coming back into view polls at once.
  const dropRef = useRef<PublicDrop | null>(null);
  dropRef.current = drop;
  useEffect(() => {
    if (!ids) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: PublicState | null = null;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || stop) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        const sentAt = Date.now();
        const r = await fetch(`/d/${ids.t}/${ids.d}/state.json`);
        const receivedAt = Date.now();
        if (r.ok) {
          const s = (await r.json()) as PublicState;
          if (stop) return;
          setStale(false); setLastUpdated(Date.now());
          last = s;
          setState(s);
          // The Date + Age headers say when this copy was really served (a Scheduled drop's state.json is written
          // once and cached, so its serverTime is stale); without them (next dev) fall back to serverTime.
          clock.current.add(r.headers.get('date'), r.headers.get('age'), sentAt, receivedAt);
          setOffset(Math.round(clock.current.ready ? clock.current.offset() : Date.parse(s.serverTime) - receivedAt));
        } else if (!stop) setStale(true);
      } catch { if (!stop) setStale(true); }
      inFlight = false;
      if (stop) return;
      const session = loadSession(ids.t, ids.d);
      const now = Date.now() + (clock.current.ready ? clock.current.offset() : 0);
      const entry = dropRef.current ? Date.parse(dropRef.current.entryOpensAt) : now; // drop.json not loaded yet: poll fast
      timer = setTimeout(tick, pollInterval({
        now, entryOpensAt: entry, hidden: document.visibilityState === 'hidden', state: last,
        stage: session?.stage ?? null, ahead: session?.stage === 'queued' ? queueStatus(session, last).ahead : null,
      }));
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ids, retry]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const serverNow = now + offset;
  const phase = useMemo(() => {
    if (!drop) return 'loading';
    if (state?.state === 'Cancelled') return 'cancelled';
    if (state?.state === 'Closed') return 'closed';
    if (serverNow < Date.parse(drop.entryOpensAt)) return 'countdown';
    return 'open';
  }, [drop, state, serverNow]);

  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center p-4">
        <StateCard icon={<SearchX />} iconClass="bg-sunken text-muted" title="We couldn't find this drop">{error}<Button className="mt-4" variant="outline" onClick={() => setRetry(n => n+1)}>Try again</Button></StateCard>
      </main>
    );
  }
  if (!drop || !ids) {
    return (
      <div className="mx-auto flex max-w-[560px] flex-col gap-4 p-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-12" />
        <Skeleton className="h-[210px]" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (phase === 'open' || (phase === 'closed' && loadSession(ids.t, ids.d)?.stage === 'held')) return withStatus(<Buyer ids={ids} drop={drop} state={state} serverNow={serverNow} />);
  if (phase === 'closed' || phase === 'cancelled') return withStatus(<Ended ids={ids} drop={drop} cancelled={phase === 'cancelled'} />);

  return withStatus(
    <Page header={<ShopHeader drop={drop} />} bar={<CalendarButton drop={drop} />}>
      <Hero drop={drop} />
      <Content>
        <TitleBlock drop={drop} pill={<StatusPill>Queue opens {new Date(drop.entryOpensAt).toLocaleDateString(undefined, { weekday: 'short' })} {time(drop.entryOpensAt)}</StatusPill>} />
        <CountdownCard drop={drop} msLeft={Date.parse(drop.entryOpensAt) - serverNow} />
        <RuleChips drop={drop} />
        <VariantGrid drop={drop} state={state} />
        <HowItWorks drop={drop} />
        <Footer />
      </Content>
    </Page>
  );
}
