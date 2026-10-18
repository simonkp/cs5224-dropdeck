/** Browser-safe read model. No buyer identity or credentials belong in these records. */
export interface DropHealth {
  tenantId: string; dropId: string; title?: string; lifecycle?: string; observedAt?: number;
  heartbeatAt?: number; publicationAttemptAt?: number; publicationSuccessAt?: number; publicationFailureAt?: number;
  shopFailureAt?: number; shopSuccessAt?: number; sourceVersion?: number; publicVersion?: number;
  publicState?: string; publicLastModifiedAt?: number; mailMode?: string;
  inventory?: { counterUnits: number; activeUnits: number; expiredUnits: number; orderUnits: number; partial: boolean; sampledAt: number };
  issues?: string[]; severity?: 'healthy' | 'warning' | 'critical' | 'unknown';
}
export type OpsRange = '15m' | '1h' | '24h';
export interface MetricBucket { at: number; counts: Record<string, number> }
export interface DropTelemetry { buckets: MetricBucket[]; totals: Record<string, number>; partial: boolean; generatedAt: number; range: OpsRange }

export function healthIssues(row: DropHealth, now: number): string[] {
  const issues: string[] = [];
  const live = row.lifecycle === 'Live';
  if (!row.observedAt || now - row.observedAt > 180_000) issues.push('Health collection is delayed or unavailable');
  if (live && (!row.heartbeatAt || now - row.heartbeatAt > 90_000)) issues.push('Controller heartbeat is missing or delayed');
  if (row.publicationFailureAt && row.publicationFailureAt > (row.publicationSuccessAt ?? 0)) issues.push('Public state publication failed');
  if (row.shopFailureAt && row.shopFailureAt > (row.shopSuccessAt ?? 0)) issues.push('Shop or homepage publication failed');
  if (row.publicState && row.lifecycle && row.publicState !== row.lifecycle) issues.push('Published lifecycle differs from database');
  if (row.publicLastModifiedAt && row.sourceVersion !== undefined && row.publicVersion === undefined) issues.push('Published source revision is unavailable');
  if (row.publicVersion !== undefined && row.sourceVersion !== undefined && row.publicVersion < row.sourceVersion) issues.push('Published source revision is behind');
  if (!row.publicLastModifiedAt && live) issues.push('Public state is unavailable');
  const i = row.inventory;
  if (!i || i.partial) issues.push('Inventory sample is incomplete');
  else {
    if (i.expiredUnits > 0) issues.push('Expired holds are awaiting release');
    if (i.counterUnits !== i.activeUnits + i.orderUnits) issues.push('Inventory sample differs; concurrent writes or missing confirmation records may explain it');
  }
  return issues;
}
