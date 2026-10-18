import { AsyncLocalStorage } from 'node:async_hooks';

type Context = { tenantId?: string; dropId?: string };
const context = new AsyncLocalStorage<Context>();
export function attributeDrop(tenantId: string, dropId: string) { Object.assign(context.getStore() ?? {}, { tenantId, dropId }); }

/** An explicit allowlist keeps tokens, emails and arbitrary error bodies out of operational events. */
export function healthEvent(kind: string, tenantId: string, dropId: string, fields: {
  title?: string; lifecycle?: string; sourceVersion?: number; publication?: string; succeeded?: boolean; mailMode?: string; messageId?: string;
} = {}) {
  if (!process.env.OPS_ENABLED) return;
  const metric = ({otpVerified:'OtpVerified',otpAccepted:'OtpAccepted',otpFailed:'OtpSendFailures',otpDelivered:'OtpDelivered',otpDelayed:'OtpDeliveryDelays',otpBounce:'OtpBounces',otpComplaint:'OtpComplaints',otpRejected:'OtpRejected'} as Record<string,string>)[kind]
    ?? (kind==='publication'&&fields.succeeded===false?'PublicationFailures':undefined);
  const at=Date.now();
  process.stdout.write(JSON.stringify({ _ops: true, kind, tenantId, dropId, at, ...fields,
    ...(metric?{Stage:process.env.STAGE??'unknown',[metric]:1,_aws:{Timestamp:at,CloudWatchMetrics:[{Namespace:'DropDeck/Operations',Dimensions:[['Stage']],Metrics:[{Name:metric,Unit:'Count'}]}]}}:{}),
  })+'\n');
}

/** EMF dimensions deliberately exclude tenant/drop/request IDs. No synchronous telemetry network calls. */
export async function observeRequest<T extends { statusCode: number; body?: string }>(
  service: string,
  event: { pathParameters?: Record<string, string | undefined>; requestContext?: { requestId?: string }; routeKey?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  return context.run({ tenantId: event.pathParameters?.tenantId, dropId: event.pathParameters?.dropId }, async () => {
    let status = 500;
    try { const result = await fn(); status = result.statusCode; return result; }
    finally {
      if (process.env.OPS_ENABLED) {
        const dimensions = { Stage: process.env.STAGE ?? 'unknown', Service: service };
        const metrics = { Requests: 1, Failures: Number(status >= 500), Rejected: Number(status >= 400 && status < 500), App429: Number(status === 429), LatencyMs: Date.now() - started };
        process.stdout.write(JSON.stringify({
          _ops: true, kind: 'request', at: started, ...context.getStore(), status, operation: event.routeKey, requestId: event.requestContext?.requestId,
          ...dimensions, ...metrics,
          _aws: { Timestamp: started, CloudWatchMetrics: [{ Namespace: 'DropDeck/Operations', Dimensions: [['Stage', 'Service']],
            Metrics: Object.keys(metrics).map(Name => ({ Name, Unit: Name === 'LatencyMs' ? 'Milliseconds' : 'Count' })) }] },
        })+'\n');
      }
    }
  });
}
