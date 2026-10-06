import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

/** shadcn-style button. `brand` follows the merchant's colour; `ink` and `volt` are DropDeck's own. */
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-bold transition-[opacity,transform,background-color] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        brand: 'bg-brand text-brand-fg hover:opacity-95',
        ink: 'bg-ink text-bg hover:opacity-90',
        volt: 'bg-volt text-[#101114] hover:brightness-95',
        outline: 'border border-line bg-surface text-ink hover:bg-sunken',
        ghost: 'text-ink hover:bg-sunken',
        danger: 'border border-line bg-surface text-danger hover:bg-danger-tint',
        link: 'h-auto px-0 font-semibold text-brand-text underline underline-offset-4',
      },
      size: {
        lg: 'h-14 rounded-2xl px-6 text-[17px] [&_svg]:size-5',
        md: 'h-11 rounded-xl px-4 text-sm [&_svg]:size-4',
        sm: 'h-9 rounded-[10px] px-3 text-[13px] [&_svg]:size-4',
        icon: 'size-11 rounded-[14px] [&_svg]:size-5',
      },
    },
    defaultVariants: { variant: 'brand', size: 'md' },
  },
);

export function Button({ className, variant, size, asChild, ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
