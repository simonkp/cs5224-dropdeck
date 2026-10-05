import { entryOpensAt } from './lifecycle.js';
import type { Drop, MerchantProfile, PublicDrop } from './types.js';

/** The public subset written to drop.json. */
export function toPublicDrop(drop: Drop, profile: MerchantProfile | undefined): PublicDrop {
  return {
    tenantId: drop.tenantId,
    dropId: drop.dropId,
    merchant: { name: profile?.name ?? 'DropDeck merchant', logoUrl: profile?.logoUrl, colour: profile?.colour },
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
