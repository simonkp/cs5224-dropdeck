import type { PublicState } from '@dropdeck/shared';
// Browser-safe subpath: the package index also pulls in node:crypto.
import { OPEN_LEAD_MS } from '@dropdeck/shared/lifecycle';
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
  merchant: { name: string; paynow?: string; fulfilmentNote?: string; logoUrl?: string; colour?: string; theme?: 'light' | 'dark' | 'auto' };
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

/**
 * Name and email typed while waiting, so checkout is one tap when the turn comes. Kept only in this browser (and for
 * the buyer's next drop): nothing is sent until they confirm an order, so people who never get stock leave no
 * personal data with us (decision 0001).
 */
export interface BuyerDetails {
  name: string;
  email: string;
}

const DETAILS_KEY = 'dd.buyer.details';

export function loadDetails(): BuyerDetails {
  try {
    const d = JSON.parse(localStorage.getItem(DETAILS_KEY) ?? 'null') as Partial<BuyerDetails> | null;
    return { name: typeof d?.name === 'string' ? d.name : '', email: typeof d?.email === 'string' ? d.email : '' };
  } catch {
    return { name: '', email: '' };
  }
}

export function saveDetails(d: BuyerDetails): void {
  try {
    if (d.name || d.email) localStorage.setItem(DETAILS_KEY, JSON.stringify({ name: d.name.slice(0, 80), email: d.email.slice(0, 200) }));
    else localStorage.removeItem(DETAILS_KEY);
  } catch { /* private mode: details last as long as the page */ }
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

/**
 * The server clock, estimated from state.json responses. A Date header is cut to the whole second, so one response
 * only says the server time was within a 1–2 s window when it was served (the Age header adds its own second). Polls
 * land at different points of the second, so intersecting the windows from every poll narrows the offset to well
 * under a second after a few polls. If the windows ever disagree (the device clock jumped), start again from the
 * latest one.
 */
export class ClockEstimate {
  private lo = -Infinity;
  private hi = Infinity;

  /** `sentAt` and `receivedAt` are device times (Date.now()) around the request. */
  add(date: string | null, age: string | null, sentAt: number, receivedAt: number): void {
    const d = Date.parse(date ?? '');
    if (Number.isNaN(d)) return;
    const a = Number(age);
    const hasAge = age !== null && Number.isFinite(a);
    const serverLow = d + (hasAge ? a * 1000 : 0);
    const serverHigh = serverLow + (hasAge ? 2000 : 1000);
    // Served somewhere between sending and receiving, at a server time inside [serverLow, serverHigh).
    const lo = serverLow - receivedAt;
    const hi = serverHigh - sentAt;
    const nlo = Math.max(this.lo, lo);
    const nhi = Math.min(this.hi, hi);
    if (nlo > nhi) {
      this.lo = lo;
      this.hi = hi;
    } else {
      this.lo = nlo;
      this.hi = nhi;
    }
  }

  get ready(): boolean {
    return Number.isFinite(this.lo) && Number.isFinite(this.hi);
  }

  /** Server clock minus device clock, in ms. */
  offset(): number {
    return (this.lo + this.hi) / 2;
  }

  /** How uncertain the offset still is, in ms. */
  width(): number {
    return this.hi - this.lo;
  }
}

/**
 * How long to wait before the next state.json poll. Polling is the biggest cost of a drop (docs/cost-bom.md), so
 * pages poll fast only while something can change for this buyer, and slowly otherwise. The fast phase starts
 * OPEN_LEAD_MS + 60 s before the queue opens: the controller flips the drop Live OPEN_LEAD_MS ahead, so a page is
 * always polling fast by the time Join can work. The URL stays fixed whatever the interval (never cache-bust).
 */
export const FAST_LEAD_MS = OPEN_LEAD_MS + 60_000;

export interface PollContext {
  now: number;
  entryOpensAt: number;
  hidden: boolean;
  state: PublicState | null;
  stage: BuyerSession['stage'] | null;
  /** People ahead, when queued. */
  ahead: number | null;
}

export function pollInterval(c: PollContext): number {
  if (c.hidden) return 15_000; // a background tab; it polls at once when shown again
  if (c.state?.state === 'Closed' || c.state?.state === 'Cancelled') return 30_000;
  if (c.entryOpensAt - c.now > FAST_LEAD_MS) return 30_000; // a countdown that is still far off
  if (c.stage === 'held' || c.stage === 'confirmed') return 10_000; // only the end of the drop matters now
  if (c.stage === 'queued' && c.ahead !== null && c.ahead > 300) return 5_000; // far back in line
  return 2_000;
}
