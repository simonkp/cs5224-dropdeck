'use client';

import type { PublicMerchant, ThemeMode } from '@dropdeck/shared';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useAssetUrl } from '../lib/assets';
import { brandColours, brandStyle, initials } from '../lib/brand';
import { cn } from '../lib/utils';

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(q.matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return dark;
}

/** Whether a merchant's pages render dark: their choice, or the buyer's phone setting for 'auto'. */
export function useDarkMode(theme: ThemeMode | undefined): boolean {
  const prefersDark = usePrefersDark();
  return theme === 'dark' || ((theme ?? 'auto') === 'auto' && prefersDark);
}

/**
 * Applies a merchant's brand to the whole document (a buyer page is all one shop): brand colours as CSS variables,
 * dark mode as a class, and the browser chrome colour.
 */
export function useDocumentBrand(merchant: Pick<PublicMerchant, 'colour' | 'theme'> | undefined): boolean {
  const dark = useDarkMode(merchant?.theme);
  useEffect(() => {
    if (!merchant) return;
    const root = document.documentElement;
    const vars = brandStyle(merchant.colour, dark) as Record<string, string>;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.classList.toggle('dark', dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', dark ? '#0d0e11' : '#f4f4f6');
  }, [merchant, dark]);
  return dark;
}

/** The same, scoped to one element: the console's live preview. */
export function BrandScope(props: { colour?: string; dark: boolean; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className={cn(props.dark && 'dark', 'bg-bg text-ink', props.className)} style={{ ...brandStyle(props.colour, props.dark), ...props.style }}>
      {props.children}
    </div>
  );
}

/** The shop's logo, or its initials on the brand colour when there is none. */
export function ShopLogo(props: { merchant: Pick<PublicMerchant, 'name' | 'logoUrl'>; className?: string }) {
  const src = useAssetUrl(props.merchant.logoUrl);
  const base = cn('flex size-[38px] shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand font-display text-sm font-extrabold text-brand-fg', props.className);
  if (src) return <img src={src} alt="" className={cn(base, 'object-cover')} />;
  return <span aria-hidden className={base}>{initials(props.merchant.name)}</span>;
}

/** A photo, or the brand's colour with soft shapes when there is none. */
export function BrandArt(props: { src?: string; className?: string; label?: string; children?: ReactNode }) {
  const src = useAssetUrl(props.src);
  return (
    <div className={cn('relative overflow-hidden bg-brand', props.className)}>
      {src ? (
        <img src={src} alt={props.label ?? ''} className="absolute inset-0 size-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none" />
      ) : (
        <div aria-hidden>
          <div className="absolute -top-[90px] -left-[60px] size-[260px] rounded-full bg-brand-art" />
          <div className="absolute top-10 -right-8 size-[180px] rotate-[18deg] rounded-[48px] bg-brand-art opacity-70" />
          <div className="absolute top-[70px] left-[40%] size-[90px] rounded-full border-[10px] border-brand-art" />
        </div>
      )}
      {props.children}
    </div>
  );
}

export { brandColours };
