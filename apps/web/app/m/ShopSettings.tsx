'use client';

import type { MerchantProfile, ThemeMode } from '@dropdeck/shared';
// The browser-safe subpath: the package index also pulls in node:crypto.
import { slugProblem, TAGLINE_MAX } from '@dropdeck/shared/branding';
import { ArrowUpRight, Check, Loader2, Upload, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { BrandArt, BrandScope, ShopLogo, useDarkMode } from '../../components/brand';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, Input, Textarea } from '../../components/ui/input';
import { Segmented } from '../../components/ui/segmented';
import { api, ApiRequestError } from '../../lib/api';
import { contrastNote, initials, parseHex } from '../../lib/brand';
import { cn } from '../../lib/utils';
import { DropPreview } from '../../components/drop-preview';
import { useUnsaved } from '../../lib/unsaved';
import { ImagePicker } from './ImagePicker';
import { ShareSheet, type ShareTarget } from './ShareSheet';
import { absolute, ViewHeader, type ConsoleCtx } from './shared';

const SWATCHES: Array<[string, string]> = [
  ['#b5651d', 'Crust'], ['#0f766e', 'Teal'], ['#e11d48', 'Red'], ['#6d28d9', 'Violet'], ['#1d4ed8', 'Blue'], ['#f2c94c', 'Butter'], ['#101114', 'Ink'],
];

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <Card className="flex flex-col gap-3.5 rounded-[20px] p-4 lg:p-5"><h2 className="font-display text-[17px] font-bold">{title}</h2>{children}</Card>;
}

type SlugCheck = { state: 'idle' | 'checking' | 'ok' | 'bad'; text?: string };

