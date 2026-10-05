import type { Drop, RatePreset } from './types.js';

/**
 * Admission is a pure function of time and the frozen early-group size, so a
 * claim can be checked from the ticket alone and overlapping controllers converge.
 * See docs/decisions/0003-pre-open-random-draw.md.
 */
const PRESET_MULTIPLE: Record<RatePreset, number> = { gentle: 1, normal: 2, fast: 4 };

/** Buyers admitted per minute: a multiple of total stock per hold window (over-admission). */
export function admissionRatePerMin(preset: RatePreset, totalStock: number, holdSec: number, tenantCapPerMin?: number): number {
  const rate = (PRESET_MULTIPLE[preset] * totalStock) / Math.max(holdSec / 60, 1);
  return Math.max(1, Math.min(rate, tenantCapPerMin ?? Infinity));
}

/** The drop's admission rate: its preset applied to total stock per hold window. */
export function dropAdmissionRate(drop: Pick<Drop, 'ratePreset' | 'variants' | 'holdSec'>): number {
  return admissionRatePerMin(drop.ratePreset, drop.variants.reduce((n, v) => n + v.stock, 0), drop.holdSec);
}

/** The controller freezes the early-group size this long after admission starts, so in-flight ticket ADDs land first. */
export const FREEZE_DELAY_MS = 2000;

export function admissionStartsAt(drop: Pick<Drop, 'openAt' | 'graceSec'>): number {
  return Date.parse(drop.openAt) + drop.graceSec * 1000;
}

/** Total buyers admitted by `now` (early group first, then late tickets). */
export function admittedCount(startMs: number, ratePerMin: number, nowMs: number): number {
  return Math.max(0, Math.floor(((nowMs - startMs) / 60_000) * ratePerMin));
}

export function watermark(admitted: number, earlyCount: number): { rThreshold: number; nWatermark: number } {
  if (earlyCount <= 0) return { rThreshold: 1, nWatermark: admitted };
  if (admitted < earlyCount) return { rThreshold: admitted / earlyCount, nWatermark: 0 };
  return { rThreshold: 1, nWatermark: admitted - earlyCount };
}

/** The instant a given ticket becomes admitted. */
export function admittedAt(
  ticket: { r: number } | { n: number },
  startMs: number,
  ratePerMin: number,
  earlyCount: number,
): number {
  const position = 'r' in ticket ? ticket.r * earlyCount : earlyCount + ticket.n;
  return startMs + Math.ceil((position / ratePerMin) * 60_000);
}

export type AdmissionCheck = { ok: true } | { ok: false; reason: 'NOT_ADMITTED' | 'ADMISSION_EXPIRED'; retryAfterSec?: number };

export function checkAdmission(admitAtMs: number, admitWindowSec: number, nowMs: number): AdmissionCheck {
  if (nowMs < admitAtMs) return { ok: false, reason: 'NOT_ADMITTED', retryAfterSec: Math.ceil((admitAtMs - nowMs) / 1000) };
  if (nowMs > admitAtMs + admitWindowSec * 1000) return { ok: false, reason: 'ADMISSION_EXPIRED' };
  return { ok: true };
}
