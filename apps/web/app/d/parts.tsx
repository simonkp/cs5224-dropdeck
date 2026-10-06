'use client';

import type { PublicDrop, PublicState } from '@dropdeck/shared';
import { CalendarPlus, Clock, Mail, Package, Shuffle, Upload, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { BrandArt, ShopLogo } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Card, Eyebrow, SectionTitle } from '../../components/ui/card';
import { Sheet } from '../../components/ui/dialog';
import { downloadIcs, googleCalendarUrl, type CalendarEvent } from '../../lib/calendar';
import { countdownParts, dayTime, price, time } from '../../lib/format';
import { shareLink } from '../../lib/share';
import { cn } from '../../lib/utils';

/** Page frame: header on top, content in a phone-width column, room at the bottom for the sticky action bar. */
export function Page(props: { header: ReactNode; children: ReactNode; bar?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-bg">
      {props.header}
      <div className="mx-auto w-full max-w-[560px]">{props.children}</div>
      {props.bar && (
        <>
          <div aria-hidden className="h-36" />
          <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
            <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pt-3 pb-[max(1.75rem,env(safe-area-inset-bottom))]">{props.bar}</div>
          </div>
        </>
      )}
    </div>
  );
}

const pageUrl = () => window.location.href.split('#')[0]!;

function ShareButton({ title }: { title: string }) {
  return (
    <Button variant="outline" size="icon" aria-label="Share this drop" onClick={() => void shareLink(pageUrl(), title)}>
      <Upload />
    </Button>
  );
}

/** Shop name and tagline, for the countdown and join screens. */
export function ShopHeader({ drop }: { drop: PublicDrop }) {
  const m = drop.merchant;
  const inner = (
    <>
      <ShopLogo merchant={m} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] leading-tight font-bold">{m.name}</span>
        {m.tagline && <span className="truncate text-xs text-muted">{m.tagline}</span>}
      </span>
    </>
  );
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[560px] items-center justify-between gap-3 px-4">
        {m.slug ? <a href={`/s/${m.slug}/`} className="flex min-w-0 items-center gap-2.5 text-ink no-underline">{inner}</a> : <span className="flex min-w-0 items-center gap-2.5">{inner}</span>}
        <ShareButton title={drop.title} />
      </div>
    </header>
  );
}

/** Drop title under the shop name, for the queue and checkout screens. */
export function CompactHeader({ drop, right }: { drop: PublicDrop; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[560px] items-center justify-between gap-3 px-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <ShopLogo merchant={drop.merchant} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[15px] leading-tight font-bold">{drop.title}</span>
            <span className="truncate text-xs text-muted">{drop.merchant.name}</span>
          </span>
        </span>
        {right}
      </div>
    </header>
  );
}

/** Drop photo (or the shop's cover, or brand art) with the content sheet overlapping its bottom edge. */
export function Hero({ drop }: { drop: PublicDrop }) {
  return <BrandArt src={drop.imageUrl ?? drop.merchant.coverUrl} label={drop.title} className="h-[210px] sm:mt-4 sm:h-[280px] sm:rounded-3xl" />;
}

export function Content({ children }: { children: ReactNode }) {
  return <main className="relative -mt-7 flex flex-col gap-4 rounded-t-[28px] bg-bg px-4 pt-[22px] sm:mt-0">{children}</main>;
}

export function StatusPill(props: { tone?: 'brand' | 'live'; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-flex h-[30px] items-center gap-2 self-start rounded-full px-3 text-[13px] font-bold',
      props.tone === 'live' ? 'bg-ok/12 text-ok' : 'bg-brand-tint text-brand-text',
    )}>
      <span aria-hidden className={cn('size-2 rounded-full bg-current', props.tone === 'live' && 'animate-pulse-dot')} />
      {props.children}
    </span>
  );
}

export function TitleBlock({ drop, pill }: { drop: PublicDrop; pill: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {pill}
      <h1 className="font-display text-[34px] leading-[1.02] font-extrabold tracking-[-0.025em] text-balance">{drop.title}</h1>
      {drop.description && <p className="text-[15px] leading-relaxed text-muted">{drop.description}</p>}
    </div>
  );
}

