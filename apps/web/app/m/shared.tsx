'use client';

import type { Drop, MerchantProfile } from '@dropdeck/shared';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, LiveDot } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export type Route =
  | { view: 'drops' } | { view: 'new' } | { view: 'edit'; id: string } | { view: 'orders'; id: string }
  | { view: 'shop' } | { view: 'account' } | { view: 'analytics' };

/** What every console view gets from the shell. */
export interface ConsoleCtx {
  profile: MerchantProfile | null;
  drops: Drop[] | null;
  refresh: () => Promise<void>;
  go: (r: Route) => void;
  onError: (e: unknown) => void;
  setProfile: (p: MerchantProfile) => void;
}

export const dropUrl = (d: Pick<Drop, 'tenantId' | 'dropId'>) => `/d/${d.tenantId}/${d.dropId}/`;
export const absolute = (path: string) => new URL(path, window.location.origin).toString();

/** Mirrors isLockedForEdit in packages/shared/src/lifecycle.ts. */
export const entryOpened = (d: Drop) => Date.now() >= Date.parse(d.openAt) - d.entryWindowMin * 60_000;

export function StateBadge({ state }: { state: Drop['state'] }) {
  if (state === 'Live') return <Badge tone="live"><LiveDot className="size-[7px] text-white" />LIVE</Badge>;
  if (state === 'Scheduled') return <Badge tone="info">Scheduled</Badge>;
  if (state === 'Cancelled') return <Badge tone="danger">Cancelled</Badge>;
  return <Badge tone="muted">{state === 'Closed' ? 'Ended' : 'Draft'}</Badge>;
}

/** Top of each console view: big title on lists, back arrow + small title inside a drop. */
export function ViewHeader(props: { title: ReactNode; back?: () => void; actions?: ReactNode; sub?: ReactNode; className?: string }) {
  if (props.back) {
    return (
      <header className={cn('sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur lg:static lg:border-0 lg:bg-transparent', props.className)}>
        <div className="flex min-h-[60px] items-center gap-1 px-2 lg:px-8 lg:pt-8">
          <Button variant="ghost" size="icon" aria-label="Back" onClick={props.back}><ChevronLeft className="size-[22px]" strokeWidth={2.2} /></Button>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-[17px] font-bold lg:font-display lg:text-[30px] lg:font-extrabold lg:tracking-tight">{props.title}</h1>
            {props.sub}
          </div>
          {props.actions && <div className="flex shrink-0 items-center gap-2 pr-2">{props.actions}</div>}
        </div>
      </header>
    );
  }
  return (
    <header className={cn('flex items-center justify-between gap-3 px-4 pt-4 pb-3 lg:px-8 lg:pt-8', props.className)}>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[32px] leading-none font-extrabold tracking-[-0.025em] lg:text-4xl">{props.title}</h1>
        {props.sub}
      </div>
      {props.actions && <div className="flex items-center gap-2">{props.actions}</div>}
    </header>
  );
}
