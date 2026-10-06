'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicDrop, PublicState } from '@dropdeck/shared';
import { buyerApi, BuyerApiError, ClockEstimate, loadSession, queueStatus, saveSession, type BuyerSession, type Confirmation } from './buyer';

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
const fmtShort = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const price = (cents: number) => `S$${(cents / 100).toFixed(2)}`;

export default function DropView() {
  const ids = useDropPath();
  const [drop, setDrop] = useState<PublicDrop | null>(null);
  const [state, setState] = useState<PublicState | null>(null);
  const [offset, setOffset] = useState(0); // server clock minus device clock
  const clock = useRef(new ClockEstimate());
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
        const sentAt = Date.now();
        const r = await fetch(`/d/${ids.t}/${ids.d}/state.json`);
        const receivedAt = Date.now();
        if (r.ok) {
          const s = (await r.json()) as PublicState;
          setState(s);
          // The Date + Age headers say when this copy was really served (a Scheduled drop's state.json is written
          // once and cached, so its serverTime is stale); without them (next dev) fall back to serverTime.
          clock.current.add(r.headers.get('date'), r.headers.get('age'), sentAt, receivedAt);
          setOffset(Math.round(clock.current.ready ? clock.current.offset() : Date.parse(s.serverTime) - receivedAt));
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
  if (!drop || !ids) return <main><p className="muted">Loading…</p></main>;

  return (
    <main>
      <p className="muted">{drop.merchant.name}</p>
      <h1>{drop.title}</h1>
      {drop.imageUrl && <img className="hero" src={drop.imageUrl} alt="" />}
      {drop.description && <p>{drop.description}</p>}

      <div className="card">
        {phase === 'countdown' && (
          <>
            <div className="muted">Queue opens in</div>
            <div className="big">{fmt(Date.parse(drop.entryOpensAt) - serverNow)}</div>
            <div className="muted">Everyone who joins before {new Date(drop.openAt).toLocaleTimeString()} gets a random place, so there is no need to refresh at the exact second.</div>
          </>
        )}
        {phase === 'open' && <Buyer ids={ids} drop={drop} state={state} serverNow={serverNow} />}
        {phase === 'closed' && <Ended ids={ids} text="This drop has ended." />}
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

/** After the drop closes, a buyer who ordered still sees their confirmation. */
function Ended({ ids, text }: { ids: { t: string; d: string }; text: string }) {
  const s = loadSession(ids.t, ids.d);
  if (s?.stage === 'confirmed') return <Confirmed c={s.confirmation} />;
  return <p>{text}</p>;
}

function Buyer({ ids, drop, state, serverNow }: { ids: { t: string; d: string }; drop: PublicDrop; state: PublicState | null; serverNow: number }) {
  const [session, setSessionState] = useState<BuyerSession | null>(() => loadSession(ids.t, ids.d));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const setSession = useCallback((s: BuyerSession | null) => {
    saveSession(ids.t, ids.d, s);
    setSessionState(s);
  }, [ids]);

  const startOver = () => {
    setNotice(null);
    setSession(null);
  };

  const join = async () => {
    setBusy(true);
    setNotice(null);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await buyerApi<{ ticket: string; r?: number; n?: number }>(`/api/d/${ids.t}/${ids.d}/ticket`);
          setSession({ stage: 'queued', ticket: r.ticket, r: r.r, n: r.n });
          return;
        } catch (e) {
          // Tapped a moment before the queue opened on the server: wait as told and try again. The random extra
          // delay spreads a crowd of early taps instead of having them all retry in the same instant.
          if (!(e instanceof BuyerApiError && e.code === 'NOT_LIVE' && e.retryAfter && e.retryAfter <= 10 && attempt < 3)) throw e;
          await new Promise((res) => setTimeout(res, e.retryAfter! * 1000 + Math.random() * 1000));
        }
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const allReserved = drop.variants.every((v) => state?.soldOut?.[v.id]);
  const reservedNote = allReserved && (
    <p className="muted">Everything is reserved right now. Unpaid holds expire after {Math.round(drop.holdSec / 60)} min and go back to stock, so it is worth keeping your place.</p>
  );

  if (!session) {
    const live = state?.state === 'Live';
    return (
      <>
        {reservedNote}
        <button disabled={busy || !live} onClick={join}>{busy ? 'Joining…' : 'Join the queue'}</button>
        {!live && <p className="muted">Opening the queue…</p>}
        {live && Date.parse(drop.openAt) + 30_000 > serverNow && (
          <p className="muted">Join any time before {new Date(drop.openAt).toLocaleTimeString()}: places in the draw are random, not first-come.</p>
        )}
        {notice && <p className="error">{notice}</p>}
      </>
    );
  }
  if (session.stage === 'queued') {
    return <>{reservedNote}<Queued session={session} drop={drop} state={state} serverNow={serverNow} ids={ids} setSession={setSession} onStartOver={startOver} /></>;
  }
  if (session.stage === 'held') {
    return <Held session={session} drop={drop} serverNow={serverNow} setSession={setSession} onStartOver={startOver} />;
  }
  return <Confirmed c={session.confirmation} />;
}

function Queued(props: {
  session: Extract<BuyerSession, { stage: 'queued' }>;
  drop: PublicDrop;
  state: PublicState | null;
  serverNow: number;
  ids: { t: string; d: string };
  setSession: (s: BuyerSession | null) => void;
  onStartOver: () => void;
}) {
  const { session, drop, state, serverNow, ids } = props;
  const [variantId, setVariantId] = useState(() => drop.variants.find((v) => !state?.soldOut?.[v.id])?.id ?? drop.variants[0]!.id);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0);
  const [expired, setExpired] = useState(false);
  const status = queueStatus(session, state);
  const admitted = status.admitted && Date.now() >= retryAt;

  // Remember when this page first saw the turn arrive, to show how long is left to claim.
  const { setSession } = props;
  useEffect(() => {
    if (admitted && !session.admittedSeenAt) setSession({ ...session, admittedSeenAt: serverNow });
  }, [admitted, session, serverNow, setSession]);

  const claim = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await buyerApi<{ hold: string; holdId: string; expiresAt: string; variantId: string; qty: number }>(
        `/api/d/${ids.t}/${ids.d}/claim`,
        { body: { ticket: session.ticket, variantId, qty } },
      );
      setSession({ stage: 'held', ...r });
    } catch (e) {
      if (e instanceof BuyerApiError && e.code === 'NOT_ADMITTED') {
        setRetryAt(Date.now() + (e.retryAfter ?? 2) * 1000);
        setNotice('Almost your turn…');
      } else if (e instanceof BuyerApiError && e.code === 'ADMISSION_EXPIRED') {
        setExpired(true);
      } else {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <>
        <p>Your turn to claim has passed.</p>
        <button className="ghost" onClick={props.onStartOver}>Join again</button>
      </>
    );
  }

  if (!admitted) {
    const drawPending = session.r !== undefined && (state?.earlyCount ?? null) === null;
    return (
      <>
        <div className="muted">You’re in the queue</div>
        {drawPending ? (
          <p>You’re in the draw. Places are assigned when the drop opens at {new Date(drop.openAt).toLocaleTimeString()}; keep this page open.</p>
        ) : (
          <div className="big">{status.ahead === null ? '…' : `${status.ahead} ahead`}</div>
        )}
        <p className="muted">This page updates by itself. Refreshing will not move you forward or back.</p>
        {notice && <p className="muted">{notice}</p>}
      </>
    );
  }

  const deadline = (session.admittedSeenAt ?? serverNow) + drop.admitWindowSec * 1000;
  return (
    <>
      <div className="muted">It’s your turn · claim within {fmtShort(deadline - serverNow)}</div>
      <div className="form">
        <label>
          Choose
          <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            {drop.variants.map((v) => (
              <option key={v.id} value={v.id} disabled={state?.soldOut?.[v.id]}>
                {v.name} · {price(v.priceCents)}{state?.soldOut?.[v.id] ? ' (sold out)' : ''}
              </option>
            ))}
          </select>
        </label>
        {drop.perBuyerLimit > 1 && (
          <label>
            Quantity
            <select value={qty} onChange={(e) => setQty(Number(e.target.value))}>
              {Array.from({ length: drop.perBuyerLimit }, (_, i) => i + 1).map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
          </label>
        )}
      </div>
      <button disabled={busy} onClick={claim}>{busy ? 'Reserving…' : 'Reserve'}</button>
      {notice && <p className="error">{notice}</p>}
    </>
  );
}

function Held(props: {
  session: Extract<BuyerSession, { stage: 'held' }>;
  drop: PublicDrop;
  serverNow: number;
  setSession: (s: BuyerSession | null) => void;
  onStartOver: () => void;
}) {
  const { session, drop, serverNow } = props;
  const needsCode = drop.verification === 'email';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ to: string; at: number; resendAfterSec: number; devCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const left = Date.parse(session.expiresAt) - serverNow;
  const variant = drop.variants.find((v) => v.id === session.variantId);
  const holdPath = `/api/holds/${encodeURIComponent(session.holdId)}`;
  const resendIn = sent ? Math.ceil((sent.at + sent.resendAfterSec * 1000 - Date.now()) / 1000) : 0;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () => run(async () => {
    const r = await buyerApi<{ sentTo: string; resendAfterSec: number; devCode?: string }>(`${holdPath}/otp`, { token: session.hold, body: { email } });
    setSent({ to: r.sentTo, at: Date.now(), resendAfterSec: r.resendAfterSec, devCode: r.devCode });
  });

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (needsCode && !sent) return void sendCode();
    return void run(async () => {
      const c = await buyerApi<Confirmation>(`${holdPath}/confirm`, { token: session.hold, body: { name, email, ...(needsCode ? { code } : {}) } });
      props.setSession({ stage: 'confirmed', confirmation: c });
    });
  };

  if (left <= 0) {
    return (
      <>
        <p>Your hold expired and the item went back to stock.</p>
        <button className="ghost" onClick={props.onStartOver}>Join again</button>
      </>
    );
  }
  return (
    <form className="form" onSubmit={confirm}>
      <div className="muted">Reserved for you · {fmtShort(left)} left to check out</div>
      <p><strong>{session.qty} × {variant?.name}</strong> · {variant ? price(variant.priceCents * session.qty) : ''}</p>
      <label>Name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
      <label>
        Email
        <input required type="email" value={email} readOnly={Boolean(sent)} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </label>
      <small className="muted">One order per email for this drop. The merchant uses it to contact you about collection.</small>
      {needsCode && sent && (
        <>
          <p className="muted">We sent a 6-digit code to {sent.to}.</p>
          {sent.devCode && <p className="notice">Test mode, no email sent: your code is <strong>{sent.devCode}</strong></p>}
          <label>
            Code
            <input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
        </>
      )}
      <div className="actions">
        <button disabled={busy}>{busy ? 'Please wait…' : needsCode && !sent ? 'Send code' : 'Confirm order'}</button>
        {needsCode && sent && (
          <button type="button" className="ghost" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>
            {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
          </button>
        )}
      </div>
      {notice && <p className="error">{notice}</p>}
    </form>
  );
}

function Confirmed({ c }: { c: Confirmation }) {
  return (
    <>
      <div className="muted">Order confirmed</div>
      <div className="big">{c.orderRef}</div>
      <p>{c.qty} × {c.variantName} · <strong>{price(c.amountCents)}</strong></p>
      {c.merchant.paynow ? (
        <p>Pay <strong>{price(c.amountCents)}</strong> by PayNow to <strong>{c.merchant.paynow}</strong> with reference <strong>{c.orderRef}</strong>.</p>
      ) : (
        <p>{c.merchant.name} will contact you about payment.</p>
      )}
      {c.merchant.fulfilmentNote && <p className="muted">{c.merchant.fulfilmentNote}</p>}
      <p className="muted">Keep this page or note your reference. DropDeck never takes card details.</p>
    </>
  );
}
