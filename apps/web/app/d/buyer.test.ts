import { describe, expect, it } from 'vitest';
import { admittedAt, admittedCount, watermark, type PublicState } from '@dropdeck/shared';
import { ClockEstimate, queueStatus } from './buyer';

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

describe('ClockEstimate', () => {
  /** A poll at device time `t` against a server running `trueOffset` ms ahead, 40 ms each way. */
  const poll = (est: InstanceType<typeof ClockEstimate>, t: number, trueOffset: number, cacheAge?: number) => {
    const servedServer = t + 40 + trueOffset;
    const fetchedAt = servedServer - (cacheAge ?? 0) * 1000 - 300; // origin fetch, a little before
    const date = new Date(Math.floor(fetchedAt / 1000) * 1000).toUTCString();
    const age = cacheAge === undefined ? null : String(Math.floor((servedServer - fetchedAt) / 1000));
    est.add(date, age, t, t + 80);
  };

  it('narrows to well under a second after a few polls, whatever the true offset', () => {
    for (const trueOffset of [-123_456, -2_700, 0, 850, 61_000]) {
      const est = new ClockEstimate();
      for (let i = 0; i < 8; i++) poll(est, 1_000_000 + i * 2_130, trueOffset, i % 3);
      expect(Math.abs(est.offset() - trueOffset)).toBeLessThan(500);
      expect(est.width()).toBeLessThan(2_000); // narrower than any single poll's window (2 s + round trip)
    }
  });

  it('starts again when the device clock jumps', () => {
    const est = new ClockEstimate();
    for (let i = 0; i < 5; i++) poll(est, 1_000_000 + i * 2_130, 0);
    for (let i = 0; i < 5; i++) poll(est, 2_000_000 + i * 2_130, -30_000); // device clock moved 30 s ahead
    expect(Math.abs(est.offset() - -30_000)).toBeLessThan(1_000);
  });

  it('is not ready until a response carries a Date header', () => {
    const est = new ClockEstimate();
    est.add(null, null, 0, 10);
    expect(est.ready).toBe(false);
  });
});
