import type { ThemeMode } from './types.js';

/**
 * Rules for merchant branding, shared by the API (which enforces them) and the console (which checks as you type).
 * Pure: no SDK imports, so the web bundle can use it.
 */

/** 3-40 characters, lowercase letters, digits and inner hyphens. No dots, so /s/{slug}/ never looks like a file. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Slugs that would read as part of DropDeck itself rather than a shop. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'index', 'api', 'm', 'd', 's', 'b', 'admin', 'dropdeck', 'www', 'help', 'support', 'login', 'signin', 'signup',
  'config', 'static', 'assets', 'shop', 'shops', 'drops', 'about', 'terms', 'privacy',
]);

export const COLOUR_RE = /^#[0-9a-f]{6}$/;

export const THEMES: readonly ThemeMode[] = ['light', 'dark', 'auto'];

export const TAGLINE_MAX = 140;

/** Why a slug cannot be used, or null if it can (availability aside). */
export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return 'Use 3-40 lowercase letters, numbers and hyphens, starting and ending with a letter or number';
  if (RESERVED_SLUGS.has(slug)) return 'That name is reserved';
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches an image this tenant uploaded through POST /m/uploads, and nothing else. */
export function uploadPathRe(t: string): RegExp {
  return new RegExp(`^/b/${escapeRe(t)}/[a-f0-9]{32}\\.(png|jpg|webp)$`);
}
