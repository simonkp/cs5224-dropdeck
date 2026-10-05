import { createHmac } from 'node:crypto';

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * Normalise an email so the per-buyer limit is not trivially bypassed:
 * lower-case, strip +suffix, and drop dots in Gmail local parts.
 */
export function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) throw new Error('Invalid email');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

/** Keyed hash: buyers who never confirm leave only this. */
export function emailHash(normalised: string, key: string): string {
  return createHmac('sha256', key).update(normalised).digest('base64url').slice(0, 32);
}

export function isPlausibleEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}
