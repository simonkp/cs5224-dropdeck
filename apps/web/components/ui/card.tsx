import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-3xl border border-line bg-surface p-[18px]', className)} {...props} />;
}

/** Small uppercase label above a card's content. */
export function Eyebrow({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('text-[13px] font-bold uppercase tracking-[0.06em] text-muted', className)} {...props} />;
}

export function SectionTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('font-display text-xl font-bold tracking-tight', className)} {...props} />;
}
