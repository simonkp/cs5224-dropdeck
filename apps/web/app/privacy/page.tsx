import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy · DropDeck' };

const H = ({ children }: { children: React.ReactNode }) => <h2 className="mt-6 font-display text-xl font-bold">{children}</h2>;

/** Plain-language notice for buyers and shops (PDPA). Decision 0014 sets the retention period. */
export default function Privacy() {
  return (
    <main className="mx-auto max-w-[640px] px-4 py-10 text-[15px] leading-relaxed text-ink">
      <a href="/" className="text-sm font-semibold text-muted no-underline">dropdeck</a>
      <h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight">Privacy</h1>
      <p className="mt-3 text-muted">DropDeck runs limited-stock drops for small shops. This page says what we keep about you, why, and for how long.</p>

      <H>If you buy in a drop</H>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li><strong>While you wait in the queue</strong>, nothing about you is sent to us. If you type your name and email early, they stay in your browser until you order (and for your next drop); &quot;Forget my details&quot; removes them.</li>
        <li><strong>When you reserve and check out</strong>, your name and email go to the shop running the drop so it can confirm and hand over your order. If the drop asks for an email code, we send it to that address and keep only a scrambled form of it, to stop one person ordering twice.</li>
        <li><strong>We never take card details.</strong> You pay the shop directly, for example by PayNow.</li>
        <li><strong>Orders are deleted 180 days after the drop ends.</strong> The shop may keep its own records (for example an export of its orders) under its own policy.</li>
      </ul>

      <H>If you run a shop</H>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li>We keep your sign-in email, your shop profile (name, logo, colours, PayNow details) and your drops and orders, to run your drops and bill your plan.</li>
        <li>You can ask us to delete your shop. We then remove your profile, drops, orders, uploaded images, shop page and sign-in.</li>
      </ul>

      <H>Where it is kept</H>
      <p className="mt-2">On Amazon Web Services in Singapore, encrypted at rest and only reachable over HTTPS. Only the shop that ran a drop, and DropDeck&apos;s operators when supporting that shop, can see its orders.</p>

      <H>Questions or requests</H>
      <p className="mt-2">Ask the shop you ordered from; it can reach us to correct or delete your data.</p>
    </main>
  );
}
