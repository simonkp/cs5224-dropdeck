'use client';

import { useEffect, useMemo, useState } from 'react';
import type { PublicDrop, PublicState } from '@dropdeck/shared';

const POLL_MS = 2000;

function useDropPath() {
  const [ids, setIds] = useState<{ t: string; d: string } | null>(null);
  useEffect(() => {
    const [, prefix, t, d] = window.location.pathname.split('/');
    if (prefix === 'd' && t && d) setIds({ t, d });
  }, []);
  return ids;
}

const fmt = (ms: number) => {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

const price = (cents: number) => `S$${(cents / 100).toFixed(2)}`;

export default function DropView() {
  const ids = useDropPath();
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [offset, setOffset] = useState(0); // server clock minus device clock
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ids) return;
    fetch(`/d/${ids.t}/${ids.d}/drop.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('This drop does not exist or is not scheduled yet.'))))
      .then(setDrop)
      .catch((e: Error) => setError(e.message));
  }, [ids]);

  // Poll the cached state object at a FIXED URL. Never add a cache-busting query string:
  // the CloudFront cache is what keeps polling cost independent of crowd size.
  useEffect(() => {
    if (!ids) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/d/${ids.t}/${ids.d}/state.json`);
        if (r.ok) {
          const s = (await r.json()) as PublicState;
          setState(s);
          setOffset(Date.parse(s.serverTime) - Date.now());
        }
      } catch { /* keep the last state */ }
      if (!stop) setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { stop = true; };
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

  if (error) return <main><h1>Drop not found</h1><p className="muted">{error}</p></main>;
  if (!drop) return <main><p className="muted">Loading…</p></main>;

  return (
    <main>
      <p className="muted">{drop.merchant.name}</p>
      <h1>{drop.title}</h1>
      {drop.description && <p>{drop.description}</p>}

      <div className="card">
        {phase === 'countdown' && (
          <>
            <div className="muted">Queue opens in</div>
            <div className="big">{fmt(Date.parse(drop.entryOpensAt) - serverNow)}</div>
            <div className="muted">Everyone who joins before {new Date(drop.openAt).toLocaleTimeString()} gets a random place, so there is no need to refresh at the exact second.</div>
          </>
        )}
        {phase === 'open' && (
          <>
            <button disabled>Join the queue</button>
            <p className="muted">Joining arrives in week 2 (ticket, waiting room, claim).</p>
          </>
        )}
        {phase === 'closed' && <p>This drop has ended.</p>}
        {phase === 'cancelled' && <p>This drop was cancelled by the merchant.</p>}
      </div>

      <ul className="variants">
        {drop.variants.map((v) => (
          <li key={v.id}>
            <span>{v.name}{state?.soldOut?.[v.id] ? ' · sold out' : ''}</span>
            <span>{price(v.priceCents)}</span>
          </li>
        ))}
      </ul>
      <p className="muted">Limit {drop.perBuyerLimit} per buyer · held for {Math.round(drop.holdSec / 60)} min once claimed{drop.verification === 'email' ? ' · email code at checkout' : ''}</p>
    </main>
  );
}
