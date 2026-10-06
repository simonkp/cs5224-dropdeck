import { api } from './api';

/**
 * Images are shrunk in the browser before upload, so phone photos (often 3-8 MB) fit the API's 1 MB limit and pages
 * load fast. WebP where the browser can encode it, JPEG otherwise; PNG logos with transparency stay PNG.
 */
export interface ImageTarget {
  maxWidth: number;
  maxHeight: number;
  /** 'cover' crops to exactly maxWidth × maxHeight (banners, square logos); 'contain' only scales down. */
  fit: 'cover' | 'contain';
}

export const TARGETS = {
  logo: { maxWidth: 512, maxHeight: 512, fit: 'cover' },
  cover: { maxWidth: 1600, maxHeight: 600, fit: 'cover' },
  drop: { maxWidth: 1600, maxHeight: 1200, fit: 'contain' },
} satisfies Record<string, ImageTarget>;

const MAX_BYTES = 1024 * 1024;

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall back to an <img> (e.g. HEIC in Safari) */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

export async function shrinkImage(file: File, t: ImageTarget): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
  const img = await decode(file);
  const w = img.width;
  const h = img.height;
  let scale = 1;
  let sx = 0, sy = 0, sw = w, sh = h;
  let outW: number, outH: number;
  if (t.fit === 'cover') {
    const ratio = t.maxWidth / t.maxHeight;
    if (w / h > ratio) { sw = h * ratio; sx = (w - sw) / 2; } else { sh = w / ratio; sy = (h - sh) / 2; }
    scale = Math.min(1, t.maxWidth / sw);
    outW = Math.round(sw * scale);
    outH = Math.round(sh * scale);
  } else {
    scale = Math.min(1, t.maxWidth / w, t.maxHeight / h);
    outW = Math.round(w * scale);
    outH = Math.round(h * scale);
  }
  const keepPng = file.type === 'image/png' && t === TARGETS.logo;
  for (const shrink of [1, 0.8, 0.6, 0.45]) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(outW * shrink));
    canvas.height = Math.max(1, Math.round(outH * shrink));
    canvas.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    for (const type of keepPng ? ['image/png'] : ['image/webp', 'image/jpeg']) {
      const blob = await toBlob(canvas, type, 0.85);
      // Some browsers silently return PNG when they cannot encode WebP; only accept what was asked for.
      if (blob && blob.type === type && blob.size <= MAX_BYTES) return blob;
    }
  }
  throw new Error('That image is too large even after shrinking; try a smaller one');
}

const toBase64 = (blob: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/** Shrinks, uploads and returns the stored path (/b/{tenant}/{hash}.webp). */
export async function uploadImage(file: File, target: ImageTarget): Promise<string> {
  const blob = await shrinkImage(file, target);
  const r = await api<{ path: string }>('/m/uploads', { method: 'POST', body: { image: await toBase64(blob) } });
  return r.path;
}
