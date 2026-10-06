import { ArrowRight } from 'lucide-react';

export default function Home() {
  return (
    <main className="flex min-h-dvh flex-col bg-[#101114] px-5 text-[#f3f3f5]">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 py-16">
        <span className="font-display text-xl font-extrabold">dropdeck</span>
        <h1 className="font-display text-5xl leading-[0.98] font-extrabold tracking-[-0.03em]">Fair drops for small shops.</h1>
        <p className="text-lg leading-relaxed text-[#a1a5ae]">A countdown, a random-draw waiting room, and stock that cannot oversell. Buyers need no account.</p>
        <a href="/m/" className="inline-flex h-14 items-center gap-2 self-start rounded-2xl bg-volt px-6 text-[17px] font-extrabold text-[#101114] no-underline">
          Merchant console<ArrowRight className="size-5" strokeWidth={2.4} />
        </a>
      </div>
    </main>
  );
}
