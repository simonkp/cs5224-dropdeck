import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva('inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-extrabold whitespace-nowrap', {
  variants: {
    tone: {
      live: 'bg-ok text-white',
      info: 'bg-info-tint text-info',
      muted: 'bg-sunken text-muted',
      danger: 'bg-danger-tint text-danger',
      warn: 'bg-warn-tint text-warn',
      brand: 'bg-brand-tint text-brand-text',
    },
  },
  defaultVariants: { tone: 'muted' },
});

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** The pulsing dot used on LIVE badges and "queue open" pills. */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('size-2 rounded-full bg-current animate-pulse-dot', className)} />;
}
