'use client';

import type { Drop, MerchantProfile } from '@dropdeck/shared';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import type { Route } from './shared';

const DISMISSED = 'dd.checklist.dismissed';
const SHARED = 'dd.checklist.shared';
const read = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };

/**
 * First steps for a new shop, each ticked off by what the shop has actually done. Hidden once all are done or the
 * merchant dismisses it (remembered in this browser).
 */
export function Checklist({ profile, drops, go, onShare }: { profile: MerchantProfile | null; drops: Drop[]; go: (r: Route) => void; onShare: (d: Drop) => void }) {
  const [dismissed, setDismissed] = useState(true);
  const [shared, setShared] = useState(false);
  useEffect(() => { setDismissed(read(DISMISSED)); setShared(read(SHARED)); }, []);

  const firstDraft = drops.find((d) => d.state === 'Draft');
  const firstPublished = drops.find((d) => d.state !== 'Draft');
  const steps: Array<{ label: string; done: boolean; action?: { label: string; run: () => void } }> = [
    { label: 'Set up your shop', done: Boolean(profile) },
    { label: 'Add your logo and colours', done: Boolean(profile?.logoUrl), action: { label: 'Brand it', run: () => go({ view: 'shop' }) } },
    { label: 'Create your first drop', done: drops.length > 0, action: { label: 'New drop', run: () => go({ view: 'new' }) } },
    { label: 'Schedule it', done: Boolean(firstPublished), action: firstDraft ? { label: 'Open draft', run: () => go({ view: 'edit', id: firstDraft.dropId }) } : undefined },
    { label: 'Share the link', done: shared, action: firstPublished ? { label: 'Share', run: () => { onShare(firstPublished); setShared(true); } } : undefined },
  ];
  const done = steps.filter((s) => s.done).length;
  if (dismissed || done === steps.length) return null;
  const next = steps.find((s) => !s.done);

  return (
    <section aria-label="Getting started" className="relative flex flex-col gap-4 overflow-hidden rounded-[20px] bg-[#101114] p-5 text-white">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold tracking-[0.1em] text-volt uppercase">Getting started · {done} of {steps.length}</span>
          <h2 className="font-display text-xl font-bold">Your first drop in a few minutes</h2>
        </div>
        <button type="button" aria-label="Hide getting started" onClick={() => { try { localStorage.setItem(DISMISSED, '1'); } catch { /* private mode */ } setDismissed(true); }} className="flex size-9 cursor-pointer items-center justify-center rounded-full text-[#a1a5ae] hover:bg-white/10 hover:text-white">
          <X className="size-4" />
        </button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-volt transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="flex flex-col gap-2">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-3">
            <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border-2', s.done ? 'border-volt bg-volt text-[#101114]' : 'border-white/30')}>
              {s.done && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <span className={cn('flex-1 text-sm', s.done ? 'text-[#a1a5ae] line-through' : 'font-semibold')}>{s.label}</span>
            {!s.done && s === next && s.action && (
              <Button size="sm" variant="volt" onClick={s.action.run}>{s.action.label}</Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
