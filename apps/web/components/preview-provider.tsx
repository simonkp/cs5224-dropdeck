'use client';
import { useEffect, useState, type ReactNode } from 'react';

/** The demo branch is present only in local development or the explicit review build. */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [gallery, setGallery] = useState<ReactNode>(null);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DROPDECK_DEMO === '1') {
      import('../lib/preview/local').then((m) => {
        m.install();
        if (location.pathname === '/__preview/') setGallery(<m.Gallery />);
        setReady(true);
      });
    }
  }, []);
  if (process.env.NEXT_PUBLIC_DROPDECK_DEMO === '1') {
    if (!ready) return <p className="p-6">Preparing local preview…</p>;
    return <><div className="relative z-40 flex flex-wrap items-center justify-center gap-x-4 bg-[#d4ff3a] px-3 py-2 text-xs font-bold text-[#101114]">DESIGN REVIEW · simulated data<a className="underline" href="/__preview/">Scenarios & reset</a></div>{gallery ?? children}</>;
  }
  return children;
}
