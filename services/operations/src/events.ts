import { createHash } from 'node:crypto';

export interface Observation { id: string; tenantId: string; dropId: string; at: number; kind: string; counts: Record<string, number>; fields: Record<string, string | number> }
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** Only allowlisted, non-personal fields survive log ingestion. */
export function observation(raw: Record<string, unknown>, eventId: string): Observation | undefined {
  if (raw._ops !== true || !id(raw.tenantId) || !id(raw.dropId) || typeof raw.kind !== 'string' || !Number.isFinite(raw.at)) return;
  const at = Number(raw.at);
  const counts: Record<string, number> = {};
  const fields: Record<string, string | number> = {};
  if (raw.kind === 'request') {
    counts.requests = 1;
    const status = Number(raw.status);
    counts.errors5xx = Number(status >= 500); counts.app429 = Number(status === 429);
    if (raw.Service === 'ticket') { counts.ticketAttempts = 1; counts.ticketsIssued = Number(status === 201); }
    if (raw.Service === 'claim') { counts.claimAttempts = 1; counts.newHolds = Number(status === 201); }
    if (raw.Service === 'checkout' && String(raw.operation).endsWith('/confirm')) { counts.confirmAttempts = 1; counts.confirmResponses = Number(status===200); }
    if (raw.Service === 'otp') counts.otpAttempts = 1;
    if (typeof raw.LatencyMs === 'number' && raw.LatencyMs >= 0 && raw.LatencyMs < 900_000) { counts.latencyMs = raw.LatencyMs; counts.latencySamples = 1; }
  } else if (raw.kind === 'edge429') counts.edge429 = 1;
  else if (raw.kind === 'heartbeat' || raw.kind === 'register') {
    if (raw.kind === 'heartbeat') fields.heartbeatAt = at;
    if (typeof raw.title === 'string') fields.title = raw.title.slice(0, 160);
    if (['Draft', 'Scheduled', 'Live', 'Closed', 'Cancelled'].includes(String(raw.lifecycle))) fields.lifecycle = String(raw.lifecycle);
    if (typeof raw.sourceVersion === 'number') fields.sourceVersion = raw.sourceVersion;
  } else if (raw.kind === 'publication') {
    if (raw.publication === 'state') {
      fields.publicationAttemptAt = at;
      fields[raw.succeeded ? 'publicationSuccessAt' : 'publicationFailureAt'] = at;
      counts.publicationFailures = Number(!raw.succeeded);
    } else if (raw.publication === 'shop') fields[raw.succeeded ? 'shopSuccessAt' : 'shopFailureAt'] = at;
  } else if (['otpVerified', 'otpAccepted', 'otpFailed', 'otpTestMode', 'otpFallback', 'otpDelivered', 'otpBounce', 'otpComplaint', 'otpDelayed', 'otpRejected'].includes(raw.kind)) {
    counts[raw.kind] = 1;
    if (raw.mailMode === 'ses' || raw.mailMode === 'log') fields.mailMode = raw.mailMode;
  } else return;
  return { id: eventId, tenantId: raw.tenantId, dropId: raw.dropId, kind: raw.kind, at, counts, fields };
}

export function edgeObservation(raw: Record<string, unknown>, eventId: string): Observation | undefined {
  if (Number(raw.status) !== 429) return;
  const m = String(raw.path).match(/\/api\/d\/([\w-]+)\/([\w-]+)\/(?:ticket|claim)$/);
  if (!m) return; // Hold endpoints cannot be safely attributed from their path alone.
  return observation({ _ops: true, kind: 'edge429', tenantId: m[1], dropId: m[2], at: Number(raw.at) }, eventId);
}

/** SES tags correlate delivery without retaining recipients, headers, OTP content or the raw event. */
export function sesObservation(raw: Record<string, any>, eventId: string): Observation | undefined {
  const tags = raw.mail?.tags;
  const kind = ({ Delivery: 'otpDelivered', Bounce: 'otpBounce', Complaint: 'otpComplaint', DeliveryDelay: 'otpDelayed', Reject: 'otpRejected' } as Record<string,string>)[raw.eventType];
  if (!kind) return;
  const unique = digest(`${raw.mail?.messageId}:${raw.eventType}:${eventId}`);
  return observation({ _ops: true, kind, tenantId: tags?.['dd-tenant']?.[0], dropId: tags?.['dd-drop']?.[0], at: Date.now(), mailMode: 'ses' }, unique);
}

export function batches(events: Observation[]) {
  const groups = new Map<string, Observation[]>();
  for (const e of events) {
    const key = `${e.tenantId}/${e.dropId}/${Math.floor(e.at / 60_000)}`;
    const a = groups.get(key) ?? []; a.push(e); groups.set(key, a);
  }
  return [...groups.values()].map(group => {
    const unique = [...new Map(group.map(e => [e.id,e])).values()];
    const latest = unique.reduce((a,b) => a.at > b.at ? a : b);
    const counts: Record<string,number> = {};
    for (const e of unique) for (const [k,v] of Object.entries(e.counts)) counts[k] = (counts[k] ?? 0) + v;
    return { ...latest, counts, receipt: digest(unique.map(e => e.id).sort().join('|')), events: unique };
  });
}
