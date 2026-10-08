'use client';

import { useEffect, useState } from 'react';
import { Mark } from '../../components/mark';
import { cn } from '../../lib/utils';
import { SignInLink, StartButton } from './StartButton';

/**
 * Stays at the top while the page scrolls: see-through over the dark hero, then a solid, blurred bar once the
 * visitor scrolls, so Sign in and Start are always one tap away on a long phone page.
 */
export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 24);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <nav
      aria-label="Main"
      className={cn(
        'fixed inset-x-0 top-0 z-40 transition-[background-color,border-color,box-shadow] duration-200',
        scrolled ? 'border-b border-white/10 bg-[#0b0c0f]/85 shadow-[0_8px_24px_rgba(0,0,0,0.25)] backdrop-blur-md' : 'border-b border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-5 sm:h-[72px]">
        <a href="/" className="flex items-center gap-2.5 text-[#f3f3f5] no-underline"><Mark /><span className="font-display text-xl font-extrabold tracking-tight">dropdeck</span></a>
        <div className="flex items-center gap-4 text-sm text-[#c7cad1] sm:gap-6">
          <a href="#how" className="hidden text-inherit no-underline hover:text-white md:inline">How it works</a>
          <a href="#live" className="hidden text-inherit no-underline hover:text-white md:inline">Live drops</a>
          <a href="#pricing" className="hidden text-inherit no-underline hover:text-white md:inline">Pricing</a>
          <SignInLink className="text-[#f3f3f5] hover:text-volt" />
          <StartButton className="h-10 rounded-xl px-4 text-sm [&_svg]:size-4">
            <span className="sm:hidden">Start</span><span className="hidden sm:inline">Start your shop</span>
          </StartButton>
        </div>
      </div>
    </nav>
  );
}
