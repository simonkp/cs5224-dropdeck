'use client';

import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { signIn } from '../../lib/auth';
import { message } from '../../lib/format';
import { cn } from '../../lib/utils';

/** Opens Cognito's create-account screen; after sign-up the console walks the new shop through setup. */
export function StartButton({ className, children = 'Start your shop', variant = 'volt' }: { className?: string; children?: React.ReactNode; variant?: 'volt' | 'ink' }) {
  return (
    <button
      type="button"
      onClick={() => signIn('/m/', 'signup').catch((e) => toast.error(message(e)))}
      className={cn(
        'inline-flex h-14 cursor-pointer items-center justify-center gap-2 rounded-2xl px-6 text-[17px] font-extrabold transition active:scale-[0.98]',
        variant === 'volt' ? 'bg-volt text-[#101114] hover:brightness-95' : 'bg-[#101114] text-white hover:opacity-90',
        className,
      )}
    >
      {children}<ArrowRight className="size-5" strokeWidth={2.4} />
    </button>
  );
}

export function SignInLink({ className }: { className?: string }) {
  return (
    <button type="button" onClick={() => signIn('/m/').catch((e) => toast.error(message(e)))} className={cn('cursor-pointer font-bold', className)}>
      Sign in
    </button>
  );
}