export function CountdownCard({ drop, msLeft }: { drop: PublicDrop; msLeft: number }) {
  const parts = countdownParts(msLeft);
  return (
    <Card className="flex flex-col gap-3.5" aria-label="Countdown">
      <Eyebrow>Queue opens in</Eyebrow>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))` }} role="timer" aria-live="off">
        {parts.map((p, i) => (
          <div key={p.unit} className="flex flex-col items-center gap-1.5 rounded-2xl bg-brand-soft pt-3.5 pb-2.5">
            <span className={cn('tabular text-[44px] leading-none font-extrabold tracking-tight', i === parts.length - 1 && 'text-brand-text')}>{p.value}</span>
            <span className="text-[11px] font-bold tracking-[0.08em] text-muted">{p.unit}</span>
          </div>
        ))}
      </div>
      <p className="flex items-start gap-2.5 text-[13px] leading-snug text-muted">
        <Shuffle className="mt-px size-[18px] shrink-0 text-brand-text" />
        <span>Join any time between {time(drop.entryOpensAt)} and {time(drop.openAt)}. Places are drawn at random, so there is no need to tap at the exact second.</span>
      </p>
    </Card>
  );
}

export function RuleChips({ drop }: { drop: PublicDrop }) {
  const chip = 'inline-flex h-[34px] items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-[13px] font-semibold [&_svg]:size-4';
  return (
    <div className="flex flex-wrap gap-2">
      <span className={chip}><Users />Limit {drop.perBuyerLimit} each</span>
      <span className={chip}><Clock />Held {Math.round(drop.holdSec / 60)} min once reserved</span>
      {drop.verification === 'email' && <span className={chip}><Mail />Email code at checkout</span>}
    </div>
  );
}

export function VariantGrid({ drop, state }: { drop: PublicDrop; state: PublicState | null }) {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionTitle className="mt-1">In this drop</SectionTitle>
      <div className="grid grid-cols-2 gap-2.5">
        {drop.variants.map((v) => {
          const gone = state?.soldOut?.[v.id];
          return (
            <div key={v.id} className={cn('flex flex-col gap-2.5 rounded-[20px] border border-line bg-surface p-2.5 pb-3.5', gone && 'opacity-60')}>
              <div className="relative flex h-[92px] items-center justify-center rounded-[14px] bg-brand-tint text-brand-text">
                <Package className="size-[30px]" strokeWidth={1.8} />
                {gone && <span className="absolute top-2 left-2 rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold text-bg">Reserved</span>}
              </div>
              <div className="flex flex-col gap-0.5 px-1">
                <span className="text-[15px] font-bold">{v.name}</span>
                <span className="tabular text-[15px] font-semibold text-muted">{price(v.priceCents)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function HowItWorks({ drop }: { drop: PublicDrop }) {
  const steps: Array<[ReactNode, ReactNode]> = [
    ['Join the queue', <> any time from {time(drop.entryOpensAt)} to {time(drop.openAt)}.</>],
    [`At ${time(drop.openAt)} everyone gets a random place.`, ' Joining early or late in the window makes no difference.'],
    ['When it is your turn,', ' reserve, confirm, then pay the shop directly.'],
  ];
  return (
    <Card className="flex flex-col gap-3.5">
      <h2 className="font-display text-lg font-bold">How this drop works</h2>
      {steps.map(([strong, rest], i) => (
        <div key={i} className="flex items-start gap-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[13px] font-extrabold text-brand-text">{i + 1}</span>
          <span className="text-sm leading-snug"><strong>{strong}</strong>{rest}</span>
        </div>
      ))}
    </Card>
  );
}

export function Footer() {
  return <p className="py-4 text-center text-xs text-muted">Fair drops by DropDeck</p>;
}

/** "Add to calendar" for the queue opening: Apple/Outlook (.ics) or Google. */
export function CalendarButton({ drop, className }: { drop: PublicDrop; className?: string }) {
  const [open, setOpen] = useState(false);
  const event = (): CalendarEvent => ({
    title: `${drop.title}: queue opens`,
    start: drop.entryOpensAt,
    end: drop.openAt,
    url: pageUrl(),
    details: `${drop.merchant.name}. Join any time before ${dayTime(drop.openAt)}; places are drawn at random.`,
  });
  return (
    <>
      <Button size="lg" className={cn('w-full', className)} onClick={() => setOpen(true)}>
        <CalendarPlus />Add to calendar
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title="Add to calendar" description={`Queue opens ${dayTime(drop.entryOpensAt)}`}>
        <div className="flex flex-col gap-2">
          <Button size="lg" variant="outline" onClick={() => { downloadIcs(event(), `${drop.title.replace(/[^\w-]+/g, '-').toLowerCase()}.ics`); setOpen(false); }}>
            Apple or Outlook calendar
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a href={googleCalendarUrl(event())} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Google Calendar</a>
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** Small icon + title + text card, for the end states. */
export function StateCard(props: { icon: ReactNode; iconClass: string; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className={cn('flex size-[52px] items-center justify-center rounded-2xl [&_svg]:size-6', props.iconClass)}>{props.icon}</span>
      <h2 className="font-display text-2xl leading-tight font-extrabold tracking-tight">{props.title}</h2>
      <div className="text-sm leading-relaxed text-muted">{props.children}</div>
      {props.action}
    </Card>
  );
}
