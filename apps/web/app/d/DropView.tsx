'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicDrop, PublicState } from '@dropdeck/shared';
import { SearchX } from 'lucide-react';
import { useDocumentBrand } from '../../components/brand';
import { Skeleton } from '../../components/ui/skeleton';
import { time } from '../../lib/format';
import { Buyer, Ended } from './Buyer';
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
  useDocumentBrand(drop?.merchant);

  useEffect(() => {
    if (!ids) return;
    fetch(`/d/${ids.t}/${ids.d}/drop.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Check the link with the shop. It may have been mistyped, or the drop is not scheduled yet.'))))
      .then((d: PublicDrop) => {
        setDrop(d);
        document.title = `${d.title} · ${d.merchant.name}`;
      })
      .catch((e: Error) => setError(e.message));
  }, [ids]);

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
    const tick = async () => {
      clearTimeout(timer);
      try {
        const sentAt = Date.now();
        const r = await fetch(`/d/${ids.t}/${ids.d}/state.json`);
        const receivedAt = Date.now();
        if (r.ok) {
          const s = (await r.json()) as PublicState;
          last = s;
          setState(s);
          // The Date + Age headers say when this copy was really served (a Scheduled drop's state.json is written
          // once and cached, so its serverTime is stale); without them (next dev) fall back to serverTime.
          clock.current.add(r.headers.get('date'), r.headers.get('age'), sentAt, receivedAt);
          setOffset(Math.round(clock.current.ready ? clock.current.offset() : Date.parse(s.serverTime) - receivedAt));
        }
      } catch { /* keep the last state */ }
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
  }, [ids]);

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
        <StateCard icon={<SearchX />} iconClass="bg-sunken text-muted" title="We couldn't find this drop">{error}</StateCard>
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

  if (phase === 'open') return <Buyer ids={ids} drop={drop} state={state} serverNow={serverNow} />;
  if (phase === 'closed' || phase === 'cancelled') return <Ended ids={ids} drop={drop} cancelled={phase === 'cancelled'} />;

  return (
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
