'use client';

import type { PublicShop, PublicShopDrop } from '@dropdeck/shared';
import { ArrowRight, CalendarPlus, SearchX, Store, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandArt, ShopLogo, useDocumentBrand } from '../../components/brand';
import { Badge, LiveDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, SectionTitle } from '../../components/ui/card';
import { Skeleton } from '../../components/ui/skeleton';
import { downloadIcs } from '../../lib/calendar';
import { dateBlock, day, dayTime, price, time } from '../../lib/format';
import { shareLink } from '../../lib/share';
import { cn } from '../../lib/utils';
import { StateCard } from '../d/parts';

function useSlug() {
  const [slug, setSlug] = useState<string | null>(null);
  useEffect(() => {
    const [, prefix, s] = window.location.pathname.split('/');
    if (prefix === 's' && s) setSlug(s);
  }, []);
  return slug;
}

/** shop.json can be up to a minute old, so a Scheduled drop whose queue has opened is shown as live. */
const isLive = (d: PublicShopDrop, now: number) => d.state === 'Live' || (d.state === 'Scheduled' && now >= Date.parse(d.entryOpensAt) && now < Date.parse(d.endAt));

function addToCalendar(d: PublicShopDrop, shopName: string) {
  downloadIcs(
    { title: `${d.title}: queue opens`, start: d.entryOpensAt, end: d.openAt, url: new URL(d.url, window.location.origin).toString(), details: `${shopName}. Places are drawn at random at ${time(d.openAt)}.` },
    `${d.title.replace(/[^\w-]+/g, '-').toLowerCase()}.ics`,
  );
}

function LiveCard({ d }: { d: PublicShopDrop }) {
  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <BrandArt src={d.imageUrl} label={d.title} className="h-40 sm:h-44">
        <Badge tone="live" className="absolute top-3 left-3"><LiveDot />LIVE</Badge>
      </BrandArt>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex flex-1 flex-col gap-1">
          <h3 className="font-display text-[22px] leading-tight font-bold">{d.title}</h3>
          <span className="text-sm text-muted">Queue open · draw at {time(d.openAt)} · from {price(d.fromPriceCents)}</span>
        </div>
        <Button size="lg" className="w-full" asChild><a href={d.url}>Join the queue<ArrowRight strokeWidth={2.4} /></a></Button>
      </div>
    </Card>
  );
}

function UpcomingCard({ d, shopName }: { d: PublicShopDrop; shopName: string }) {
  const b = dateBlock(d.openAt);
  return (
    <Card className="flex items-center gap-3 p-3 sm:flex-col sm:items-stretch sm:gap-0 sm:overflow-hidden sm:p-0">
      <BrandArt src={d.imageUrl} label={d.title} className="hidden h-44 sm:block">
        <Badge tone="brand" className="absolute top-3 left-3 bg-surface">{dayTime(d.entryOpensAt).toUpperCase()}</Badge>
      </BrandArt>
      <span className="flex h-[60px] w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[14px] bg-brand-tint text-brand-text sm:hidden">
        <span className="text-[11px] font-extrabold tracking-wider">{b.dow}</span>
        <span className="font-display text-[22px] leading-none font-extrabold">{b.date}</span>
      </span>
      <a href={d.url} className="flex min-w-0 flex-1 flex-col gap-0.5 text-ink no-underline sm:p-4 sm:pb-2">
        <span className="truncate text-base font-bold sm:font-display sm:text-[22px] sm:leading-tight">{d.title}</span>
        <span className="text-[13px] text-muted sm:text-sm">Queue opens {time(d.entryOpensAt)} · from {price(d.fromPriceCents)}</span>
      </a>
      <Button variant="outline" size="icon" className="sm:hidden" aria-label={`Add ${d.title} to calendar`} onClick={() => addToCalendar(d, shopName)}><CalendarPlus /></Button>
      <div className="hidden px-4 pb-4 sm:block">
        <Button variant="outline" size="lg" className="w-full" onClick={() => addToCalendar(d, shopName)}><CalendarPlus />Add to calendar</Button>
      </div>
    </Card>
  );
}

