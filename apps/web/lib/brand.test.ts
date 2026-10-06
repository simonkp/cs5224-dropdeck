import { describe, expect, it } from 'vitest';
import { brandColours, contrast, initials, parseHex } from './brand';

const ratio = (a: string, b: string) => contrast(parseHex(a)!, parseHex(b)!);

describe('brand colours', () => {
  it('keeps button text readable for any brand, light or dark page', () => {
    for (const hex of ['#b5651d', '#0f766e', '#e11d48', '#6d28d9', '#f2c94c', '#101114', '#ffffff', '#00ff00', '#1d4ed8']) {
      for (const dark of [false, true]) {
        const c = brandColours(hex, dark);
        expect(ratio(c.fill, c.fg), `${hex} dark=${dark}`).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c.text, dark ? '#17181c' : '#ffffff'), `${hex} text dark=${dark}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses white text on a mid-tone brand and dark text on a light one', () => {
    expect(brandColours('#b5651d', false).fg).toBe('#ffffff');
    expect(brandColours('#f2c94c', false)).toMatchObject({ fg: '#101114', lightFill: true });
  });

  it('lifts a near-black brand so it stands out on a dark page', () => {
    expect(ratio(brandColours('#101114', true).fill, '#0d0e11')).toBeGreaterThanOrEqual(3);
  });

  it('falls back to the default for a missing or broken colour', () => {
    expect(brandColours(undefined, false).fill).toBe(brandColours('#101114', false).fill);
    expect(brandColours('red', false).fill).toBe(brandColours('#101114', false).fill);
  });
});

describe('initials', () => {
  it('takes the first letters of the first two words', () => {
    expect(initials('Tiong Bahru Sourdough Co.')).toBe('TB');
    expect(initials('kopi')).toBe('KO');
    expect(initials('')).toBe('DD');
  });
});
