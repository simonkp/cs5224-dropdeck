export type DropState = 'Draft' | 'Scheduled' | 'Live' | 'Closed' | 'Cancelled';
export type VerificationMode = 'off' | 'email';
export type RatePreset = 'gentle' | 'normal' | 'fast';
export type HoldState = 'active' | 'confirmed' | 'released';
export type OrderStatus = 'confirmed' | 'paid' | 'no-show';
/** How a merchant's buyer pages are themed; 'auto' follows each buyer's phone setting. */
export type ThemeMode = 'light' | 'dark' | 'auto';

export interface Variant {
  id: string;
  name: string;
  stock: number;
  /** Price in cents (SGD). */
  priceCents: number;
}

export interface MerchantProfile {
  tenantId: string;
  name: string;
  /** Unique across merchants (a SLUG# item guards it); the public shop page lives at /s/{slug}/. */
  slug: string;
  /** Root-relative path of an image this merchant uploaded (/b/{tenantId}/...). */
  logoUrl?: string;
  /** Brand colour, lowercase #rrggbb. */
  colour?: string;
  theme?: ThemeMode;
  /** Shop banner, an uploaded image path like logoUrl. */
  coverUrl?: string;
  tagline?: string;
  /** PayNow mobile number or UEN shown on confirmation. */
  paynow?: string;
  fulfilmentNote?: string;
  tier: 'starter' | 'growth' | 'event';
  /** Set once the slug is held by this tenant's SLUG# item; only then is s/{slug}/shop.json published. */
  slugClaimed?: boolean;
  /** The shop chose to have its drops listed on DropDeck's homepage (off unless the merchant turns it on). */
  listed?: boolean;
}

/** The branding every public page carries. `slug` is present only once the shop page exists. */
export type PublicMerchant = Pick<MerchantProfile, 'name' | 'logoUrl' | 'colour' | 'theme' | 'coverUrl' | 'tagline'> & { slug?: string };

export interface Drop {
  tenantId: string;
  dropId: string;
  state: DropState;
  title: string;
  description: string;
  imageUrl?: string;
  variants: Variant[];
  /** ISO timestamps. */
  openAt: string;
  endAt: string;
  /** Minutes before openAt when buyers may join the random draw. */
  entryWindowMin: number;
  /** Seconds after openAt during which joiners still enter the draw. */
  graceSec: number;
  perBuyerLimit: number;
  holdSec: number;
  /** Seconds an admitted buyer has to make a claim. */
  admitWindowSec: number;
  ratePreset: RatePreset;
  verification: VerificationMode;
  shardCount: number;
  /** Frozen size of the early (random draw) group, set when the draw closes. */
  earlyCount?: number;
  /** Set once the finished drop has been added to its shop's monthly usage. */
  meteredAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Public subset written to drop.json. */
export interface PublicDrop {
  tenantId: string;
  dropId: string;
  merchant: PublicMerchant;
  title: string;
  description: string;
  imageUrl?: string;
  variants: Array<Pick<Variant, 'id' | 'name' | 'priceCents'>>;
  openAt: string;
  endAt: string;
  entryOpensAt: string;
  perBuyerLimit: number;
  holdSec: number;
  /** Seconds an admitted buyer has to claim; the page shows it as a countdown. */
  admitWindowSec: number;
  verification: VerificationMode;
}

/** A shop's metered usage for one month, added to once per finished drop. */
export interface Usage {
  tenantId: string;
  /** yyyy-mm in Singapore time. */
  month: string;
  /** Drops that ran to the end. */
  drops: number;
  /** Drops cancelled after they were scheduled. */
  cancelled: number;
  /** Buyer sessions: everyone who took a queue ticket (the Growth tier's meter). */
  sessions: number;
  orders: number;
  units: number;
  revenueCents: number;
}

/** One drop as listed on the public shop page. */
export interface PublicShopDrop {
  dropId: string;
  /** Root-relative link to the drop page. */
  url: string;
  title: string;
  imageUrl?: string;
  state: 'Scheduled' | 'Live' | 'Closed';
  entryOpensAt: string;
  openAt: string;
  endAt: string;
  fromPriceCents: number;
}

/** A drop on DropDeck's homepage, with the shop it belongs to. */
export interface FeaturedDrop extends PublicShopDrop {
  shop: Pick<MerchantProfile, 'name' | 'slug' | 'logoUrl' | 'colour'>;
}

/** Written to p/featured.json: drops from shops that opted in to the homepage. */
export interface PublicFeatured {
  generatedAt: string;
  drops: FeaturedDrop[];
}

/** Written to s/{slug}/shop.json whenever the profile or one of the merchant's drops changes. */
export interface PublicShop {
  tenantId: string;
  merchant: PublicMerchant;
  generatedAt: string;
  drops: PublicShopDrop[];
}

/** Written to state.json by the controller; buyers poll it from CloudFront. */
export interface PublicState {
  state: DropState;
  serverTime: string;
  /** Admitted share of the early group, 0..1. */
  rThreshold: number;
  /** Admitted count of late (sequential) tickets. */
  nWatermark: number;
  earlyCount: number | null;
  soldOut: Record<string, boolean>;
}

/** One per ticket (holdId = ticketId), so a retried claim cannot reserve twice. */
export interface Hold {
  tenantId: string;
  dropId: string;
  holdId: string;
  variantId: string;
  qty: number;
  /** Stock shard the units came from; a release returns them there. */
  shard: number;
  state: HoldState;
  /** Epoch ms. Checked on read and swept by the controller; DynamoDB TTL is only a backstop. */
  createdAt: number;
  expiresAt: number;
  /** Set when the hold is confirmed, so a retried confirm can rebuild the order. */
  orderRef?: string;
  name?: string;
  email?: string;
  /** Email code (decision 0002): keyed hash of the current code, the normalised address it went to, limits. */
  otpHash?: string;
  otpEmail?: string;
  otpExpiresAt?: number;
  otpSends?: number;
  otpLastSentAt?: number;
  otpAttempts?: number;
}

export interface Order {
  tenantId: string;
  dropId: string;
  ref: string;
  holdId: string;
  variantId: string;
  variantName: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  name: string;
  email: string;
  status: OrderStatus;
  createdAt: string;
}
