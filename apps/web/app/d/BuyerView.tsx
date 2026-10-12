'use client';

import type { PublicDrop, PublicState } from '@dropdeck/shared';
import confetti from 'canvas-confetti';
import { ArrowRight, Check, Clock, Copy, CreditCard, Lock, MapPin, Package, RefreshCw, TimerOff, XCircle, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BrandArt, ShopLogo } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Card, Eyebrow, SectionTitle } from '../../components/ui/card';
import { Field, Input } from '../../components/ui/input';
import { CodeInput } from '../../components/ui/otp';
import { Stepper } from '../../components/ui/stepper';
import { message, mmss, price, time } from '../../lib/format';
import { copyText } from '../../lib/share';
import { cn } from '../../lib/utils';
import {
  buyerApi, BuyerApiError, loadDetails, loadSession, queueStatus, saveDetails, saveSession,
  type BuyerDetails, type BuyerSession, type Confirmation,
} from './buyer';
import { CompactHeader, Footer, Page, ShopHeader, StateCard, StatusPill, TitleBlock } from './parts';

type Ids = { t: string; d: string };

const Spinner = () => <span aria-hidden className="size-[18px] animate-spin rounded-full border-[2.5px] border-current/35 border-t-current" />;

function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="text-sm font-semibold text-danger" role="alert">{children}</p> : null;
}

