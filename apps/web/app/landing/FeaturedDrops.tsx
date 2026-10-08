'use client';

import type { FeaturedDrop, PublicFeatured } from '@dropdeck/shared';
import { ArrowRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAssetUrl } from '../../lib/assets';
import { brandStyle, initials } from '../../lib/brand';
import { dayTime, price, time } from '../../lib/format';
import { cn } from '../../lib/utils';

/** p/featured.json is a minute old at most, so a Scheduled drop whose queue has opened is shown as live. */
const liveNow = (d: FeaturedDrop, now: number) => d.state === 'Live' || (d.state === 'Scheduled' && now >= Date.parse(d.entryOpensAt) && now < Date.parse(d.endAt));

function Card({ d, now }: { d: FeaturedDrop; now: number }) {
  const img = useAssetUrl(d.imageUrl);
  const logo = useAssetUrl(d.shop.logoUrl);
  const live = liveNow(d, now);
  const ended = d.state === 'Closed' || now >= Date.parse(d.endAt);
  const status = live ? 'Live now' : ended ? 'Ended' : `Opens ${dayTime(d.entryOpensAt)}`;
  return (
    <a
      href={d.url}
      style={brandStyle(d.shop.colour, false)}
      className="group flex flex-col overflow-hidden rounded-3xl border border-line bg-surface text-ink no-underline transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[0_18px_40px_rgba(16,17,20,0.14)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <div className="relative h-48 overflow-hidden bg-brand">
        {img && <img src={img} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04] motion-reduce:transition-none" />}
        <span className={cn('absolute top-3 left-3 inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-extrabold', live ? 'bg-ok text-white' : 'bg-white/95 text-[#101114]')}>
          {live && <span aria-hidden className="size-2 animate-pulse-dot rounded-full bg-current" />}{status}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <span className="flex items-center gap-2 text-sm font-semibold text-muted">
          {logo ? <img src={logo} alt="" className="size-6 rounded-md object-cover" /> : <span className="flex size-6 items-center justify-center rounded-md bg-brand text-[10px] font-extrabold text-brand-fg">{initials(d.shop.name)}</span>}
          {d.shop.name}
        </span>
        <span className="font-display text-2xl leading-tight font-bold">{d.title}</span>
        <span className="mt-auto flex items-center justify-between text-sm">
          <span className="text-muted">{live ? `Draw at ${time(d.openAt)}` : ended ? 'Sold through DropDeck' : 'Random draw, no refresh wars'} · from {price(d.fromPriceCents)}</span>
          <ArrowRight className="size-4 shrink-0 text-brand-text transition-transform group-hover:translate-x-1" strokeWidth={2.4} />
        </span>
      </div>
    </a>
  );
}

/** Up to three real drops from shops that chose to be listed on the homepage. Hidden when there are none. */
export function FeaturedDrops() {
  const [drops, setDrops] = useState<FeaturedDrop[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    fetch('/p/featured.json')
      .then((r) => (r.ok ? (r.json() as Promise<PublicFeatured>) : Promise.reject(new Error(String(r.status)))))
      .then((f) => { setNow(Date.now()); setDrops(f.drops.slice(0, 3)); })
      .catch(() => setDrops([]));
  }, []);
  if (!drops || drops.length === 0) return null;
  return (
    <section id="live" className="bg-bg px-5 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-3">
            <span className="text-sm font-bold tracking-[0.12em] text-muted uppercase">Happening on DropDeck</span>
            <h2 className="font-display text-4xl leading-[1.02] font-extrabold tracking-[-0.03em] sm:text-5xl">See a live drop</h2>
          </div>
          <p className="max-w-sm text-muted">Real drops from shops on DropDeck. Open one on your phone and join the queue.</p>
        </div>
        <div className="grid gap-5 md:grid-cols-3">{drops.map((d) => <Card key={d.url} d={d} now={now} />)}</div>
      </div>
    </section>
  );
}
