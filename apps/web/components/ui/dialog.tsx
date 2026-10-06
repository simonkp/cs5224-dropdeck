'use client';

import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './button';

/**
 * Radix dialog styled two ways: a bottom sheet on phones and a centred card on wider screens (shadcn's Drawer/Dialog
 * pair in one component).
 */
export function Sheet(props: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <D.Root open={props.open} onOpenChange={props.onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[#101114]/45" />
        <D.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-[28px] bg-surface px-5 pt-2.5 pb-[max(2rem,env(safe-area-inset-bottom))] text-ink shadow-2xl outline-none',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[440px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[28px] sm:pt-5',
            props.className,
          )}
        >
          <span aria-hidden className="mx-auto mb-3 block h-[5px] w-10 rounded-full bg-field sm:hidden" />
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <D.Title className="font-display text-[22px] leading-tight font-extrabold">{props.title}</D.Title>
              {props.description ? <D.Description className="text-sm text-muted">{props.description}</D.Description> : <D.Description className="sr-only">{props.title}</D.Description>}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon" className="rounded-full bg-sunken" aria-label="Close"><X strokeWidth={2.4} /></Button>
            </D.Close>
          </div>
          {props.children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Replaces window.confirm(): a sheet with a clear yes and no. */
export function ConfirmSheet(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description}>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" className="sm:h-11 sm:rounded-xl sm:text-sm" onClick={() => props.onOpenChange(false)}>Keep it</Button>
        <Button variant={props.danger ? 'danger' : 'ink'} size="lg" className={cn('sm:h-11 sm:rounded-xl sm:text-sm', props.danger && 'border-danger bg-danger text-white hover:bg-danger')} disabled={props.busy} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </div>
    </Sheet>
  );
}