/** Buzz and flash the tab title when the turn arrives, in case the buyer is looking at another app or tab. */
function useTurnNudge(active: boolean) {
  useEffect(() => {
    if (!active) return;
    navigator.vibrate?.([200, 100, 200]);
    const original = document.title;
    let on = false;
    const id = setInterval(() => {
      if (!document.hidden) {
        document.title = original;
        return;
      }
      on = !on;
      document.title = on ? 'Your turn! Reserve now' : original;
    }, 1000);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [active]);
}

/** After the drop closes (or is cancelled), a buyer who ordered still sees their confirmation. */
export function Ended({ ids, drop, cancelled }: { ids: Ids; drop: PublicDrop; cancelled: boolean }) {
  const s = loadSession(ids.t, ids.d);
  if (s?.stage === 'confirmed') return <Confirmed c={s.confirmation} drop={drop} cancelled={cancelled} />;
  const shop = drop.merchant.slug && (
    <Button size="lg" variant={cancelled ? 'outline' : 'brand'} className="w-full" asChild>
      <a href={`/s/${drop.merchant.slug}/`}>{cancelled ? 'Back to the shop' : 'See upcoming drops'}</a>
    </Button>
  );
  return (
    <Page header={<ShopHeader drop={drop} />}>
      <main className="flex flex-col gap-4 p-4">
        {cancelled ? (
          <StateCard icon={<XCircle />} iconClass="bg-danger-tint text-danger" title="This drop was cancelled" action={shop}>
            {drop.merchant.name} cancelled “{drop.title}”. New reservations are closed. If you already confirmed an order, contact the shop about collection or any payment.
          </StateCard>
        ) : (
          <StateCard icon={<Package />} iconClass="bg-brand-tint text-brand-text" title="This drop has ended" action={shop}>
            Thanks for coming. “{drop.title}” is over; if you had ordered, your confirmation would show here.
          </StateCard>
        )}
        <Footer />
      </main>
    </Page>
  );
}

export function Buyer({ ids, drop, state, serverNow }: { ids: Ids; drop: PublicDrop; state: PublicState | null; serverNow: number }) {
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
      setNotice(message(e));
    } finally {
      setBusy(false);
    }
  };

  const allReserved = drop.variants.every((v) => state?.soldOut?.[v.id]);
  const reservedNote = allReserved && (
    <Card className="flex gap-3 border-warn/20 bg-warn-tint text-warn">
      <Clock className="mt-0.5 size-5 shrink-0" />
      <p className="text-sm leading-snug font-semibold">Everything is reserved right now. Unconfirmed reservations expire after {Math.round(drop.holdSec / 60)} min and go back to stock, so it is worth keeping your place.</p>
    </Card>
  );

  if (session?.stage === 'queued') {
    return <Queued session={session} drop={drop} state={state} serverNow={serverNow} ids={ids} setSession={setSession} onStartOver={startOver} reservedNote={reservedNote} />;
  }
  if (session?.stage === 'held') {
    return <Held session={session} drop={drop} serverNow={serverNow} setSession={setSession} onStartOver={startOver} />;
  }
  if (session?.stage === 'confirmed') return <Confirmed c={session.confirmation} drop={drop} fresh />;

  const live = state?.state === 'Live';
  const drawAt = Date.parse(drop.openAt);
  const opensAt = Date.parse(drop.entryOpensAt);
  const beforeDraw = serverNow < drawAt || state?.earlyCount === null;
  const progress = Math.min(1, Math.max(0, (serverNow - opensAt) / Math.max(1, drawAt - opensAt)));
  const bar = busy ? (
    <>
      <Button size="lg" className="w-full" aria-busy="true" disabled><Spinner />Joining…</Button>
      <p className="text-center text-[13px] text-muted">The queue is just opening. Trying again in a moment, no need to tap.</p>
    </>
  ) : (
    <>
      <ErrorText>{notice}</ErrorText>
      <Button size="lg" className="w-full" disabled={!live} onClick={() => void join()}>
        {live ? <>Join the queue<ArrowRight strokeWidth={2.4} /></> : <><Spinner />Opening the queue…</>}
      </Button>
    </>
  );

  return (
    <Page header={<ShopHeader drop={drop} />} bar={bar}>
      <main className="flex flex-col gap-4 px-4 pt-5">
        <TitleBlock drop={drop} pill={<StatusPill tone="live">Queue open</StatusPill>} />
        {reservedNote}
        <Card className="flex flex-col gap-4">
          {beforeDraw ? (
            <>
              <div className="flex items-end justify-between">
                <div className="flex flex-col gap-1.5">
                  <Eyebrow>Draw in</Eyebrow>
                  <span className="tabular text-[44px] leading-none font-extrabold tracking-tight">{mmss(drawAt - serverNow)}</span>
                </div>
                <span className="text-right text-[13px] text-muted">at {time(drop.openAt)}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="h-2 overflow-hidden rounded-full bg-brand-tint">
                  <div className="h-full rounded-full bg-brand transition-[width] duration-1000" style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="flex justify-between text-xs font-semibold text-muted"><span>{time(drop.entryOpensAt)} queue opens</span><span>{time(drop.openAt)} draw</span></div>
              </div>
              <p className="text-sm leading-relaxed text-muted">Everyone who joins before {time(drop.openAt)} gets a random place. Joining early doesn&apos;t help, and you&apos;re not late.</p>
            </>
          ) : (
            <>
              <Eyebrow>The draw has happened</Eyebrow>
              <p className="text-sm leading-relaxed text-muted">Join now for a place after everyone in the draw. Unconfirmed reservations can return to stock, so there is still a chance.</p>
            </>
          )}
        </Card>
        <section className="flex flex-col gap-2.5">
          <SectionTitle className="mt-1">In this drop</SectionTitle>
          <Card className="px-4 py-1.5">
            {drop.variants.map((v, i) => (
              <div key={v.id} className={cn('flex items-center justify-between py-3', i > 0 && 'border-t border-line')}>
                <span className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-brand-tint text-brand-text"><Package className="size-5" /></span>
                  <span className="font-bold">{v.name}{state?.soldOut?.[v.id] && <span className="ml-2 text-xs font-semibold text-muted">reserved</span>}</span>
                </span>
                <span className="tabular font-semibold">{price(v.priceCents)}</span>
              </div>
            ))}
          </Card>
          <p className="text-[13px] text-muted">
            Limit {drop.perBuyerLimit} each · held {Math.round(drop.holdSec / 60)} min once reserved{drop.verification === 'email' ? ' · email code at checkout' : ''}
          </p>
        </section>
      </main>
    </Page>
  );
}

