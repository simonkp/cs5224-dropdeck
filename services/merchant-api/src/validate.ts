import {
  ApiError, COLOUR_RE, slugProblem, TAGLINE_MAX, THEMES, uploadPathRe,
  type Drop, type MerchantProfile, type RatePreset, type Variant, type VerificationMode,
} from '@dropdeck/shared';

export type DropInput = Pick<
  Drop,
  | 'title' | 'description' | 'imageUrl' | 'variants' | 'openAt' | 'endAt' | 'entryWindowMin' | 'graceSec'
  | 'perBuyerLimit' | 'holdSec' | 'admitWindowSec' | 'ratePreset' | 'verification' | 'shardCount'
>;

export const DEFAULTS = {
  description: '',
  entryWindowMin: 15,
  graceSec: 30,
  perBuyerLimit: 2,
  holdSec: 300,
  admitWindowSec: 120,
  ratePreset: 'normal' as RatePreset,
  verification: 'email' as VerificationMode,
  shardCount: 4,
};

const fail = (msg: string): never => {
  throw new ApiError('VALIDATION', msg);
};

const str = (v: unknown, name: string, min: number, max: number): string => {
  if (typeof v !== 'string') return fail(`${name} must be text`);
  const s = v.trim();
  if (s.length < min || s.length > max) fail(`${name} must be ${min}-${max} characters`);
  return s;
};

const int = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return v as number;
};

const iso = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(`${name} must be an ISO date-time`);
  return new Date(v as string).toISOString();
};

const oneOf = <T extends string>(v: unknown, name: string, options: readonly T[]): T => {
  if (!options.includes(v as T)) fail(`${name} must be one of ${options.join(', ')}`);
  return v as T;
};

function variants(v: unknown): Variant[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 10) fail('variants must list 1-10 items');
  const seen = new Set<string>();
  return (v as unknown[]).map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const id = o.id === undefined ? `v${i + 1}` : str(o.id, 'variant id', 1, 24);
    if (seen.has(id)) fail(`duplicate variant id ${id}`);
    seen.add(id);
    return {
      id,
      name: str(o.name, 'variant name', 1, 60),
      stock: int(o.stock, 'variant stock', 1, 10_000),
      priceCents: int(o.priceCents, 'variant price', 0, 10_000_000),
    };
  });
}

/**
 * A drop image is one this tenant uploaded (/b/{t}/...), or, for drops made before uploads existed, an https URL.
 * '' or null clears it (the key stays in the result with an undefined value, so a PATCH removes the image).
 */
function imageUrl(v: unknown, t: string | undefined): string | undefined {
  if (v === null || v === '') return undefined;
  const s = str(v, 'imageUrl', 1, 500);
  if (t && uploadPathRe(t).test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/.test(s)) return s;
  return fail('imageUrl must be an uploaded image or an https link');
}

/** Full validation for create; `partial` validates only the fields present (PATCH). `t` is the caller's tenant. */
export function validateDropInput(body: Record<string, unknown>, partial = false, t?: string): Partial<DropInput> {
  const out: Partial<DropInput> = {};
  const has = (k: string) => body[k] !== undefined;
  const req = (k: string) => !partial || has(k);

  if (req('title')) out.title = str(body.title, 'title', 1, 120);
  if (has('description')) out.description = str(body.description, 'description', 0, 2000);
  if (body.imageUrl !== undefined) out.imageUrl = imageUrl(body.imageUrl, t);
  if (req('variants')) out.variants = variants(body.variants);
  if (req('openAt')) out.openAt = iso(body.openAt, 'openAt');
  if (req('endAt')) out.endAt = iso(body.endAt, 'endAt');
  if (has('entryWindowMin')) out.entryWindowMin = int(body.entryWindowMin, 'entryWindowMin', 0, 60);
  if (has('graceSec')) out.graceSec = int(body.graceSec, 'graceSec', 0, 120);
  if (has('perBuyerLimit')) out.perBuyerLimit = int(body.perBuyerLimit, 'perBuyerLimit', 1, 10);
  if (has('holdSec')) out.holdSec = int(body.holdSec, 'holdSec', 120, 900);
  if (has('admitWindowSec')) out.admitWindowSec = int(body.admitWindowSec, 'admitWindowSec', 30, 600);
  if (has('ratePreset')) out.ratePreset = oneOf(body.ratePreset, 'ratePreset', ['gentle', 'normal', 'fast'] as const);
  if (has('verification')) out.verification = oneOf(body.verification, 'verification', ['off', 'email'] as const);
  if (has('shardCount')) out.shardCount = int(body.shardCount, 'shardCount', 1, 16);

  if (out.openAt && out.endAt) {
    const span = Date.parse(out.endAt) - Date.parse(out.openAt);
    if (span <= 0) fail('endAt must be after openAt');
    if (span > 24 * 3600_000) fail('a drop can last at most 24 hours');
  }
  return out;
}

type ProfileField = 'name' | 'slug' | 'logoUrl' | 'coverUrl' | 'colour' | 'theme' | 'tagline' | 'paynow' | 'fulfilmentNote' | 'listed';

/** PUT /m/profile body. A field left out keeps its value; null (or '') clears an optional field. */
export type ProfilePatch = { [K in ProfileField]?: MerchantProfile[K] | null };

export function validateProfileInput(body: Record<string, unknown>, t: string): ProfilePatch {
  const out: ProfilePatch = {};
  const clear = (k: ProfileField) => body[k] === null || body[k] === '';
  const optional = (k: ProfileField, check: (v: unknown) => string) => {
    if (body[k] === undefined) return;
    (out as Record<string, unknown>)[k] = clear(k) ? null : check(body[k]);
  };
  const image = (name: string) => (v: unknown) => {
    const s = str(v, name, 1, 300);
    return uploadPathRe(t).test(s) ? s : fail(`${name} must be an image uploaded to your shop`);
  };

  if (body.name !== undefined) out.name = str(body.name, 'name', 1, 80);
  if (body.slug !== undefined) {
    const slug = str(body.slug, 'slug', 1, 40).toLowerCase();
    const problem = slugProblem(slug);
    if (problem) fail(`Shop link: ${problem}`);
    out.slug = slug;
  }
  optional('logoUrl', image('logoUrl'));
  optional('coverUrl', image('coverUrl'));
  optional('colour', (v) => {
    const c = str(v, 'colour', 7, 7).toLowerCase();
    return COLOUR_RE.test(c) ? c : fail('colour must look like #1f6feb');
  });
  optional('theme', (v) => oneOf(v, 'theme', THEMES));
  optional('tagline', (v) => str(v, 'tagline', 1, TAGLINE_MAX));
  optional('paynow', (v) => str(v, 'paynow', 1, 40));
  optional('fulfilmentNote', (v) => str(v, 'fulfilmentNote', 1, 300));
  if (body.listed !== undefined) {
    if (typeof body.listed !== 'boolean') fail('listed must be true or false');
    out.listed = body.listed as boolean;
  }
  return out;
}

/** Extra checks applied when a merchant schedules a drop. */
export function assertSchedulable(drop: Drop, now: Date): void {
  const entry = Date.parse(drop.openAt) - drop.entryWindowMin * 60_000;
  // The open fires OPEN_LEAD_MS (90 s) before the entry window and must still be comfortably in the future.
  if (entry - now.getTime() < 180_000) fail('openAt must leave at least three minutes before the entry window opens');
  if (drop.variants.reduce((n, v) => n + v.stock, 0) < 1) fail('a drop needs stock to schedule');
}

/** Moved to the shared package: the claim path derives each shard's capacity from the drop config. */
export { shardCapacities } from '@dropdeck/shared';
