import type { PublicState } from '@dropdeck/shared';
import { loadConfig } from '../../lib/config';

/** Where this buyer is in the drop; kept per drop in localStorage so a refresh resumes. */
export type BuyerSession =
  | { stage: 'queued'; ticket: string; r?: number; n?: number; admittedSeenAt?: number }
  | { stage: 'held'; hold: string; holdId: string; expiresAt: string; variantId: string; qty: number }
  | { stage: 'confirmed'; confirmation: Confirmation };

export interface Confirmation {
  orderRef: string;
  dropTitle: string;
  variantName: string;
  qty: number;
  amountCents: number;
  merchant: { name: string; paynow?: string; fulfilmentNote?: string };
}

const storageKey = (t: string, d: string) => `dd.buyer.${t}.${d}`;

export function loadSession(t: string, d: string): BuyerSession | null {
  try {
    const raw = localStorage.getItem(storageKey(t, d));
    return raw ? (JSON.parse(raw) as BuyerSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(t: string, d: string, s: BuyerSession | null): void {
  try {
    if (s) localStorage.setItem(storageKey(t, d), JSON.stringify(s));
    else localStorage.removeItem(storageKey(t, d));
  } catch { /* private mode: the session lasts as long as the tab */ }
}

export class BuyerApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly retryAfter?: number) {
    super(message);
  }
}

export async function buyerApi<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const cfg = await loadConfig();
  const r = await fetch(`${cfg.apiUrl}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await r.json().catch(() => null)) as ({ code?: string; message?: string; retryAfter?: number } & T) | null;
  if (!r.ok) throw new BuyerApiError(r.status, body?.code ?? 'HTTP_ERROR', body?.message ?? `Request failed (${r.status})`, body?.retryAfter);
  return body as T;
}

/**
 * The page's view of admission, from the polled watermark. The claim endpoint is the real gate: if this says
 * "admitted" a moment early, the claim answers NOT_ADMITTED with a retryAfter and the page simply waits.
 */
export function queueStatus(pos: { r?: number; n?: number }, s: PublicState | null): { admitted: boolean; ahead: number | null } {
  if (!s || s.state !== 'Live' || s.earlyCount === null) return { admitted: false, ahead: null };
  const early = s.earlyCount;
  if (pos.r !== undefined) {
    if (early === 0) return { admitted: true, ahead: 0 };
    return { admitted: pos.r <= s.rThreshold, ahead: Math.max(0, Math.ceil(pos.r * early) - Math.floor(s.rThreshold * early)) };
  }
  const n = pos.n ?? 0;
  const earlyLeft = s.rThreshold >= 1 ? 0 : Math.ceil(early * (1 - s.rThreshold));
  return { admitted: n < s.nWatermark, ahead: earlyLeft + Math.max(0, n - s.nWatermark + 1) };
}
