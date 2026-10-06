import type { CSSProperties } from 'react';

/**
 * Turns a merchant's brand colour into the colours a page can actually use, keeping every pairing readable:
 * button text is white unless the colour is too light for it (then near-black), the button fill is nudged until the
 * pair reaches 4.5:1, brand-coloured text is nudged until it reads on the page surface, and in dark mode a very dark
 * brand is lifted so it still stands out from the background.
 */

type Rgb = [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const INK: Rgb = [16, 17, 20];
const SURFACE = { light: WHITE, dark: [23, 24, 28] as Rgb };
const BG = { light: [244, 244, 246] as Rgb, dark: [13, 14, 17] as Rgb };

export const DEFAULT_BRAND = '#101114';

export function parseHex(hex: string | undefined): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim() ?? '');
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const rgba = (c: Rgb, a: number) => `rgba(${c.join(', ')}, ${a})`;
const mix = (c: Rgb, to: Rgb, p: number): Rgb => c.map((v, i) => Math.round(v + (to[i]! - v) * p)) as Rgb;

export function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Step towards `to` until `ok` holds (or the colour runs out of room). */
function nudge(c: Rgb, to: Rgb, ok: (c: Rgb) => boolean): Rgb {
  let out = c;
  for (let i = 0; i < 25 && !ok(out); i++) out = mix(out, to, 0.08);
  return out;
}

export interface BrandColours {
  /** Button and banner fill. */
  fill: string;
  /** Text on the fill. */
  fg: string;
  /** Brand-coloured text and icons on the page surface. */
  text: string;
  /** Light washes behind chips and icons. */
  tint: string;
  soft: string;
  /** Decorative shapes drawn on the fill. */
  art: string;
  /** True when the brand is light enough that buttons use dark text. */
  lightFill: boolean;
}

export function brandColours(hex: string | undefined, dark: boolean): BrandColours {
  const base = parseHex(hex) ?? parseHex(DEFAULT_BRAND)!;
  const mode = dark ? 'dark' : 'light';
  let lightFill = contrast(base, WHITE) < 3;
  let fg = lightFill ? INK : WHITE;
  let fill = nudge(base, lightFill ? WHITE : BLACK, (c) => contrast(c, fg) >= 4.5);
  if (dark && contrast(fill, BG.dark) < 3) {
    fill = nudge(fill, WHITE, (c) => contrast(c, BG.dark) >= 3);
    lightFill = contrast(fill, WHITE) < 4.5;
    fg = lightFill ? INK : WHITE;
  }
  const text = nudge(base, dark ? WHITE : BLACK, (c) => contrast(c, SURFACE[mode]) >= 4.5);
  return {
    fill: toHex(fill),
    fg: toHex(fg),
    text: toHex(text),
    tint: rgba(base, dark ? 0.22 : 0.12),
    soft: rgba(base, dark ? 0.12 : 0.06),
    art: rgba(lightFill ? INK : WHITE, lightFill ? 0.1 : 0.16),
    lightFill,
  };
}

/** CSS variables for a wrapper element; globals.css maps them onto bg-brand, text-brand-text and friends. */
export function brandStyle(hex: string | undefined, dark: boolean): CSSProperties {
  const c = brandColours(hex, dark);
  return {
    '--brand': c.fill, '--brand-fg': c.fg, '--brand-text': c.text, '--brand-tint': c.tint, '--brand-soft': c.soft, '--brand-art': c.art,
  } as CSSProperties;
}

/** A sentence for the console about how the colour will be used. */
export function contrastNote(hex: string): string {
  return brandColours(hex, false).lightFill
    ? 'Light colour, so buttons use dark text to stay readable.'
    : 'Readable. Buttons use white text, and the shade is adjusted slightly where needed.';
}

/** Two-letter monogram for a shop without a logo. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? 'DD').slice(0, 2);
  return letters.toUpperCase();
}