function Queued(props: {
  session: Extract<BuyerSession, { stage: 'queued' }>;
  drop: PublicDrop;
  state: PublicState | null;
  serverNow: number;
  ids: Ids;
  setSession: (s: BuyerSession | null) => void;
  onStartOver: () => void;
  reservedNote: ReactNode;
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
  // The first "N ahead" this page saw, so the progress bar can show how far the line has moved.
  const firstAhead = useRef<number | null>(null);
  if (firstAhead.current === null && status.ahead !== null && status.ahead > 0) firstAhead.current = status.ahead;
  useTurnNudge(admitted);

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
        setNotice(message(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (expired) {
    return (
      <Page header={<CompactHeader drop={drop} />}>
        <main className="p-4">
          <StateCard icon={<TimerOff />} iconClass="bg-warn-tint text-warn" title="Your turn to reserve has passed" action={<Button size="lg" variant="outline" className="w-full" onClick={props.onStartOver}>Join again</Button>}>
            Turns are held for {mmss(drop.admitWindowSec * 1000)} so the line keeps moving. You can join again for a new place.
          </StateCard>
        </main>
      </Page>
    );
  }

  if (!admitted) {
    const drawPending = session.r !== undefined && (state?.earlyCount ?? null) === null;
    const moved = firstAhead.current && status.ahead !== null ? 1 - status.ahead / firstAhead.current : 0;
    return (
      <Page header={<CompactHeader drop={drop} />}>
        <main className="flex flex-col gap-4 px-4 pt-5 pb-10">
          {props.reservedNote}
          <Card className="overflow-hidden p-0">
            <div className="flex flex-col gap-3.5 bg-brand px-5 pt-[22px] pb-5 text-brand-fg">
              {drawPending ? (
                <>
                  <span className="text-[13px] font-bold tracking-[0.06em] uppercase opacity-85">You&apos;re in the draw</span>
                  <span className="font-display text-[34px] leading-[1.05] font-extrabold tracking-tight">Places are drawn at {time(drop.openAt)}</span>
                  <span className="text-[15px] font-semibold opacity-90">Keep this page open. Everyone in the draw has the same chance.</span>
                </>
              ) : (
                <>
                  <span className="text-[13px] font-bold tracking-[0.06em] uppercase opacity-85">You&apos;re in line</span>
                  <div className="flex items-baseline gap-2.5" aria-live="polite">
                    <span className="tabular font-display text-[72px] leading-[0.9] font-extrabold tracking-[-0.03em]">{status.ahead ?? '…'}</span>
                    <span className="text-[17px] leading-tight font-semibold">{status.ahead === 1 ? 'person' : 'people'}<br />ahead of you</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-brand-fg/25">
                    <div className="h-full rounded-full bg-brand-fg transition-[width] duration-1000" style={{ width: `${Math.max(4, moved * 100)}%` }} />
                  </div>
                </>
              )}
            </div>
            <div aria-hidden className="mx-[18px] border-t-2 border-dashed border-line" />
            <div className="flex flex-col gap-1.5 px-5 pt-4 pb-[18px] text-sm leading-relaxed text-muted">
              <span className="flex items-center gap-2 font-semibold text-ink"><RefreshCw className="size-[18px]" />This page updates by itself</span>
              Refreshing won&apos;t move you forward or back. When it&apos;s your turn you&apos;ll have {mmss(drop.admitWindowSec * 1000)} to reserve.
              {notice && <span className="font-semibold text-ink">{notice}</span>}
            </div>
          </Card>
          <DetailsWhileWaiting />
          <Card className="flex items-center gap-3 px-4 py-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand-text"><Package className="size-5" /></span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-bold">{drop.variants.map((v) => v.name).join(' · ')}</span>
              <span className="text-[13px] text-muted">From {price(Math.min(...drop.variants.map((v) => v.priceCents)))} · limit {drop.perBuyerLimit} each</span>
            </span>
          </Card>
        </main>
      </Page>
    );
  }

  const deadline = (session.admittedSeenAt ?? serverNow) + drop.admitWindowSec * 1000;
  const left = deadline - serverNow;
  const picked = drop.variants.find((v) => v.id === variantId) ?? drop.variants[0]!;
  const ring = 2 * Math.PI * 36;
  return (
    <Page
      header={<CompactHeader drop={drop} />}
      bar={(
        <>
          <ErrorText>{notice && notice !== 'Almost your turn…' ? notice : null}</ErrorText>
          <div className="flex justify-between text-[15px]"><span className="text-muted">Total</span><span className="tabular font-extrabold">{price(picked.priceCents * qty)}</span></div>
          <Button size="lg" className="w-full" disabled={busy || state?.soldOut?.[variantId]} onClick={() => void claim()}>
            {busy ? <><Spinner />Reserving…</> : notice === 'Almost your turn…' ? 'Almost your turn…' : left <= 0 ? 'Check reservation availability' : `Reserve ${qty} × ${picked.name}`}
          </Button>
        </>
      )}
    >
      <main className="flex flex-col gap-[18px] px-4 pt-5">
        <section className="flex items-center gap-4">
          <div className="relative size-[84px] shrink-0">
            <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden className="-rotate-90">
              <circle cx="42" cy="42" r="36" fill="none" strokeWidth="8" className="stroke-brand-tint" />
              <circle cx="42" cy="42" r="36" fill="none" strokeWidth="8" strokeLinecap="round" className="stroke-brand transition-[stroke-dashoffset] duration-300"
                strokeDasharray={ring} strokeDashoffset={ring * (1 - Math.max(0, Math.min(1, left / (drop.admitWindowSec * 1000))))} />
            </svg>
            <span className="tabular absolute inset-0 flex items-center justify-center text-lg font-extrabold" role="timer" aria-label={`About ${mmss(left)} left to reserve`}>{mmss(left)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-[30px] leading-[1.02] font-extrabold tracking-[-0.025em]">It&apos;s your turn</h1>
            <p className="text-sm leading-snug text-muted">Pick what you&apos;d like and reserve it before the timer runs out.</p>
          </div>
        </section>

        <section className="flex flex-col gap-2.5" role="radiogroup" aria-label="Choose an item">
          <Eyebrow>Choose</Eyebrow>
          {drop.variants.map((v) => {
            const on = v.id === variantId;
            const gone = state?.soldOut?.[v.id];
            return (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={gone}
                onClick={() => setVariantId(v.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-3 rounded-[20px] border-2 bg-surface p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50',
                  on ? 'border-brand-text' : 'border-line',
                )}
              >
                <span className="flex size-14 shrink-0 items-center justify-center rounded-[14px] bg-brand-tint text-brand-text"><Package className="size-6" /></span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-base font-bold">{v.name}</span>
                  <span className="tabular text-sm text-muted">{gone ? 'All reserved' : price(v.priceCents)}</span>
                </span>
                <span className={cn('flex size-6 items-center justify-center rounded-full border-2', on ? 'border-brand-text' : 'border-field')}>
                  {on && <span className="size-2.5 rounded-full bg-brand-text" />}
                </span>
              </button>
            );
          })}
        </section>

        {drop.perBuyerLimit > 1 && (
          <Card className="flex items-center justify-between py-3 pr-3 pl-[18px]">
            <span className="flex flex-col gap-0.5"><span className="font-bold">Quantity</span><span className="text-[13px] text-muted">Up to {drop.perBuyerLimit} per buyer</span></span>
            <Stepper value={qty} min={1} max={drop.perBuyerLimit} onChange={setQty} label="Quantity" />
          </Card>
        )}
      </main>
    </Page>
  );
}

/** Optional: fill checkout in while waiting. Saved in this browser only; sent nowhere until an order is confirmed. */
function DetailsWhileWaiting() {
  const [d, setD] = useState<BuyerDetails>(() => loadDetails());
  const update = (patch: Partial<BuyerDetails>) => setD((cur) => {
    const next = { ...cur, ...patch };
    saveDetails(next);
    return next;
  });
  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-tint text-brand-text"><Zap className="size-5" /></span>
        <div className="flex flex-col gap-0.5">
          <h2 className="font-display text-lg leading-tight font-bold">While you wait <span className="font-sans text-sm font-medium text-muted">(optional)</span></h2>
          <p className="text-sm leading-snug text-muted">Add your details now and checkout is one tap when your turn comes.</p>
        </div>
      </div>
      <Field label="Name"><Input maxLength={80} value={d.name} onChange={(e) => update({ name: e.target.value })} autoComplete="name" /></Field>
      <Field label="Email"><Input type="email" value={d.email} onChange={(e) => update({ email: e.target.value })} autoComplete="email" /></Field>
      <div className="flex items-start gap-2.5 rounded-[14px] bg-bg p-3 text-[13px] leading-snug text-muted">
        <Lock className="mt-0.5 size-4 shrink-0" />
        <span>
          Kept only in this browser, for this drop and your next ones. Nothing is sent until you order.{' '}
          {(d.name || d.email) && <button type="button" className="cursor-pointer font-semibold text-brand-text underline underline-offset-2" onClick={() => update({ name: '', email: '' })}>Forget my details</button>}
        </span>
      </div>
    </Card>
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
  // Pre-filled from what the buyer typed while waiting; edits here are remembered the same way.
  const [prefilled] = useState(() => Boolean(loadDetails().name || loadDetails().email));
  const [name, setNameState] = useState(() => loadDetails().name);
  const [email, setEmailState] = useState(() => loadDetails().email);
  const setName = (v: string) => { setNameState(v); saveDetails({ name: v, email }); };
  const setEmail = (v: string) => { setEmailState(v); saveDetails({ name, email: v }); };
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<{ to: string; at: number; resendAfterSec: number; sendsLeft: number; devCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const left = Date.parse(session.expiresAt) - serverNow;
  const variant = drop.variants.find((v) => v.id === session.variantId);
  const total = variant ? price(variant.priceCents * session.qty) : '';
  const holdPath = `/api/holds/${encodeURIComponent(session.holdId)}`;
  const resendIn = sent ? Math.ceil((sent.at + sent.resendAfterSec * 1000 - Date.now()) / 1000) : 0;
  const [resume, setResume] = useState<'loading' | 'ready' | 'error' | 'expired'>('loading');
  const [resumeVersion, setResumeVersion] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState(5);
  useEffect(() => {
    let active = true;
    setResume('loading');
    buyerApi<Confirmation & { state: string; code?: { sentTo: string; resendAfterSec: number; sendsLeft: number; attemptsLeft: number } }>(holdPath, { method: 'GET', token: session.hold })
      .then(r => {
        if (!active) return;
        if (r.state === 'confirmed') { props.setSession({ stage: 'confirmed', confirmation: r }); return; }
        if (r.state !== 'active') { setResume('expired'); return; }
        if (r.code) { setSent({ to: r.code.sentTo, at: Date.now(), resendAfterSec: r.code.resendAfterSec, sendsLeft: r.code.sendsLeft }); setAttemptsLeft(r.code.attemptsLeft); }
        setResume('ready');
      }).catch(() => { if (active) setResume(Date.parse(session.expiresAt) <= Date.now() ? 'expired' : 'error'); });
    return () => { active = false; };
  }, [holdPath, session.hold, resumeVersion, props.setSession]);


  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setNotice(message(err));
      if (err instanceof BuyerApiError && err.code === 'OTP_LOCKED') setAttemptsLeft(0);
      if (err instanceof BuyerApiError && err.code === 'HOLD_EXPIRED') setResume('expired');
    } finally {
      setBusy(false);
    }
  };

  const sendCode = () => run(async () => {
    const r = await buyerApi<{ sentTo: string; resendAfterSec: number; sendsLeft: number; devCode?: string }>(`${holdPath}/otp`, { token: session.hold, body: { email } });
    setSent({ to: r.sentTo, at: Date.now(), resendAfterSec: r.resendAfterSec, sendsLeft: r.sendsLeft, devCode: r.devCode });
  });

  const confirm = (e: FormEvent) => {
    e.preventDefault();
    if (needsCode && !sent) return void sendCode();
    return void run(async () => {
      const c = await buyerApi<Confirmation>(`${holdPath}/confirm`, { token: session.hold, body: { name, email, ...(needsCode ? { code } : {}) } });
      props.setSession({ stage: 'confirmed', confirmation: c });
    });
  };

  if (resume === 'loading' || resume === 'error') return <Page header={<CompactHeader drop={drop} />}><div className="p-4"><StateCard icon={<Clock />} iconClass="bg-brand-tint text-brand-text" title={resume === 'loading' ? 'Restoring your reservation…' : 'Could not restore your reservation'} action={resume === 'error' ? <Button onClick={() => setResumeVersion(n => n+1)}>Retry</Button> : undefined}>Your hold timer continues while reconnecting.</StateCard></div></Page>;

  if (left <= 0 || resume === 'expired') {
    return (
      <Page header={<CompactHeader drop={drop} />}>
        <main className="p-4">
          <StateCard icon={<TimerOff />} iconClass="bg-warn-tint text-warn" title="Your hold expired" action={<Button size="lg" variant="outline" className="w-full" onClick={props.onStartOver}>Join again</Button>}>
            The item went back to stock so someone else could have it. You can join again for a new place.
          </StateCard>
        </main>
      </Page>
    );
  }

  const urgent = left < 60_000;
  return (
    <Page
      header={(
        <CompactHeader drop={drop} right={(
          <span className={cn('tabular inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold', urgent ? 'bg-danger-tint text-danger' : 'bg-warn-tint text-warn')} role="timer" aria-label={`${mmss(left)} left to check out`}>
            <Clock className="size-[15px]" strokeWidth={2.2} />{mmss(left)}
          </span>
        )} />
      )}
      bar={(
        <>
          <ErrorText>{notice}</ErrorText>
          <Button size="lg" className="w-full" type="submit" form="checkout" disabled={busy || attemptsLeft === 0 || (needsCode && Boolean(sent) && code.length < 6)}>
            {busy ? <><Spinner />Please wait…</> : needsCode && !sent ? 'Send code' : `Confirm order · ${total}`}
          </Button>
          <p className="text-center text-[13px] text-muted">{needsCode && !sent ? 'We email you a 6-digit code to check it is you.' : 'You pay the shop directly after confirming.'}</p>
        </>
      )}
    >
      <form id="checkout" onSubmit={confirm} className="flex flex-col gap-4 px-4 pt-5">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-[30px] leading-[1.02] font-extrabold tracking-[-0.025em]">Reserved for you</h1>
          <p className="text-sm leading-snug text-muted">We&apos;re holding it for {mmss(left)}. Confirm to make it yours.</p>
        </div>

        <Card className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex size-[52px] shrink-0 items-center justify-center rounded-[14px] bg-brand-tint text-brand-text"><Package className="size-6" /></span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-bold">{session.qty} × {variant?.name}</span>
            {drop.merchant.name && <span className="truncate text-[13px] text-muted">{drop.title}</span>}
          </span>
          <span className="tabular font-extrabold">{total}</span>
        </Card>

        <Card className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <Eyebrow>Your details</Eyebrow>
            {prefilled && <span className="inline-flex items-center gap-1 text-xs font-bold text-ok"><Check className="size-3.5" strokeWidth={2.6} />Filled in from earlier</span>}
          </div>
          <Field label="Name"><Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>
          <Field label="Email" help="One order per email for this drop. The shop uses it to contact you about collection.">
            <Input required type="email" value={email}  onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <p className="text-xs leading-snug text-muted">
            Your name and email go to {drop.merchant.name} for this order and are deleted 180 days after the drop.{' '}
            <a href="/privacy/" target="_blank" rel="noreferrer" className="font-semibold text-ink underline underline-offset-2">Privacy</a>
          </p>
        </Card>

        {needsCode && sent && (
          <Card className="flex flex-col gap-3">
            <Eyebrow>Email code</Eyebrow>
            <p className="text-sm leading-snug text-muted">We sent a 6-digit code to <strong className="text-ink">{sent.to}</strong>.</p>
            {sent.devCode && (
              <p className="rounded-xl bg-brand-tint px-3 py-2 text-sm text-ink">Test mode, no email sent: your code is <strong className="tabular">{sent.devCode}</strong></p>
            )}
            <p className="text-xs text-muted">Use the email address this code was sent to. {sent.sendsLeft} resends remaining.{attemptsLeft === 0 && " No attempts left. Wait for this hold to expire, then join again."}</p>
            <CodeInput value={code} onChange={setCode} disabled={busy} />
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted">Didn&apos;t get it? Check spam.</span>
              <Button type="button" variant="outline" disabled={busy || resendIn > 0 || sent.sendsLeft === 0 || attemptsLeft === 0} onClick={() => void sendCode()}>
                {sent.sendsLeft === 0 ? 'No resends left' : resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
              </Button>
            </div>
          </Card>
        )}
      </form>
    </Page>
  );
}

function CopyRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-3', !last && 'border-b border-line')}>
      <span className="flex flex-col gap-0.5"><span className="text-xs font-semibold text-muted">{label}</span><span className="tabular font-bold">{value}</span></span>
      <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => void copyText(value, `${label} copied`)}><Copy />Copy</Button>
    </div>
  );
}

function Confirmed({ c, drop, fresh, cancelled }: { c: Confirmation; drop: PublicDrop; fresh?: boolean; cancelled?: boolean }) {
  // Celebrate once per order, not on every visit.
  useEffect(() => {
    if (!fresh || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const key = `dd.celebrated.${c.orderRef}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch { /* private mode: celebrate anyway */ }
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#101114';
    void confetti({ particleCount: 90, spread: 70, origin: { y: 0.25 }, colors: [colour, '#ffffff', '#d4ff3a'], disableForReducedMotion: true });
  }, [c.orderRef, fresh]);

  const total = price(c.amountCents);
  return (
    <div className="min-h-dvh bg-bg">
      <BrandArt className="flex flex-col items-center gap-3 px-5 pt-7 pb-16 text-center text-brand-fg">
        <div className="relative flex flex-col items-center gap-3">
          <span className="flex items-center gap-2 text-[13px] font-bold opacity-90">
            <ShopLogo merchant={drop.merchant} className="size-6 rounded-lg text-[10px] ring-2 ring-white/70" />{drop.merchant.name}
          </span>
          <span className="mt-2 flex size-16 items-center justify-center rounded-full bg-white text-ok"><Check className="size-[34px]" strokeWidth={3} /></span>
          <h1 className="font-display text-[32px] leading-[1.05] font-extrabold tracking-[-0.025em]">Order confirmed</h1>
          <p className="text-[15px] opacity-90">Keep this page, or note your reference below.</p>
        </div>
      </BrandArt>

      <main className="relative mx-auto -mt-10 flex w-full max-w-[560px] flex-col gap-4 px-4 pb-10">
        <Card className="overflow-hidden p-0">
          <div className="flex flex-col items-center gap-1.5 px-5 py-[18px]">
            <Eyebrow>Order reference</Eyebrow>
            <span className="font-mono text-[34px] leading-none font-bold tracking-[0.06em]">{c.orderRef}</span>
            <span className="text-[13px] text-muted">Show this when you collect</span>
          </div>
          <div aria-hidden className="mx-[18px] border-t-2 border-dashed border-line" />
          <div className="flex justify-between px-5 py-3.5 text-[15px]"><span>{c.qty} × {c.variantName}</span><span className="tabular font-extrabold">{total}</span></div>
        </Card>

        {cancelled ? <StateCard icon={<XCircle />} iconClass="bg-danger-tint text-danger" title="This drop was cancelled">Your order reference is preserved. Contact {c.merchant.name} about collection or a refund if you already paid. Do not make a new payment until the shop confirms what happens next.</StateCard> : <Card className="flex flex-col gap-1">
          <div className="mb-1.5 flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-brand-tint text-brand-text"><CreditCard className="size-[18px]" /></span>
            <h2 className="font-display text-lg font-bold">{c.merchant.paynow ? `Pay ${total} by PayNow` : 'Payment'}</h2>
          </div>
          {c.merchant.paynow ? (
            <>
              <CopyRow label="PayNow to" value={c.merchant.paynow} />
              <CopyRow label="Amount" value={total} />
              <CopyRow label="Reference" value={c.orderRef} last />
              <p className="mt-1 text-[13px] leading-snug text-muted">The shop marks your order paid once it arrives. DropDeck never takes card details.</p>
            </>
          ) : (
            <p className="text-sm text-muted">{c.merchant.name} will contact you about payment.</p>
          )}
        </Card>}

        {!cancelled && c.merchant.fulfilmentNote && (
          <Card className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-tint text-brand-text"><MapPin className="size-[18px]" /></span>
            <span className="flex flex-col gap-1"><span className="font-bold">Collection</span><span className="text-sm leading-relaxed text-muted">{c.merchant.fulfilmentNote}</span></span>
          </Card>
        )}

        {drop.merchant.slug && (
          <a href={`/s/${drop.merchant.slug}/`} className="inline-flex min-h-11 items-center justify-center gap-1.5 self-center text-[15px] font-bold text-brand-text">
            More drops from {drop.merchant.name}<ArrowRight className="size-4" strokeWidth={2.2} />
          </a>
        )}
      </main>
    </div>
  );
}
