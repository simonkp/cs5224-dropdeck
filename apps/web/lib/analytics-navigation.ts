export type AnalyticsTab = 'overview' | 'inventory' | 'payments' | 'fulfillment' | 'advanced';

/** Leaving Growth's extended range selects the most recent 31 days and updates the visible date input. */
export function analyticsFromForTab(from: string, to: string, tab: AnalyticsTab): string {
  const start = Date.parse(from), end = Date.parse(to);
  if (tab === 'advanced' || !Number.isFinite(start) || !Number.isFinite(end) || end - start <= 30 * 86400000) return from;
  return new Date(end - 30 * 86400000).toISOString().slice(0, 10);
}
