export type DropState = 'Draft' | 'Scheduled' | 'Live' | 'Closed' | 'Cancelled';
export type VerificationMode = 'off' | 'email';
export type RatePreset = 'gentle' | 'normal' | 'fast';
export type HoldState = 'active' | 'confirmed' | 'released';
export type OrderStatus = 'confirmed' | 'paid' | 'no-show';

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
  slug: string;
  logoUrl?: string;
  colour?: string;
  /** PayNow mobile number or UEN shown on confirmation. */
  paynow?: string;
  fulfilmentNote?: string;
  tier: 'starter' | 'growth' | 'event';
}

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
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** Public subset written to drop.json. */
export interface PublicDrop {
  tenantId: string;
  dropId: string;
  merchant: Pick<MerchantProfile, 'name' | 'logoUrl' | 'colour'>;
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
