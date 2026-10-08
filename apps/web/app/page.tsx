import type { Metadata } from 'next';
import {
  BadgeCheck, CalendarClock, ChartColumn, CircleDollarSign, Lock, Palette, QrCode, ShieldCheck, Shuffle, Smartphone, Store, Ticket,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Mark } from '../components/mark';
import { cn } from '../lib/utils';
import { PLANS } from '@dropdeck/shared/plans';
import { FeaturedDrops } from './landing/FeaturedDrops';
import { SignInLink, StartButton } from './landing/StartButton';

export const metadata: Metadata = {
  title: 'DropDeck: fair drops for small shops',
  description: 'Run a limited drop from your phone. Buyers get a random place in line, stock never oversells, and you get paid by PayNow.',
};

/** A phone frame around a real screenshot of the product (apps/web/public/landing). */
function Phone({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <div className={cn('w-[230px] shrink-0 overflow-hidden rounded-[2.4rem] border-[9px] border-[#1d1f24] bg-black shadow-[0_30px_80px_rgba(0,0,0,0.45)] sm:w-[260px]', className)}>
      <img src={src} alt={alt} className="block aspect-[390/844] w-full object-cover object-top" />
    </div>
  );
}

const Eyebrow = ({ children, dark }: { children: ReactNode; dark?: boolean }) => (
  <span className={`text-sm font-bold tracking-[0.12em] uppercase ${dark ? 'text-volt' : 'text-muted'}`}>{children}</span>
);

const H2 = ({ children, className }: { children: ReactNode; className?: string }) => (
  <h2 className={`font-display text-4xl leading-[1.02] font-extrabold tracking-[-0.03em] text-balance sm:text-5xl ${className ?? ''}`}>{children}</h2>
);

const sgd = (n: number) => `S$${n}`;

