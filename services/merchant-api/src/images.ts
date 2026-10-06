import { createHash } from 'node:crypto';
import { ApiError } from '@dropdeck/shared';

/**
 * Uploaded images arrive as base64 in a JSON body (POST /m/uploads). The console shrinks them first, so 1 MiB is
 * plenty; the type is sniffed from the bytes, never trusted from the client, and only raster formats a browser shows
 * inline are accepted (no SVG: it can carry script).
 */
export const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = 1_400_000; // checked before decoding, so a huge body is refused cheaply
const MIN_IMAGE_BYTES = 64;

export type ImageExt = 'png' | 'jpg' | 'webp';

export interface DecodedImage {
  bytes: Buffer;
  ext: ImageExt;
  contentType: string;
  /** First 32 hex characters of the SHA-256: the object key, so the same image always lands on the same key. */
  hash: string;
}

const fail = (msg: string): never => {
  throw new ApiError('VALIDATION', msg);
};

export function sniff(b: Buffer): { ext: ImageExt; contentType: string } | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

export function decodeImage(raw: unknown): DecodedImage {
  if (typeof raw !== 'string' || !raw) return fail('image must be base64 text');
  const b64 = raw.replace(/^data:image\/[a-z+.-]+;base64,/i, '');
  if (b64.length > MAX_BASE64_CHARS) fail('Image is larger than 1 MB');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) fail('image must be base64 text');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) fail('Image is larger than 1 MB');
  if (bytes.length < MIN_IMAGE_BYTES) fail('Image is too small to be a picture');
  const type = sniff(bytes) ?? fail('Use a PNG, JPG or WebP image');
  return { bytes, ...type, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 32) };
}
