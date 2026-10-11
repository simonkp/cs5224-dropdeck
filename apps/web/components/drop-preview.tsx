'use client';
import type { PublicDrop } from '@dropdeck/shared';
import { BrandScope, useDarkMode } from './brand';
import { CountdownCard, Hero, RuleChips, TitleBlock, VariantGrid } from '../app/d/parts';

/** Non-interactive preview, using the buyer page's actual visual components and current form values. */
export function DropPreview({ drop }: { drop: PublicDrop }) {
  const dark = useDarkMode(drop.merchant.theme);
  return <BrandScope colour={drop.merchant.colour} dark={dark} className="w-full overflow-hidden rounded-3xl border border-line bg-bg shadow-lg">
    <div className="border-b border-line bg-surface px-4 py-3"><strong>{drop.merchant.name}</strong><p className="text-xs text-muted">{drop.merchant.tagline}</p></div>
    <Hero drop={drop} />
    <div className="relative -mt-6 flex flex-col gap-4 rounded-t-3xl bg-bg p-4">
      <TitleBlock drop={drop} pill={<span className="text-xs font-bold uppercase text-brand-text">Buyer page preview</span>} />
      <CountdownCard drop={drop} msLeft={Math.max(0, Date.parse(drop.entryOpensAt)-Date.now())} />
      <RuleChips drop={drop} /><VariantGrid drop={drop} state={null} />
      <span className="rounded-2xl bg-brand p-4 text-center font-bold text-brand-fg">Add to calendar</span>
    </div>
  </BrandScope>;
}