export default function Home() {
  const plans = [
    { key: 'starter', plan: PLANS.starter, price: sgd(PLANS.starter.monthlySgd), per: '/month', blurb: 'For home bakers and side projects.', points: [`${PLANS.starter.dropsPerMonth} drops a month`, `Up to ${PLANS.starter.unitsPerMonth} units a month`, 'Branded drop and shop pages', 'Orders, PayNow tracking, CSV'] },
    { key: 'growth', plan: PLANS.growth, price: sgd(PLANS.growth.monthlySgd), per: '/month', blurb: 'For shops that drop every week.', points: ['Unlimited drops and stock', `${PLANS.growth.sessionsIncluded!.toLocaleString()} buyer sessions included`, `S$${PLANS.growth.overagePer1kSgd} per extra 1,000 sessions`, 'Everything in Starter'], featured: true },
    { key: 'event', plan: PLANS.event, price: sgd(PLANS.event.perDropSgd), per: '/drop', blurb: 'For a one-off launch or pop-up.', points: ['Pay only when you drop', 'No monthly fee', 'Same fair queue and checkout', 'Everything in Starter'] },
  ];
  const features: Array<[ReactNode, string, string]> = [
    [<Palette key="a" />, 'Your brand, not ours', 'Logo, cover, colours and light or dark pages. Buyers see your shop.'],
    [<Store key="b" />, 'A shop page that keeps', 'One link for your bio that always shows what is live and coming up.'],
    [<QrCode key="c" />, 'Share anywhere', 'Copy the link, use your phone\'s share sheet, or print the QR code for the counter.'],
    [<CircleDollarSign key="d" />, 'Paid by PayNow', 'Buyers pay you directly. No card fees, and DropDeck never holds your money.'],
    [<ChartColumn key="e" />, 'Live view and reports', 'Watch stock go during the drop; mark orders paid or no-show; export a CSV.'],
    [<Lock key="f" />, 'Light on personal data', 'Only name and email at checkout, deleted 180 days after the drop.'],
  ];

  return (
    <div className="bg-bg text-ink">
      {/* ---------------------------------------------------------------- hero */}
      <header className="relative overflow-hidden bg-[#0b0c0f] text-[#f3f3f5]">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.07)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div aria-hidden className="absolute -top-40 right-[-10%] size-[520px] rounded-full bg-volt/10 blur-3xl" />
        <nav className="relative mx-auto flex h-18 max-w-6xl items-center justify-between px-5 py-5">
          <a href="/" className="flex items-center gap-2.5 text-[#f3f3f5] no-underline"><Mark /><span className="font-display text-xl font-extrabold tracking-tight">dropdeck</span></a>
          <div className="flex items-center gap-6 text-sm text-[#c7cad1]">
            <a href="#how" className="hidden text-inherit no-underline hover:text-white sm:inline">How it works</a>
            <a href="#pricing" className="hidden text-inherit no-underline hover:text-white sm:inline">Pricing</a>
            <SignInLink className="text-[#f3f3f5] hover:text-volt" />
          </div>
        </nav>

        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pt-8 pb-20 lg:grid-cols-[1.05fr_1fr] lg:pt-14 lg:pb-28">
          <div className="flex flex-col gap-7">
            <Eyebrow dark>For small shops that sell out</Eyebrow>
            <h1 className="font-display text-[3.2rem] leading-[0.95] font-extrabold tracking-[-0.035em] text-balance sm:text-7xl">
              Sell out <span className="text-volt">fairly.</span><br />No bots. No overselling.
            </h1>
            <p className="max-w-xl text-lg leading-relaxed text-[#b9bdc6]">
              Run a limited drop from your phone. Everyone who joins before the draw gets a random place in line, stock is held
              while they check out, and you get paid by PayNow.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <StartButton />
              <a href="#live" className="inline-flex h-14 items-center rounded-2xl border border-white/20 px-6 text-[17px] font-bold text-[#f3f3f5] no-underline hover:bg-white/5">See a live drop</a>
            </div>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[#9ea3ad]">
              {['Plans from S$19', 'Buyers need no account', 'Set up in minutes'].map((t) => (
                <li key={t} className="flex items-center gap-1.5"><BadgeCheck className="size-4 text-volt" />{t}</li>
              ))}
            </ul>
          </div>

          <div className="relative mx-auto flex h-[440px] w-full max-w-[540px] items-center justify-center sm:h-[600px]">
            <Phone src="/landing/countdown-dark.jpg" alt="A drop page counting down to the queue opening, in a coffee shop's dark theme" className="absolute top-6 left-1 w-[185px] -rotate-6 rounded-[2rem] border-[7px] sm:left-4 sm:w-[260px] sm:rounded-[2.4rem] sm:border-[9px]" />
            <Phone src="/landing/queue.jpg" alt="A buyer's place in line: 1,201 people ahead, with checkout details filled in while waiting" className="absolute right-1 bottom-0 w-[185px] rotate-[5deg] rounded-[2rem] border-[7px] sm:right-4 sm:w-[260px] sm:rounded-[2.4rem] sm:border-[9px]" />
            <span className="absolute top-2 right-2 hidden items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-[#101114] shadow-xl sm:flex"><Shuffle className="size-4" />Random draw, not a refresh race</span>
            <span className="absolute bottom-10 left-0 hidden items-center gap-2 rounded-full bg-volt px-4 py-2 text-sm font-extrabold text-[#101114] shadow-xl sm:flex"><ShieldCheck className="size-4" />Never sells more than you have</span>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- who it's for */}
      <section className="px-5 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-10 flex max-w-2xl flex-col gap-3">
            <Eyebrow>Made for limited runs</Eyebrow>
            <H2>When fifty people want the last twenty loaves</H2>
            <p className="text-lg text-muted">Small batches sell out in minutes. DropDeck makes that minute calm for you and fair for your buyers.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-3">
            {[['/landing/bakery.jpg', 'Bakeries and home bakers', 'Weekend bakes, festive specials, pre-orders that used to live in DMs.'],
              ['/landing/coffee.jpg', 'Roasters and cafés', 'Micro-lots and rare beans, where a bot or a fast refresher would take the lot.'],
              ['/landing/ceramics.jpg', 'Makers and studios', 'Restocks of handmade pieces, each one a little different.']].map(([src, title, text]) => (
              <figure key={title} className="m-0 overflow-hidden rounded-3xl border border-line bg-surface">
                <img src={src} alt="" loading="lazy" className="h-56 w-full object-cover" />
                <figcaption className="flex flex-col gap-1.5 p-5"><strong className="font-display text-xl">{title}</strong><span className="text-muted">{text}</span></figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- problem → fix */}
      <section className="bg-surface px-5 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 flex max-w-2xl flex-col gap-3">
            <Eyebrow>Drop day, without the mess</Eyebrow>
            <H2>The three things that go wrong, fixed</H2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {[[<Shuffle key="1" />, 'Refresh wars', 'Fast fingers and bots win when it is first come, first served.', 'Everyone who joins before the draw gets a random place. Turning up at the exact second does not help.'],
              [<Ticket key="2" />, 'Overselling', 'Two buyers pay for the last item, and you spend the evening refunding.', 'Stock is reserved the moment someone claims it and held while they check out. It cannot go below zero.'],
              [<CalendarClock key="3" />, 'Spreadsheet chasing', 'Matching transfers to DMs and screenshots after every drop.', 'Every order has a reference. Mark it paid or no-show, and export a CSV when you are done.']].map(([icon, title, before, after]) => (
              <div key={String(title)} className="flex flex-col gap-4 rounded-3xl border border-line bg-bg p-6">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-[#101114] text-volt [&_svg]:size-6">{icon}</span>
                <h3 className="font-display text-2xl font-bold">{title}</h3>
                <p className="text-muted"><span className="font-semibold text-ink">Before: </span>{before}</p>
                <p><span className="font-semibold">With DropDeck: </span>{after}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- how it works */}
      <section id="how" className="relative overflow-hidden bg-[#0b0c0f] px-5 py-20 text-[#f3f3f5] sm:py-28">
        <div aria-hidden className="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="relative mx-auto max-w-6xl">
          <div className="mb-14 flex max-w-2xl flex-col gap-3">
            <Eyebrow dark>How a drop works</Eyebrow>
            <H2>Schedule it. Share it. Watch it go.</H2>
          </div>
          <div className="grid gap-12 md:grid-cols-3">
            {[['1', 'Buyers join before the draw', 'Your drop page counts down. Anyone who joins in the window gets a random place; nobody needs an account.', '/landing/countdown-dark.jpg', 'Countdown to the queue opening'],
              ['2', 'They reserve when it\'s their turn', 'The line moves on its own. At their turn a buyer has two minutes to pick and reserve, and the item is held for them.', '/landing/turn.jpg', 'A buyer picking an item when it is their turn'],
              ['3', 'You get paid by PayNow', 'They confirm with an email code and get an order reference and your PayNow details. You mark it paid.', '/landing/confirmed.jpg', 'An order confirmation with PayNow details']].map(([n, title, text, src, alt]) => (
              <div key={n} className="flex flex-col items-center gap-6 text-center md:items-start md:text-left">
                <Phone src={src!} alt={alt!} />
                <div className="flex flex-col gap-2">
                  <span className="font-display text-5xl font-extrabold text-volt">{n}</span>
                  <h3 className="font-display text-2xl font-bold">{title}</h3>
                  <p className="text-[#b9bdc6]">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- live drops (dynamic) */}
      <FeaturedDrops />

      {/* ---------------------------------------------------------------- features */}
      <section className="bg-surface px-5 py-20 sm:py-24">
        <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-10">
            <div className="flex max-w-2xl flex-col gap-3">
              <Eyebrow>Everything a small shop needs on drop day</Eyebrow>
              <H2>Built for your phone, from setup to payout</H2>
            </div>
            <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
              {features.map(([icon, title, text]) => (
                <div key={title} className="flex gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-bg text-ink [&_svg]:size-5">{icon}</span>
                  <span className="flex flex-col gap-1"><strong className="text-lg">{title}</strong><span className="text-muted">{text}</span></span>
                </div>
              ))}
            </div>
          </div>
          <div className="relative hidden lg:block">
            <Phone src="/landing/shop.jpg" alt="A shop page listing live and upcoming drops" />
            <span className="absolute -left-10 top-16 flex items-center gap-2 rounded-full bg-[#101114] px-4 py-2 text-sm font-bold text-white shadow-xl"><Smartphone className="size-4 text-volt" />One link for your bio</span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- pricing */}
      <section id="pricing" className="px-5 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 flex max-w-2xl flex-col gap-3">
            <Eyebrow>Pricing</Eyebrow>
            <H2>Pay for drops, not for quiet months</H2>
            <p className="text-lg text-muted">Prices in Singapore dollars. Buyers pay you directly by PayNow, so there are no card fees on top.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {plans.map((p) => (
              <div key={p.key} className={`flex flex-col gap-5 rounded-3xl border p-7 ${p.featured ? 'border-[#101114] bg-[#101114] text-white' : 'border-line bg-surface'}`}>
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-2xl font-bold">{p.plan.label}</h3>
                  {p.featured && <span className="rounded-full bg-volt px-3 py-1 text-xs font-extrabold text-[#101114]">Most shops</span>}
                </div>
                <div className="flex items-baseline gap-1"><span className="font-display text-5xl font-extrabold tracking-tight">{p.price}</span><span className={p.featured ? 'text-[#b9bdc6]' : 'text-muted'}>{p.per}</span></div>
                <p className={p.featured ? 'text-[#b9bdc6]' : 'text-muted'}>{p.blurb}</p>
                <ul className="flex flex-col gap-2.5">
                  {p.points.map((pt) => <li key={pt} className="flex items-start gap-2"><BadgeCheck className={`mt-0.5 size-5 shrink-0 ${p.featured ? 'text-volt' : 'text-ok'}`} />{pt}</li>)}
                </ul>
                <StartButton variant={p.featured ? 'volt' : 'ink'} className="mt-auto w-full">Start with {p.plan.label}</StartButton>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-muted">Every shop starts on Starter. Ask us to move you to Growth or Event; your plan shows in the console.</p>
        </div>
      </section>

      {/* ---------------------------------------------------------------- final call */}
      <section className="px-5 pb-20">
        <div className="relative mx-auto flex max-w-6xl flex-col items-start gap-6 overflow-hidden rounded-[2rem] bg-volt px-8 py-14 text-[#101114] sm:px-14">
          <div aria-hidden className="absolute -right-24 -bottom-24 size-80 rounded-full bg-[#101114]/10" />
          <H2 className="relative max-w-3xl">Run your first fair drop this week</H2>
          <p className="relative max-w-xl text-lg">Set up your shop, schedule a drop and share one link. It takes a few minutes from your phone.</p>
          <StartButton variant="ink" className="relative" />
        </div>
      </section>

      <footer className="border-t border-line px-5 py-10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-sm text-muted">
          <span className="flex items-center gap-2.5"><Mark className="size-6 rounded-md [&_svg]:size-4" /><span className="font-display font-extrabold text-ink">dropdeck</span><span>Fair drops for small shops, made in Singapore.</span></span>
          <span className="flex items-center gap-5">
            <a href="/m/" className="text-inherit no-underline hover:text-ink">Merchant console</a>
            <a href="/privacy/" className="text-inherit no-underline hover:text-ink">Privacy</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
