/**
 * Single-table key builders. The tenant ID leads every partition key.
 * See docs/decisions/0006-single-table-design.md.
 */
export const keys = {
  profile: (t: string) => ({ PK: `T#${t}`, SK: 'PROFILE' }),
  /** Holds a shop slug for one tenant (attribute tenantId), so two shops cannot share /s/{slug}/. */
  slug: (s: string) => ({ PK: `SLUG#${s}`, SK: 'SLUG' }),
  /** Per-tenant, per-day image upload counter (expires via ttl). */
  uploadQuota: (t: string, day: string) => ({ PK: `T#${t}`, SK: `UPLOADS#${day}` }),
  drop: (t: string, d: string) => ({ PK: `T#${t}`, SK: `DROP#${d}` }),
  dropPrefix: (t: string) => ({ PK: `T#${t}`, SKPrefix: 'DROP#' }),
  stockShard: (t: string, d: string, v: string, shard: number) => ({ PK: `S#${t}#${d}#${v}#${shard}`, SK: 'STOCK' }),
  ticketCounter: (t: string, d: string) => ({ PK: `Q#${t}#${d}`, SK: 'COUNTER#late' }),
  earlyCounter: (t: string, d: string, shard: number) => ({ PK: `Q#${t}#${d}`, SK: `COUNTER#early#${shard}` }),
  hold: (t: string, d: string, ticket: string) => ({ PK: `H#${t}#${d}#${ticket}`, SK: 'HOLD' }),
  holdIndex: (t: string, d: string) => `HOLDS#${t}#${d}`,
  buyerLimit: (t: string, d: string, emailHash: string) => ({ PK: `L#${t}#${d}#${emailHash}`, SK: 'LIMIT' }),
  order: (t: string, d: string, ref: string) => ({ PK: `T#${t}`, SK: `ORDER#${d}#${ref}` }),
  orderPrefix: (t: string, d: string) => ({ PK: `T#${t}`, SKPrefix: `ORDER#${d}#` }),
};

export const s3Keys = {
  dropJson: (t: string, d: string) => `d/${t}/${d}/drop.json`,
  stateJson: (t: string, d: string) => `d/${t}/${d}/state.json`,
  shopJson: (slug: string) => `s/${slug}/shop.json`,
  /** Uploaded images are content-addressed, so a key never changes meaning and can be cached for a year. */
  image: (t: string, hash: string, ext: string) => `b/${t}/${hash}.${ext}`,
};
