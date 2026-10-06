/** Formatting shared by the buyer pages and the console. */

export const price = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Parts for the big countdown: days only when there is at least one. */
export function countdownParts(ms: number): Array<{ value: string; unit: string }> {
  const t = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(t / 86400);
  const parts = [
    { value: pad(Math.floor((t % 86400) / 3600)), unit: 'HRS' },
    { value: pad(Math.floor((t % 3600) / 60)), unit: 'MIN' },
    { value: pad(t % 60), unit: 'SEC' },
  ];
  return days > 0 ? [{ value: String(days), unit: days === 1 ? 'DAY' : 'DAYS' }, ...parts] : parts;
}

/** m:ss for short timers (claim window, hold). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const time = (iso: string | number) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const dayTime = (iso: string | number) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const day = (iso: string | number) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** "SAT" and "14" for the date blocks on the shop page. */
export function dateBlock(iso: string): { dow: string; date: string } {
  const d = new Date(iso);
  return { dow: d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(), date: String(d.getDate()) };
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