export default function ShopView() {
  const slug = useSlug();
  const [shop, setShop] = useState<PublicShop | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useDocumentBrand(shop?.merchant);

  useEffect(() => {
    if (!slug) return;
    // S3 behind CloudFront answers 403 (not 404) for a missing key; either way there is no shop here.
    fetch(`/s/${slug}/shop.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: PublicShop) => {
        setShop(s);
        document.title = `${s.merchant.name} · DropDeck`;
      })
      .catch(() => setMissing(true));
  }, [slug]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (missing) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center p-4">
        <StateCard icon={<SearchX />} iconClass="bg-sunken text-muted" title="We couldn't find this shop">Check the link with the shop. It may have changed or been mistyped.</StateCard>
      </main>
    );
  }
  if (!shop) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-[180px] rounded-none sm:h-[280px]" />
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4"><Skeleton className="h-24 w-2/3" /><Skeleton className="h-60" /></div>
      </div>
    );
  }

  const m = shop.merchant;
  const live = shop.drops.filter((d) => isLive(d, now));
  const upcoming = shop.drops.filter((d) => d.state === 'Scheduled' && !isLive(d, now));
  const past = shop.drops.filter((d) => d.state === 'Closed');

  return (
    <div className="min-h-dvh bg-bg">
      <BrandArt src={m.coverUrl} className="h-[180px] sm:h-[280px]" />
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6">
        <header className="relative -mt-11 flex flex-col gap-3 sm:-mt-14 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
          <div className="flex items-end justify-between gap-5 sm:items-start sm:justify-start">
            <ShopLogo merchant={m} className="size-[88px] rounded-[26px] border-4 border-bg font-display text-3xl sm:size-[120px] sm:rounded-[34px] sm:border-[5px] sm:text-[40px]" />
            <div className="hidden flex-col gap-1 sm:mt-[68px] sm:flex">
              <h1 className="font-display text-[40px] leading-[1.05] font-extrabold tracking-[-0.025em]">{m.name}</h1>
              {m.tagline && <p className="text-[17px] text-muted">{m.tagline}</p>}
            </div>
            <Button variant="outline" size="icon" className="sm:hidden" aria-label="Share this shop" onClick={() => void shareLink(window.location.href, m.name)}><Upload /></Button>
          </div>
          <div className="flex flex-col gap-1 sm:hidden">
            <h1 className="font-display text-[30px] leading-[1.05] font-extrabold tracking-[-0.025em]">{m.name}</h1>
            {m.tagline && <p className="text-[15px] text-muted">{m.tagline}</p>}
          </div>
          <Button variant="outline" className="hidden sm:mt-[72px] sm:inline-flex" onClick={() => void shareLink(window.location.href, m.name)}><Upload />Share shop</Button>
        </header>

        <main className="mt-6 flex flex-col gap-8 sm:mt-10">
          {live.length + upcoming.length === 0 && (
            <Card className="flex items-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-brand-tint text-brand-text"><Store className="size-5" /></span>
              <p className="text-sm text-muted">No drops scheduled right now. Check back soon.</p>
            </Card>
          )}
          {live.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionTitle className="sm:text-2xl">Live now</SectionTitle>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{live.map((d) => <LiveCard key={d.dropId} d={d} />)}</div>
            </section>
          )}
          {upcoming.length > 0 && (
            <section className="flex flex-col gap-3">
              <SectionTitle className="sm:text-2xl">Coming up</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">{upcoming.map((d) => <UpcomingCard key={d.dropId} d={d} shopName={m.name} />)}</div>
            </section>
          )}
          {past.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionTitle className="sm:text-2xl">Past drops</SectionTitle>
              <Card className="px-4 py-1 sm:px-5">
                {past.map((d, i) => (
                  <div key={d.dropId} className={cn('flex justify-between gap-3 py-3.5 text-[15px]', i > 0 && 'border-t border-line')}>
                    <span className="truncate">{d.title}</span><span className="shrink-0 text-muted">Ended {day(d.endAt)}</span>
                  </div>
                ))}
              </Card>
            </section>
          )}
          <p className="text-center text-xs text-muted">Fair drops by DropDeck · random draw, no bots</p>
        </main>
      </div>
    </div>
  );
}
