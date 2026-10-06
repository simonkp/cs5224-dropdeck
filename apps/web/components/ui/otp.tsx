'use client';

import { OTPInput, REGEXP_ONLY_DIGITS } from 'input-otp';
import { cn } from '../../lib/utils';

/** Six boxes for the email code; one real input underneath, so paste and SMS/email autofill work. */
export function CodeInput(props: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <OTPInput
      maxLength={6}
      value={props.value}
      onChange={props.onChange}
      disabled={props.disabled}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label="6-digit code"
      containerClassName="flex"
      render={({ slots }) => (
        <div className="grid w-full grid-cols-6 gap-2">
          {slots.map((slot, i) => (
            <div
              key={i}
              className={cn(
                'flex h-14 items-center justify-center rounded-[14px] border border-field bg-surface text-2xl font-extrabold tabular',
                slot.isActive && 'border-2 border-brand-text',
              )}
            >
              {slot.char ?? (slot.hasFakeCaret ? <span className="h-6 w-px animate-pulse bg-ink" /> : null)}
            </div>
          ))}
        </div>
      )}
    />
  );
}
