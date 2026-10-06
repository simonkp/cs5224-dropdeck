import { describe, expect, it } from 'vitest';
import { decodeImage, MAX_IMAGE_BYTES } from '../src/images.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pad = (head: number[] | Buffer, size = 200) => Buffer.concat([Buffer.from(head), Buffer.alloc(size - head.length, 1)]);
const webp = () => { const b = pad(Buffer.from('RIFF0000WEBPVP8 ')); return b; };

describe('decodeImage', () => {
  it('recognises PNG, JPEG and WebP from their bytes, whatever the data URL claims', () => {
    expect(decodeImage(pad(PNG).toString('base64')).ext).toBe('png');
    expect(decodeImage(`data:image/png;base64,${pad([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`)).toMatchObject({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(decodeImage(webp().toString('base64')).ext).toBe('webp');
  });

  it('gives the same bytes the same 32-character hash', () => {
    const a = decodeImage(pad(PNG).toString('base64'));
    const b = decodeImage(pad(PNG).toString('base64'));
    expect(a.hash).toMatch(/^[a-f0-9]{32}$/);
    expect(a.hash).toBe(b.hash);
  });

  it('refuses GIF, SVG, HEIC-like and random bytes', () => {
    for (const bytes of [pad(Buffer.from('GIF89a')), pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), pad(Buffer.from('....ftypheic')), pad([1, 2, 3])]) {
      expect(() => decodeImage(bytes.toString('base64'))).toThrow(/PNG, JPG or WebP/);
    }
  });

  it('enforces the size limits and the base64 alphabet', () => {
    expect(() => decodeImage(pad(PNG, MAX_IMAGE_BYTES + 1).toString('base64'))).toThrow(/1 MB/);
    expect(() => decodeImage('A'.repeat(1_400_001))).toThrow(/1 MB/);
    expect(() => decodeImage(Buffer.from(PNG).toString('base64'))).toThrow(/too small/);
    expect(() => decodeImage('not base64!')).toThrow(/base64/);
    expect(() => decodeImage(42)).toThrow(/base64/);
  });
});