export function ShopSettings({ ctx }: { ctx: ConsoleCtx }) {
  const p = ctx.profile;
  const setup = p === null;
  const [name, setName] = useState(p?.name ?? '');
  const [tagline, setTagline] = useState(p?.tagline ?? '');
  const [colour, setColour] = useState(p?.colour ?? '#b5651d');
  const [hexDraft, setHexDraft] = useState((p?.colour ?? '#b5651d').toUpperCase());
  const [theme, setTheme] = useState<ThemeMode>(p?.theme ?? 'auto');
  const [logoUrl, setLogoUrl] = useState(p?.logoUrl);
  const [coverUrl, setCoverUrl] = useState(p?.coverUrl);
  const [slug, setSlug] = useState(p?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(p));
  const [slugCheck, setSlugCheck] = useState<SlugCheck>({ state: 'idle' });
  const [paynow, setPaynow] = useState(p?.paynow ?? '');
  const [note, setNote] = useState(p?.fulfilmentNote ?? '');
  const [listed, setListed] = useState(p?.listed ?? false);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState<ShareTarget | null>(null);

  const { dirty, markSaved } = useUnsaved(JSON.stringify({ name, tagline, colour, theme, logoUrl, coverUrl, slug, paynow, note, listed }));

  // A new shop's link follows its name until the merchant edits the link themselves.
  useEffect(() => {
    if (!slugTouched) setSlug(slugify(name));
  }, [name, slugTouched]);

  // Check the link as it is typed (after a pause).
  useEffect(() => {
    if (!slug || (p && slug === p.slug)) return setSlugCheck({ state: 'idle' });
    const problem = slugProblem(slug);
    if (problem) return setSlugCheck({ state: 'bad', text: problem });
    setSlugCheck({ state: 'checking' });
    const id = setTimeout(() => {
      api<{ available: boolean; problem: string | null }>(`/m/slugs/${encodeURIComponent(slug)}`)
        .then((r) => setSlugCheck(r.available ? { state: 'ok', text: 'Available' } : { state: 'bad', text: r.problem ?? 'Not available' }))
        .catch(() => setSlugCheck({ state: 'idle' }));
    }, 400);
    return () => clearTimeout(id);
  }, [slug, p]);

  const pickHex = (raw: string) => {
    setHexDraft(raw.toUpperCase());
    const v = raw.startsWith('#') ? raw : `#${raw}`;
    if (parseHex(v)) setColour(v.toLowerCase());
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (slugCheck.state === 'bad') return void toast.error(`Shop link: ${slugCheck.text}`);
    setBusy(true);
    try {
      const saved = await api<MerchantProfile>('/m/profile', {
        method: 'PUT',
        body: {
          name, slug, colour, theme,
          tagline: tagline.trim() || null, paynow: paynow.trim() || null, fulfilmentNote: note.trim() || null, listed,
          logoUrl: logoUrl ?? null, coverUrl: coverUrl ?? null,
        },
      });
      markSaved();
      ctx.setProfile(saved);
      toast.success(setup ? 'Your shop is ready. Create your first drop.' : 'Saved. Live pages update within a minute.');
      if (setup) ctx.go({ view: 'new' });
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SLUG_TAKEN') setSlugCheck({ state: 'bad', text: err.message });
      ctx.onError(err);
    } finally {
      setBusy(false);
    }
  };

  const shopUrl = p?.slugClaimed ? absolute(`/s/${p.slug}/`) : null;
  const sample = ctx.drops?.find(d => d.state === 'Scheduled') ?? ctx.drops?.[0];
  const openAt = sample?.openAt ?? new Date(Date.now()+86400000).toISOString();
  const preview = <section className="flex flex-col gap-3"><p className="text-xs font-bold uppercase text-muted">Live buyer preview · {dirty ? 'unsaved changes' : 'saved branding'}</p><DropPreview drop={{ tenantId: p?.tenantId ?? '', dropId: sample?.dropId ?? '', merchant: { name: name || 'Your shop', tagline, colour, theme, logoUrl, coverUrl }, title: sample?.title ?? 'Your next drop', description: sample?.description ?? 'Your items and story appear here.', imageUrl: sample?.imageUrl, variants: sample?.variants ?? [{ id: 'sample', name: 'Your item', priceCents: 1200 }], openAt, endAt: sample?.endAt ?? openAt, entryOpensAt: new Date(Date.parse(openAt)-(sample?.entryWindowMin ?? 15)*60000).toISOString(), perBuyerLimit: sample?.perBuyerLimit ?? 2, holdSec: sample?.holdSec ?? 300, admitWindowSec: sample?.admitWindowSec ?? 120, verification: sample?.verification ?? 'email' }} /></section>;

  return (
    <form onSubmit={save} className="pb-40 lg:pb-12">
      <ViewHeader
        title={setup ? 'Set up your shop' : 'Shop'}
        sub={setup ? <span className="text-sm text-muted">Buyers see this on every drop page.</span> : undefined}
        actions={shopUrl && (
          <>
            <Button type="button" variant="outline" size="icon" aria-label="Share your shop" onClick={() => setShare({ title: name, url: shopUrl })}><Upload /></Button>
            <Button type="button" variant="ghost" className="hidden sm:inline-flex" asChild><a href={shopUrl} target="_blank" rel="noreferrer">View shop<ArrowUpRight /></a></Button>
          </>
        )}
      />
      <div className="grid gap-3.5 px-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,390px)] lg:items-start lg:gap-6 lg:px-8">
        <details className="rounded-2xl border border-line bg-surface p-4 lg:hidden"><summary className="cursor-pointer font-bold">Preview buyer page</summary><div className="mt-4">{preview}</div></details>
        <div className="flex flex-col gap-3.5">
          <Section title="Logo and cover">
            <ImagePicker
              kind="logo" label="Logo" value={logoUrl} onChange={setLogoUrl} help="Square works best. PNG, JPG or WebP."
              placeholder={<BrandScope colour={colour} dark={false} className="flex size-full items-center justify-center bg-brand font-display text-2xl font-extrabold text-brand-fg">{initials(name || 'Your shop')}</BrandScope>}
            />
            <ImagePicker
              kind="cover" label="Cover banner" value={coverUrl} onChange={setCoverUrl} help="Shown at the top of your shop and drop pages. Wide images work best, about 3:1."
              placeholder={<BrandScope colour={colour} dark={false} className="absolute inset-0"><BrandArt className="size-full" /></BrandScope>}
            />
          </Section>

          <Section title="Colour and theme">
            <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Brand colour">
              {SWATCHES.map(([hex, label]) => (
                <button
                  key={hex} type="button" role="radio" aria-checked={colour === hex} aria-label={label}
                  onClick={() => pickHex(hex)}
                  className={cn('size-11 cursor-pointer rounded-full border-[3px] border-surface shadow-[0_0_0_1px_var(--line)]', colour === hex && 'shadow-[0_0_0_2px_var(--ink)]')}
                  style={{ background: hex }}
                />
              ))}
              <label className="relative size-11 cursor-pointer overflow-hidden rounded-full border-[3px] border-surface shadow-[0_0_0_1px_var(--line)]" style={{ background: 'conic-gradient(#e11d48, #f2c94c, #0f766e, #1d4ed8, #6d28d9, #e11d48)' }}>
                <span className="sr-only">Pick any colour</span>
                <input type="color" value={colour} onChange={(e) => pickHex(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
              </label>
            </div>
            <Field label="Hex code"><Input value={hexDraft} onChange={(e) => pickHex(e.target.value)} spellCheck={false} maxLength={7} className="font-mono uppercase" /></Field>
            <p className="flex gap-2.5 rounded-xl bg-ok-tint px-3 py-2.5 text-[13px] leading-snug font-semibold text-ok-ink"><Check className="mt-0.5 size-4 shrink-0" strokeWidth={2.6} />{contrastNote(colour)}</p>
            <div className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Theme</span>
              <Segmented label="Page theme" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Match phone' }]} />
              <span className="text-[13px] font-medium text-muted">Match phone follows each buyer&apos;s light or dark setting.</span>
            </div>
          </Section>

          <Section title="Name and link">
            <Field label="Shop name"><Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tiong Bahru Sourdough Co." /></Field>
            <Field label="Tagline" help={`${tagline.length} / ${TAGLINE_MAX}`}>
              <Input maxLength={TAGLINE_MAX} value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Baked Saturday mornings" />
            </Field>
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Shop link</span>
              <span className={cn('flex h-12 items-center overflow-hidden rounded-xl border border-field bg-surface focus-within:border-brand-text', slugCheck.state === 'bad' && 'border-danger')}>
                <span className="flex h-full items-center bg-sunken px-3 text-[15px] font-semibold text-muted">/s/</span>
                <input
                  value={slug} required maxLength={40} spellCheck={false} autoCapitalize="none"
                  onChange={(e) => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); }}
                  className="h-full min-w-0 flex-1 bg-transparent px-3 text-base outline-none" aria-invalid={slugCheck.state === 'bad'}
                />
              </span>
              {slugCheck.state === 'checking' && <span className="flex items-center gap-1.5 text-[13px] text-muted"><Loader2 className="size-3.5 animate-spin" />Checking…</span>}
              {slugCheck.state === 'ok' && <span className="flex items-center gap-1.5 text-[13px] font-bold text-ok"><Check className="size-3.5" strokeWidth={2.8} />Available</span>}
              {slugCheck.state === 'bad' && <span className="flex items-center gap-1.5 text-[13px] font-bold text-danger" role="alert"><X className="size-3.5" strokeWidth={2.8} />{slugCheck.text}</span>}
              {slugCheck.state === 'idle' && p && <span className="text-[13px] font-medium text-muted">Changing it breaks links you have already shared.</span>}
            </label>
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl bg-bg p-3.5">
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">List my drops on the DropDeck homepage</span>
                <span className="text-[13px] text-muted">Your upcoming and live drops can appear under &ldquo;See a live drop&rdquo; on dropdeck&apos;s front page. Off unless you turn it on.</span>
              </span>
              <input type="checkbox" role="switch" checked={listed} onChange={(e) => setListed(e.target.checked)} className="peer sr-only" />
              <span aria-hidden className="relative mt-0.5 h-7 w-12 shrink-0 rounded-full bg-field transition peer-checked:bg-ok peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink after:absolute after:top-0.5 after:left-0.5 after:size-6 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5" />
            </label>
          </Section>

          <Section title="Payment and collection">
            <Field label="PayNow mobile or UEN" help="Shown to buyers on their confirmation. DropDeck never handles the payment.">
              <Input maxLength={40} value={paynow} onChange={(e) => setPaynow(e.target.value)} placeholder="+65 9123 4567 or 201912345A" />
            </Field>
            <Field label="Collection or delivery note">
              <Textarea maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Self-collect at Tiong Bahru, Saturday 2 to 5 pm" />
            </Field>
          </Section>
        </div>
        <div className="sticky top-8 hidden lg:block">{preview}</div>
      </div>

      <div className="fixed inset-x-0 bottom-[84px] z-20 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:px-8 lg:py-0">
        <Button type="submit" variant="ink" size="lg" className="w-full lg:w-auto" disabled={busy || slugCheck.state === 'checking'}>
          {busy ? 'Saving…' : setup ? 'Create my shop' : 'Save changes'}
        </Button>
      </div>
      <ShareSheet target={share} onClose={() => setShare(null)} />
    </form>
  );
}
