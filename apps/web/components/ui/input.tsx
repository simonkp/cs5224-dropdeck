import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

const field = 'w-full rounded-xl border border-field bg-surface px-3.5 text-base text-ink placeholder:text-muted/70 outline-none transition focus:border-brand-text focus:ring-2 focus:ring-brand-tint disabled:opacity-60 aria-invalid:border-danger';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-12', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-24 resize-y py-3 leading-relaxed', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(field, 'h-12', className)} {...props} />;
}

/** Label + control + help or error, stacked. Wraps the control so the label is tied to it. */
export function Field({ label, help, error, className, children }: { label: ReactNode; help?: ReactNode; error?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cn('flex flex-col gap-1.5 text-sm font-semibold', className)}>
      <span>{label}</span>
      {children}
      {error ? <span className="text-[13px] font-semibold text-danger" role="alert">{error}</span> : help ? <span className="text-[13px] font-medium text-muted">{help}</span> : null}
    </label>
  );
}
