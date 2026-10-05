/**
 * Invoked by EventBridge Scheduler.
 *   { action: 'open',  tenantId, dropId }  one-off at the entry-window start
 *   { action: 'tick',  tenantId, dropId }  every minute while Live (rate schedule created on open)
 * (week 2)
 *
 * TODO
 * - open: transition Scheduled → Live; create the per-minute `tick` schedule; publish state.json.
 * - tick: loop for ~55 s, every 2-3 s:
 *     at admission start, freeze earlyCount from the early-counter shards (write once, conditional);
 *     compute watermark() from admittedCount(); write state.json only if it moved forward;
 *     sweep expired holds via GSI1 with a conditional active→released flip, unit back to a random shard;
 *     set sold-out flags; close when endAt passes or one hold window after the last sell-out.
 * - Running twice must be harmless: every write is a function of time or conditional.
 */
interface ControllerEvent {
  action: 'open' | 'tick';
  tenantId: string;
  dropId: string;
}

export async function handler(event: ControllerEvent) {
  console.log(JSON.stringify({ level: 'info', msg: 'controller invoked (not yet implemented)', ...event }));
  return { ok: false, reason: 'not implemented' };
}
