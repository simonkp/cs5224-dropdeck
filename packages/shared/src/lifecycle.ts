import type { Drop, DropState } from './types.js';

const transitions: Record<DropState, DropState[]> = {
  Draft: ['Scheduled'],
  Scheduled: ['Draft', 'Live', 'Cancelled'],
  Live: ['Closed', 'Cancelled'],
  Closed: [],
  Cancelled: [],
};

export function canTransition(from: DropState, to: DropState): boolean {
  return transitions[from].includes(to);
}

export function entryOpensAt(drop: Pick<Drop, 'openAt' | 'entryWindowMin'>): Date {
  return new Date(Date.parse(drop.openAt) - drop.entryWindowMin * 60_000);
}

/** Stock, price and times lock when the pre-open entry window starts. */
export function isLockedForEdit(drop: Pick<Drop, 'state' | 'openAt' | 'entryWindowMin'>, now: Date): boolean {
  if (drop.state === 'Draft') return false;
  if (drop.state !== 'Scheduled') return true;
  return now.getTime() >= entryOpensAt(drop).getTime();
}

/** Text and images stay editable until the drop is Live. */
export const ALWAYS_EDITABLE: ReadonlyArray<keyof Drop> = ['title', 'description', 'imageUrl'];
