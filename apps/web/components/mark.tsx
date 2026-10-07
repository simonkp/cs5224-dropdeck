import { Download } from 'lucide-react';
import { cn } from '../lib/utils';

/** DropDeck's own mark: a volt tile with a drop-down arrow. */
export const Mark = ({ className }: { className?: string }) => (
  <span className={cn('flex size-[30px] items-center justify-center rounded-[9px] bg-volt text-[#101114]', className)}>
    <Download className="size-[18px]" strokeWidth={2.6} />
  </span>
);
