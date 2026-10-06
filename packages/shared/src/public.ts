import { entryOpensAt } from './lifecycle.js';
import type { Drop, MerchantProfile, PublicDrop, PublicMerchant, PublicShop, PublicShopDrop } from './types.js';

/** The branding a public page shows; never the PayNow number or anything internal. */
export function publicMerchant(profile: MerchantProfile | undefined): PublicMerchant {
  return {
    name: profile?.name ?? 'DropDeck merchant',
    slug: profile?.slugClaimed ? profile.slug : undefined,
    logoUrl: profile?.logoUrl,
    colour: profile?.colour,
    theme: profile?.theme ?? 'auto',
    coverUrl: profile?.coverUrl,
    tagline: profile?.tagline,
  };
}

/** The public subset written to drop.json. */
export function toPublicDrop(drop: Drop, profile: MerchantProfile | undefined): PublicDrop {
  return {
    tenantId: drop.tenantId,
    dropId: drop.dropId,
    merchant: publicMerchant(profile),
    title: drop.title,
    description: drop.description,
    imageUrl: drop.imageUrl,
    variants: drop.variants.map(({ id, name, priceCents }) => ({ id, name, priceCents })),
    openAt: drop.openAt,
    endAt: drop.endAt,
    entryOpensAt: entryOpensAt(drop).toISOString(),
    perBuyerLimit: drop.perBuyerLimit,
    holdSec: drop.holdSec,
    admitWindowSec: drop.admitWindowSec,
    verification: drop.verification,
  };
}

const MAX_UPCOMING = 20;
const MAX_PAST = 6;
const PAST_WINDOW_MS = 30 * 24 * 3600_000;

/**
 * shop.json: Live drops first, then Scheduled soonest first, then drops that ended in the last 30 days, newest first.
 * Drafts and cancelled drops never appear.
 */
export function toPublicShop(profile: MerchantProfile, drops: Drop[], now = new Date()): PublicShop {
  const entry = (d: Drop): PublicShopDrop => ({
    dropId: d.dropId,
    url: `/d/${d.tenantId}/${d.dropId}/`,
    title: d.title,
    imageUrl: d.imageUrl,
    state: d.state as PublicShopDrop['state'],
    entryOpensAt: entryOpensAt(d).toISOString(),
    openAt: d.openAt,
    endAt: d.endAt,
    fromPriceCents: Math.min(...d.variants.map((v) => v.priceCents)),
  });
  const byOpen = (a: Drop, b: Drop) => a.openAt.localeCompare(b.openAt);
  const live = drops.filter((d) => d.state === 'Live').sort(byOpen);
  const upcoming = drops.filter((d) => d.state === 'Scheduled').sort(byOpen).slice(0, MAX_UPCOMING);
  const past = drops
    .filter((d) => d.state === 'Closed' && now.getTime() - Date.parse(d.endAt) <= PAST_WINDOW_MS)
    .sort((a, b) => b.endAt.localeCompare(a.endAt))
    .slice(0, MAX_PAST);
  return {
    tenantId: profile.tenantId,
    merchant: publicMerchant(profile),
    generatedAt: now.toISOString(),
    drops: [...live, ...upcoming, ...past].map(entry),
  };
}
