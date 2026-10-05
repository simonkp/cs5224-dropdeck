import { describe, expect, it } from 'vitest';
import { admittedAt, admittedCount, watermark, type PublicState } from '@dropdeck/shared';
import { queueStatus } from './buyer';

const state = (admitted: number, early: number): PublicState => ({
  state: 'Live', serverTime: '', ...watermark(admitted, early), earlyCount: early, soldOut: {},
});

describe('queueStatus agrees with the claim endpoint', () => {
  const start = 1_000_000;
  const rate = 37; // per minute
  const early = 120;

  it('never shows a turn more than a second before the server admits it', () => {
    for (let ms = 0; ms < 10 * 60_000; ms += 1000) {
      const s = state(admittedCount(start, rate, start + ms), early);
      for (const pos of [{ r: 0.01 }, { r: 0.5 }, { r: 0.999 }, { n: 0 }, { n: 7 }, { n: 200 }]) {
        if (queueStatus(pos, s).admitted) {
          expect(admittedAt(pos, start, rate, early)).toBeLessThanOrEqual(start + ms + 1000);
        }
      }
    }
  });

  it('counts early buyers still to go ahead of a late ticket', () => {
    expect(queueStatus({ n: 0 }, state(30, 120)).ahead).toBe(91);
    expect(queueStatus({ n: 5 }, state(130, 120)).admitted).toBe(true);
    expect(queueStatus({ n: 10 }, state(130, 120)).admitted).toBe(false);
  });

  it('waits for the draw to close before placing early tickets', () => {
    expect(queueStatus({ r: 0.2 }, { ...state(0, 0), earlyCount: null })).toEqual({ admitted: false, ahead: null });
  });
});
