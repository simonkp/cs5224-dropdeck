/**
 * Experiment 2: load and headroom against a deployed stage, in real time (about 7 minutes a run).
 *
 *   AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1 pnpm --filter @dropdeck/eval load -- --stage dev-simon --scale 1
 *   ... --scale 3        three times the reference crowd
 *   ... --scale 10       ten times
 *   ... --dry-run        print the plan and the arrival curve; touches nothing
 *   ... --spread-sec 10  each pre-draw join waits a random 0-10 s first, as the buyer page does
 *   ... --checkout-sec 20-60 --abandon-share 0.2   buyers take 20-60 s to check out and one in five leaves
 *                        without confirming (their hold expires and the unit is sold again)
 *
 * The reference workload (eval/README.md) is 200 units and 5,000 buyer sessions; --scale multiplies the crowd, the
 * stock stays at --units. A real drop is created and scheduled through the merchant Lambda (as e2e.ts does), so
 * EventBridge, the controller, the draw, admission, claims and checkout all run as they would for a shop.
 *
 * Each simulated buyer does what the page does: joins (ticket), waits for the published watermark to reach its
 * position, claims, then confirms the order. Refused joins (429, 5xx, network) are retried with backoff.
 *
 * Arrivals (seeded, so a run can be repeated): --burst-share of the crowd joins in the first --spike-sec seconds
 * after the queue opens, --late-share arrives in the minute after admission starts, the rest is spread over the
 * entry window in between.
 *
 * Not reproduced: the crowd's polling of state.json. One shared poller reads it once a second for every simulated
 * buyer, because it is one cached file at the edge whatever the crowd size (measured separately in docs/cost-bom.md),
 * and replaying 5,000 to 50,000 pollers would only load CloudFront and the laptop.
 *
 * Pass means correct: units sold == min(buyers with a ticket, stock), no shard over capacity, orders == units sold,
 * no unexpected refusals, the drop Live by its advertised entry time. Headroom (throttling, errors, latency, buyers
 * who never got a ticket) is reported as `degradation`, not as a failure: finding where it starts is the point.
 *
 * Each result also records, from AWS's own logs and metrics, how many copies of the ticket, claim and checkout
 * functions served the run and how many were already running when it began (`functions`). Compare two runs only if
 * they started from the same place: a copy left over from an earlier run already holds the signing key and answers
 * in milliseconds. Idle copies are dropped by AWS after a while, at a time it does not publish.
 *
 * Output: eval/results/<date>-load/<time>-x<scale>-<stage>.json and a line in eval/results/SUMMARY.md.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { admissionRatePerMin, keys, type Drop, type PublicState } from '@dropdeck/shared';
import { Agent, setGlobalDispatcher } from 'undici';
import { stageUsage, type AccountUsage, type FunctionUsage } from './usage.js';

const { values: args } = parseArgs({
  // pnpm forwards the `--` separator; drop it so `pnpm ... load -- --stage x` works.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    stage: { type: 'string' },
    scale: { type: 'string', default: '1' },
    buyers: { type: 'string' },
    units: { type: 'string', default: '200' },
    shards: { type: 'string', default: '4' },
    seed: { type: 'string', default: '1' },
    'burst-share': { type: 'string', default: '0.5' },
    'spike-sec': { type: 'string', default: '5' },
    'late-share': { type: 'string', default: '0.2' },
    connections: { type: 'string', default: '512' },
    'spread-sec': { type: 'string', default: '0' },
    'spread-share': { type: 'string', default: '1' },
    'checkout-sec': { type: 'string', default: '1-3' },
    'abandon-share': { type: 'string', default: '0' },
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});
const stage = args.stage;
const DRY = args['dry-run']!;
if (!stage && !DRY) throw new Error('--stage is required (e.g. dev-simon)');
if (stage && !/^(dev|eval)/.test(stage) && !args.force) throw new Error(`Refusing to load ${stage}: it is not a dev or eval stage. Pass --force if you mean it.`);

const REFERENCE_BUYERS = 5000;
const SCALE = Number(args.scale);
const BUYERS = Number(args.buyers ?? Math.round(REFERENCE_BUYERS * SCALE));
const UNITS = Number(args.units);
const SHARDS = Number(args.shards);
const SEED = Number(args.seed);
const BURST_SHARE = Number(args['burst-share']);
const SPIKE_SEC = Number(args['spike-sec']);
const LATE_SHARE = Number(args['late-share']);
const CONNECTIONS = Number(args.connections);
/** Option 1, as the buyer page does it: a pre-draw join waits a random 0 to this many seconds. 0 = no spreading. */
const SPREAD_SEC = Number(args['spread-sec']);
const SPREAD_MARGIN_MS = 5000;
/** Share of buyers whose page spreads; the rest join at once, like a script or a page cached from before. */
const SPREAD_SHARE = Number(args['spread-share']);
/** How long a buyer with a hold spends on the checkout form before confirming, as "min-max" seconds. */
const [CHECKOUT_MIN_SEC, CHECKOUT_MAX_SEC] = args['checkout-sec']!.split('-').map(Number) as [number, number];
/** Share of buyers with a hold who leave without confirming; their hold expires and the unit goes back to stock. */
const ABANDON_SHARE = Number(args['abandon-share']);
for (const [name, v] of Object.entries({ scale: SCALE, buyers: BUYERS, units: UNITS, shards: SHARDS, seed: SEED, 'burst-share': BURST_SHARE, 'spike-sec': SPIKE_SEC, 'late-share': LATE_SHARE, connections: CONNECTIONS, 'spread-sec': SPREAD_SEC, 'spread-share': SPREAD_SHARE, 'checkout-sec (min)': CHECKOUT_MIN_SEC, 'checkout-sec (max)': CHECKOUT_MAX_SEC, 'abandon-share': ABANDON_SHARE })) {
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a number, got ${String(v)}`);
}
if (BURST_SHARE + LATE_SHARE > 1) throw new Error('--burst-share and --late-share must add up to at most 1');
// A new tenant per run is on Starter, which the schedule route holds to 200 units a month (decision 0013).
if (UNITS > 200) throw new Error('--units above 200 exceeds the Starter plan the test tenant is on; the schedule would be refused with PLAN_LIMIT');
if (ABANDON_SHARE > 1) throw new Error('--abandon-share must be at most 1');

// The drop under test. Fast preset and the shortest hold keep a run short; the buyer check is off (no email).
const ENTRY_WINDOW_MIN = 1;
const GRACE_SEC = 30;
const HOLD_SEC = 120;
const ADMIT_WINDOW_SEC = 300;
if (!(CHECKOUT_MIN_SEC <= CHECKOUT_MAX_SEC) || CHECKOUT_MAX_SEC > HOLD_SEC - 10) throw new Error(`--checkout-sec must be "min-max" with max at most ${HOLD_SEC - 10} (the hold is ${HOLD_SEC} s)`);
/** assertSchedulable wants three minutes before the entry window; the rest covers the set-up calls. */
const LEAD_MS = 200_000;
/**
 * How long after admission starts the run keeps going. Stock sells in about half a minute at the fast preset; a
 * long checkout adds its length, and abandoned holds add a hold, the controller's sweep and a resale.
 */
const RUN_AFTER_START_MS = 120_000 + CHECKOUT_MAX_SEC * 1000 + (ABANDON_SHARE > 0 ? (HOLD_SEC + 120) * 1000 : 0);
const LATE_SPREAD_MS = 60_000;
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 20_000;

// A keep-alive pool sized for the spike (oversell.ts explains why one is needed at all).
setGlobalDispatcher(new Agent({ connections: CONNECTIONS, pipelining: 1, keepAliveTimeout: 30_000 }));

/** mulberry32: a small seeded generator, so the arrival curve and think times are the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
/** Separate stream, so spreading does not shift the think times drawn from `random`. */
const spreadRandom = rng(SEED + 1);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0);
};
const latency = (xs: number[]) => ({
  min: xs.length ? Math.round(xs.reduce((m, x) => Math.min(m, x), Infinity)) : 0,
  mean: xs.length ? Math.round(xs.reduce((n, x) => n + x, 0) / xs.length) : 0,
  p50: percentile(xs, 50), p95: percentile(xs, 95), p99: percentile(xs, 99), max: Math.round(xs.reduce((m, x) => Math.max(m, x), 0)),
});

/** Arrival offsets in ms from the moment the queue opens, in buyer order. */
function arrivals(admissionAfterEntryMs: number): number[] {
  const spike = SPIKE_SEC * 1000;
  return Array.from({ length: BUYERS }, () => {
    const kind = random();
    if (kind < BURST_SHARE) return random() * spike;
    if (kind < BURST_SHARE + LATE_SHARE) return admissionAfterEntryMs + 3000 + random() * LATE_SPREAD_MS;
    // Stops two seconds short of admission so these buyers are in the draw, as the model says.
    return spike + random() * Math.max(1, admissionAfterEntryMs - 2000 - spike);
  });
}

const admissionAfterEntryMs = ENTRY_WINDOW_MIN * 60_000 + GRACE_SEC * 1000;
const plan = arrivals(admissionAfterEntryMs);
const perSecondPlanned = new Map<number, number>();
for (const ms of plan) perSecondPlanned.set(Math.floor(ms / 1000), (perSecondPlanned.get(Math.floor(ms / 1000)) ?? 0) + 1);
const plannedPeak = Math.max(0, ...perSecondPlanned.values());
const ratePerMin = admissionRatePerMin('fast', UNITS, HOLD_SEC);

if (DRY) {
  const early = plan.filter((ms) => ms < admissionAfterEntryMs).length;
  console.log(JSON.stringify({
    scale: SCALE, buyers: BUYERS, units: UNITS, shards: SHARDS, seed: SEED,
    arrivals: { inTheSpike: plan.filter((ms) => ms < SPIKE_SEC * 1000).length, restOfEntryWindow: early - plan.filter((ms) => ms < SPIKE_SEC * 1000).length, afterAdmissionStarts: BUYERS - early },
    plannedPeakJoinsPerSec: plannedPeak, admissionRatePerMin: ratePerMin,
    firstSeconds: Array.from({ length: 8 }, (_, s) => perSecondPlanned.get(s) ?? 0),
    runMinutes: Math.round((LEAD_MS + admissionAfterEntryMs + RUN_AFTER_START_MS) / 6000) / 10,
  }, null, 2));
  process.exit(0);
}

type Step = 'ticket' | 'claim' | 'confirm' | 'state';
const newStep = () => ({ ms: [] as number[], codes: {} as Record<string, number>, throttled: 0, serverErrors: 0, networkErrors: 0 });
const steps: Record<Step, ReturnType<typeof newStep>> = { ticket: newStep(), claim: newStep(), confirm: newStep(), state: newStep() };
/** Joins per second since the queue opened: what was sent and what came back. */
const joinSeconds = new Map<number, { sent: number; ok: number; throttled: number; failed: number }>();
const outcomes: Record<string, number> = {};
const ticketAttempts: Record<string, number> = {};
const timeToTicketMs: number[] = [];
/** Per buyer with a ticket: the deliberate spreading wait, and the rest (server, retries, queueing here). */
const spreadDelayMs: number[] = [];
const waitAfterSpreadMs: number[] = [];
const sendLagMs: number[] = [];
const earlyTickets: Array<{ arrivedMs: number; r: number }> = [];
let lateTickets = 0;
let earlyClaims = 0;
/** Per buyer with a hold: admission start (or their ticket, if later) to hold, so their turn plus any wait for
 * reserved stock, not the scheduled wait for the draw; and arrival to order. */
const turnWaitMs: number[] = [];
const timeToOrderMs: number[] = [];
let abandoned = 0;
let lastOrderAt: number | undefined;
/** Separate stream, so abandoning does not shift the think times drawn from `random`. */
const abandonRandom = rng(SEED + 2);

interface Res { status: number; code: string; body: Record<string, unknown>; ms: number }
async function call(step: Step, url: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<Res> {
  const t0 = performance.now();
  let res: Res;
  try {
    const r = await fetch(url, {
      method: init.method ?? 'POST',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    // API Gateway's own refusals (429 from the stage throttle, 503) carry no `code`.
    res = { status: r.status, code: r.ok ? 'OK' : String(body.code ?? `HTTP_${r.status}`), body, ms: performance.now() - t0 };
  } catch (e) {
    const err = e as { name?: string; cause?: { code?: string } };
    res = { status: 0, code: `NETWORK:${err.name === 'TimeoutError' ? 'TIMEOUT' : err.cause?.code ?? 'ERROR'}`, body: {}, ms: performance.now() - t0 };
  }
  steps[step].ms.push(res.ms);
  steps[step].codes[res.code] = (steps[step].codes[res.code] ?? 0) + 1;
  // By status, not by code: a handler's catch-all answers 500 with the code INTERNAL.
  if (res.status === 429) steps[step].throttled++;
  else if (res.status >= 500) steps[step].serverErrors++;
  else if (res.status === 0) steps[step].networkErrors++;
  return res;
}
const retryable = (r: Res) => r.status === 0 || r.status === 429 || r.status >= 500;
const backoff = (attempt: number) => sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.5 + random()));

/** The page's view of admission from the polled watermark (queueStatus in apps/web/app/d/buyer.ts). */
function admitted(pos: { r?: number; n?: number }, s: PublicState | null): boolean {
  if (!s || s.state !== 'Live' || s.earlyCount === null) return false;
  if (pos.r !== undefined) return s.earlyCount === 0 || pos.r <= s.rThreshold;
  return (pos.n ?? 0) < s.nWatermark;
}
const allSoldOut = (s: PublicState | null) => !!s && Object.keys(s.soldOut).length > 0 && Object.values(s.soldOut).every(Boolean);
/**
 * When holds can be abandoned, "sold out" only means everything is reserved: the page tells buyers that unconfirmed
 * holds go back to stock and keeps the Join and Claim buttons for when they do, so a buyer leaves only once the drop
 * closes. Without abandoning, every hold is confirmed, and the buyer leaves at sold out as in the earlier runs.
 */
const WAITS_FOR_RETURNS = ABANDON_SHARE > 0;
const gone = (s: PublicState | null) => (WAITS_FOR_RETURNS ? s?.state === 'Closed' : allSoldOut(s));

async function main() {
  const cf = new CloudFormationClient({});
  const stackName = `DropDeck-${stage}`;
  const out = Object.fromEntries(((await cf.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  const fns = (await cf.send(new ListStackResourcesCommand({ StackName: stackName }))).StackResourceSummaries ?? [];
  const merchantFn = fns.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith('MerchantApi'))!.PhysicalResourceId!;
  const site = out.SiteUrl!;
  const api = out.ApiUrl!;
  const tableName = out.TableName!;
  const lambda = new LambdaClient({});
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const tenant = `load-${randomUUID().slice(0, 8)}`;

  /** Calls the merchant Lambda as the API Gateway JWT authorizer would, for a synthetic tenant (as e2e.ts does). */
  async function merchant<T>(routeKey: string, body?: unknown, dropId?: string): Promise<{ status: number; body: T }> {
    const event = {
      routeKey, pathParameters: dropId ? { dropId } : {}, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
      requestContext: { authorizer: { jwt: { claims: { sub: tenant }, scopes: [] } } },
    };
    const r = await lambda.send(new InvokeCommand({ FunctionName: merchantFn, Payload: Buffer.from(JSON.stringify(event)) }));
    const res = JSON.parse(Buffer.from(r.Payload!).toString()) as { statusCode: number; body: string };
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
  }

  // ---- Set up: a shop and one scheduled drop ----
  const t0 = Date.now();
  const entryOpens = t0 + LEAD_MS;
  const openAt = entryOpens + ENTRY_WINDOW_MIN * 60_000;
  const admissionStarts = openAt + GRACE_SEC * 1000;
  const runEnds = admissionStarts + RUN_AFTER_START_MS;
  const profile = await merchant('PUT /m/profile', { name: `Load test x${SCALE}`, paynow: '+65 9000 0000' });
  if (profile.status !== 200) throw new Error(`profile: ${JSON.stringify(profile.body)}`);
  const created = await merchant<Drop>('POST /m/drops', {
    title: `Load x${SCALE}: ${BUYERS} buyers, ${UNITS} units`, variants: [{ name: 'Unit', stock: UNITS, priceCents: 100 }],
    openAt: new Date(openAt).toISOString(), endAt: new Date(runEnds + 60_000).toISOString(),
    entryWindowMin: ENTRY_WINDOW_MIN, graceSec: GRACE_SEC, perBuyerLimit: 1, holdSec: HOLD_SEC, admitWindowSec: ADMIT_WINDOW_SEC,
    ratePreset: 'fast', verification: 'off', shardCount: SHARDS,
  });
  if (created.status !== 201 && created.status !== 200) throw new Error(`create drop: ${JSON.stringify(created.body)}`);
  const dropId = created.body.dropId;
  const variantId = created.body.variants[0]!.id;
  const scheduled = await merchant<Drop>('POST /m/drops/{dropId}/schedule', undefined, dropId);
  if (scheduled.status !== 200) throw new Error(`schedule: ${JSON.stringify(scheduled.body)}`);
  const base = `${api}/api/d/${tenant}/${dropId}`;
  console.log(`drop ${tenant}/${dropId} on ${stage}: ${BUYERS} buyers (x${SCALE}) for ${UNITS} units on ${SHARDS} shards`);
  console.log(`page ${site}/d/${tenant}/${dropId}/`);
  console.log(`queue opens ${new Date(entryOpens).toISOString().slice(11, 19)}Z, admission starts ${new Date(admissionStarts).toISOString().slice(11, 19)}Z, run ends ${new Date(runEnds).toISOString().slice(11, 19)}Z; planned peak ${plannedPeak} joins/s`);

  // ---- One shared poller stands in for every buyer's page (see the header) ----
  let state: PublicState | null = null;
  let liveSeenAt: number | undefined;
  let frozenSeenAt: number | undefined;
  let soldOutSeenAt: number | undefined;
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const tick = Date.now();
      const r = await call('state', `${site}/d/${tenant}/${dropId}/state.json`, { method: 'GET' });
      if (r.status === 200) {
        state = r.body as unknown as PublicState;
        if (state.state === 'Live') liveSeenAt ??= Date.now();
        if (state.earlyCount !== null) frozenSeenAt ??= Date.now();
        if (allSoldOut(state)) soldOutSeenAt ??= Date.now();
      }
      await sleep((tick < entryOpens - 10_000 ? 2000 : 1000) - (Date.now() - tick));
    }
  })();

  async function buyer(i: number, arriveAt: number): Promise<string> {
    await sleep(arriveAt - Date.now());
    // A buyer who arrives to a sold-out page does not join.
    if (gone(state)) return 'arrived after sold out';
    sendLagMs.push(Date.now() - arriveAt);
    const room = openAt - SPREAD_MARGIN_MS - Date.now();
    const spreads = SPREAD_SEC > 0 && room > 0 && spreadRandom() < SPREAD_SHARE;
    const spread = spreads ? spreadRandom() * Math.min(SPREAD_SEC * 1000, room) : 0;
    await sleep(spread);

    let pos: { r?: number; n?: number } | undefined;
    let ticket = '';
    for (let attempt = 1; ; attempt++) {
      const sentSec = Math.floor((Date.now() - entryOpens) / 1000);
      const bucket = joinSeconds.get(sentSec) ?? { sent: 0, ok: 0, throttled: 0, failed: 0 };
      joinSeconds.set(sentSec, bucket);
      bucket.sent++;
      const r = await call('ticket', `${base}/ticket`);
      if (r.status === 201) {
        bucket.ok++;
        ticket = String(r.body.ticket);
        pos = typeof r.body.r === 'number' ? { r: r.body.r } : { n: Number(r.body.n) };
        ticketAttempts[attempt] = (ticketAttempts[attempt] ?? 0) + 1;
        break;
      }
      if (r.status === 429) bucket.throttled++; else bucket.failed++;
      if (attempt >= MAX_ATTEMPTS) return `no ticket (${r.code})`;
      // This machine's clock runs a little ahead of the server's: wait the time the server names, as the page does.
      if (r.code === 'NOT_LIVE' && typeof r.body.retryAfter === 'number') await sleep(r.body.retryAfter * 1000);
      else if (retryable(r)) await backoff(attempt);
      // Refused because the drop closed: judged at the end (counts as arriving after sold out if it had sold out).
      else if (r.code === 'NOT_LIVE') return 'join refused, drop closed';
      else return `no ticket (${r.code})`;
    }
    timeToTicketMs.push(Date.now() - arriveAt);
    spreadDelayMs.push(spread);
    waitAfterSpreadMs.push(Date.now() - arriveAt - spread);
    if (pos.r !== undefined) earlyTickets.push({ arrivedMs: arriveAt - entryOpens, r: pos.r }); else lateTickets++;

    const ticketAt = Date.now();
    while (!admitted(pos, state)) {
      if (gone(state)) return 'saw sold out while waiting';
      if (Date.now() > runEnds) return 'still waiting at the end';
      await sleep(1000 + random() * 500);
    }

    let hold: { token: string; holdId: string } | undefined;
    for (let attempt = 1; !hold; attempt++) {
      const r = await call('claim', `${base}/claim`, { body: { ticket, variantId, qty: 1 } });
      if (r.status === 201) hold = { token: String(r.body.hold), holdId: String(r.body.holdId) };
      else if (r.code === 'VARIANT_SOLD_OUT' && WAITS_FOR_RETURNS) {
        // The Claim button is disabled while everything is reserved; the buyer taps again a moment after it is not.
        while (allSoldOut(state) && !gone(state) && Date.now() < runEnds) await sleep(1000);
        if (gone(state) || Date.now() >= runEnds) return 'admitted, sold out';
        await sleep(1000 + abandonRandom() * 4000);
        attempt = 0;
      }
      else if (r.code === 'VARIANT_SOLD_OUT') return 'admitted, sold out';
      // Waiting for returned stock can outlast the buyer's turn to claim (admitWindowSec).
      else if (r.code === 'ADMISSION_EXPIRED' && WAITS_FOR_RETURNS) return 'turn passed while reserved';
      // The controller closes a drop as soon as everything is sold and confirmed; a claim just after that is refused.
      else if (r.code === 'NOT_LIVE') return 'admitted, drop already closed';
      else if (attempt >= MAX_ATTEMPTS * 2) return `claim failed (${r.code})`;
      else if (r.code === 'NOT_ADMITTED') {
        // The claim endpoint is the real gate; the cached watermark can run a moment ahead of it.
        earlyClaims++;
        await sleep(Math.min(5, Number(r.body.retryAfter ?? 1)) * 1000);
      } else if (retryable(r)) await backoff(attempt);
      else return `claim failed (${r.code})`;
    }

    turnWaitMs.push(Date.now() - Math.max(ticketAt, admissionStarts));
    // Typing a name and an email. The default 1-3 s keeps the earlier runs' think times (same draws from `random`).
    await sleep((CHECKOUT_MIN_SEC + random() * (CHECKOUT_MAX_SEC - CHECKOUT_MIN_SEC)) * 1000);
    if (ABANDON_SHARE > 0 && abandonRandom() < ABANDON_SHARE) { abandoned++; return 'left without confirming'; }
    for (let attempt = 1; ; attempt++) {
      const r = await call('confirm', `${api}/api/holds/${encodeURIComponent(hold.holdId)}/confirm`, {
        token: hold.token, body: { name: `Buyer ${i}`, email: `buyer${i}.${tenant}@example.com` },
      });
      if (r.status === 200) { timeToOrderMs.push(Date.now() - arriveAt); lastOrderAt = Date.now(); return 'ordered'; }
      if (attempt >= MAX_ATTEMPTS || !retryable(r)) return `confirm failed (${r.code})`;
      await backoff(attempt);
    }
  }

  const progress = setInterval(() => {
    const s = state as PublicState | null;
    const t = steps.ticket.codes;
    console.log(`[${Math.round((Date.now() - entryOpens) / 1000)}s] ${s?.state ?? '?'} · tickets ${t.OK ?? 0} (429: ${steps.ticket.throttled}, 5xx: ${steps.ticket.serverErrors}) · claims ${steps.claim.codes.OK ?? 0} · orders ${steps.confirm.codes.OK ?? 0}`);
  }, 10_000);
  const results = await Promise.all(plan.map((offset, i) => buyer(i, entryOpens + offset)));
  clearInterval(progress);
  for (const r of results) outcomes[r] = (outcomes[r] ?? 0) + 1;
  await sleep(Math.max(0, admissionStarts + 5000 - Date.now())); // a tiny run can finish before the freeze is published
  await sleep(4000); // one more tick, so the last poll sees the final flags
  polling = false;
  await poller;

  // ---- What the stage says happened ----
  const live = (await merchant<{ variants: Array<{ id: string; stock: number; out: number }>; activeHolds: number; orders: number; unitsOrdered: number; queue: unknown }>(
    'GET /m/drops/{dropId}/live', undefined, dropId)).body;
  const shardState = await Promise.all(Array.from({ length: SHARDS }, (_, s) =>
    doc.send(new GetCommand({ TableName: tableName, Key: keys.stockShard(tenant, dropId, variantId, s), ConsistentRead: true }))
      .then((r) => ({ shard: s, sold: Number(r.Item?.sold), capacity: Number(r.Item?.capacity) }))));
  const sold = shardState.reduce((n, s) => n + s.sold, 0);
  const finalState = state as PublicState | null;

  const holds = steps.claim.codes.OK ?? 0;
  const orders = steps.confirm.codes.OK ?? 0;
  const ticketed = earlyTickets.length + lateTickets;
  // NOT_LIVE is the right answer to a claim once the drop has sold out and closed, and a wrong one before that.
  const closedSoldOut = finalState?.state === 'Closed' && sold === UNITS;
  const claimRefusals = Object.keys(steps.claim.codes).filter((c) => !['OK', 'VARIANT_SOLD_OUT', 'NOT_ADMITTED', ...(closedSoldOut ? ['NOT_LIVE'] : []), ...(WAITS_FOR_RETURNS ? ['ADMISSION_EXPIRED'] : [])].includes(c));
  const confirmRefusals = Object.keys(steps.confirm.codes).filter((c) => c !== 'OK');
  const checks = {
    // An abandoned hold's unit goes back to stock when the hold expires, so it is not sold.
    // A hold still running when the run ends (an abandoned one not yet expired) also keeps its unit.
    soldEqualsHolds: sold === holds - abandoned + live.activeHolds,
    noShardOverCapacity: shardState.every((s) => s.sold <= s.capacity),
    soldIsMinBuyersUnits: sold === Math.min(ticketed, UNITS),
    ordersEqualSold: orders === sold - live.activeHolds && live.orders === orders,
    // Throttling, server errors and network errors are headroom (below); any other refusal is a wrong answer.
    noUnexpectedRefusals: [...claimRefusals, ...confirmRefusals].every((c) => c === 'HTTP_429' || c === 'INTERNAL' || /^HTTP_5/.test(c) || c.startsWith('NETWORK')),
    liveByEntryTime: liveSeenAt !== undefined && liveSeenAt <= entryOpens + 1000,
    // The draw must hold exactly the buyers who were given a ticket. A request lost on the network may have counted,
    // hence the range; a request the server refused must not have (each one is a phantom ahead of real buyers).
    earlyCountMatchesTickets: finalState?.earlyCount != null && finalState.earlyCount >= earlyTickets.length && finalState.earlyCount <= earlyTickets.length + steps.ticket.networkErrors,
  };

  // ---- What AWS says it took: copies of each function used, and how many were left over from before the run ----
  let functions: Record<string, FunctionUsage> | null = null;
  let account: AccountUsage | null = null;
  try {
    ({ account, functions } = await stageUsage(stage!, ['Ticket', 'Claim', 'Checkout'], entryOpens - 5000, Date.now()));
  } catch (e) {
    console.log(`could not read function usage from AWS: ${(e as Error).message}`);
  }
  const ticketFn = functions?.ticket;
  // A handful of leftover copies among hundreds does not change a run; one in twenty is where it is called warm.
  const COLD_MAX_WARM_SHARE = 0.05;
  const coldStart = ticketFn ? (ticketFn.warmShare ?? 0) <= COLD_MAX_WARM_SHARE : null;

  // ---- Headroom: where the stage starts to give ----
  const buyerSteps = ['ticket', 'claim', 'confirm'] as const;
  const throttled = buyerSteps.reduce((n, s) => n + steps[s].throttled, 0);
  const serverErrors = buyerSteps.reduce((n, s) => n + steps[s].serverErrors, 0);
  const networkErrors = buyerSteps.reduce((n, s) => n + steps[s].networkErrors, 0);
  const failingSeconds = [...joinSeconds.entries()].filter(([, v]) => v.failed + v.throttled > 0).map(([t]) => t);
  // Sold out and closed between two polls of state.json (1 Hz): those buyers arrived after sold out, not refused.
  if (closedSoldOut && outcomes['join refused, drop closed']) {
    outcomes['arrived after sold out'] = (outcomes['arrived after sold out'] ?? 0) + outcomes['join refused, drop closed']!;
    delete outcomes['join refused, drop closed'];
  }
  const noTicket = Object.entries(outcomes).filter(([o]) => o.startsWith('no ticket') || o === 'join refused, drop closed').reduce((n, [, v]) => n + v, 0);
  const lag = latency(sendLagMs);
  const degradation = {
    throttled429: throttled, server5xx: serverErrors, networkErrors, buyersWithoutTicket: noTicket,
    // Tickets the stage counted in the draw without handing them to a buyer.
    drawPhantoms: finalState?.earlyCount == null ? null : finalState.earlyCount - earlyTickets.length,
    joinsFailingUntilSecAfterOpen: failingSeconds.length ? Math.max(...failingSeconds) : null,
    buyersWhoRetriedTheJoin: Object.entries(ticketAttempts).filter(([a]) => Number(a) > 1).reduce((n, [, v]) => n + v, 0),
    // Above a second, this machine could not keep to the arrival curve and the peak below is understated.
    clientSaturated: lag.p99 > 1000,
  };
  const firstDegradation = noTicket > 0 ? `${noTicket} buyers never got a ticket after ${MAX_ATTEMPTS} tries`
    : serverErrors > 0 ? `${serverErrors} server errors (5xx); every buyer got through on a retry`
    : throttled > 0 ? `${throttled} requests throttled (429); every buyer got through on a retry`
    : networkErrors > 0 ? `${networkErrors} network errors on this machine`
    : 'none';

  const seconds = [...joinSeconds.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v }));
  const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / Math.max(1, xs.length);
  const ma = mean(earlyTickets.map((e) => e.arrivedMs));
  const mr = mean(earlyTickets.map((e) => e.r));
  const cov = earlyTickets.reduce((n, e) => n + (e.arrivedMs - ma) * (e.r - mr), 0);
  const va = earlyTickets.reduce((n, e) => n + (e.arrivedMs - ma) ** 2, 0);
  const vr = earlyTickets.reduce((n, e) => n + (e.r - mr) ** 2, 0);

  const summary = {
    at: new Date().toISOString(), experiment: 'load', stage, scale: SCALE, drop: `${tenant}/${dropId}`,
    pass: Object.values(checks).every(Boolean), checks, firstDegradation, degradation,
    // true when at most 5% of the ticket copies used were left running from before; runs that differ here are not comparable.
    coldStart, account, functions,
    config: {
      buyers: BUYERS, units: UNITS, shards: SHARDS, seed: SEED, ratePreset: 'fast', admissionRatePerMin: ratePerMin, holdSec: HOLD_SEC,
      entryWindowMin: ENTRY_WINDOW_MIN, graceSec: GRACE_SEC, burstShare: BURST_SHARE, spikeSec: SPIKE_SEC, lateShare: LATE_SHARE, connections: CONNECTIONS, spreadSec: SPREAD_SEC, spreadShare: SPREAD_SHARE,
      checkoutSec: [CHECKOUT_MIN_SEC, CHECKOUT_MAX_SEC], abandonShare: ABANDON_SHARE,
      polling: 'one shared poller at 1 Hz; the crowd\'s polling is not reproduced',
    },
    timeline: {
      entryOpensAt: new Date(entryOpens).toISOString(), admissionStartsAt: new Date(admissionStarts).toISOString(),
      liveSecBeforeEntry: liveSeenAt === undefined ? null : Math.round((entryOpens - liveSeenAt) / 1000),
      freezeSeenSecAfterAdmission: frozenSeenAt === undefined ? null : Math.round((frozenSeenAt - admissionStarts) / 100) / 10,
      soldOutSeenSecAfterAdmission: soldOutSeenAt === undefined ? null : Math.round((soldOutSeenAt - admissionStarts) / 100) / 10,
      lastOrderSecAfterAdmission: lastOrderAt === undefined ? null : Math.round((lastOrderAt - admissionStarts) / 100) / 10,
    },
    peakJoinsPerSec: { planned: plannedPeak, sent: Math.max(0, ...seconds.map((s) => s.sent)), accepted: Math.max(0, ...seconds.map((s) => s.ok)) },
    buyers: {
      outcomes, withTicket: ticketed, early: earlyTickets.length, late: lateTickets, ticketAttempts,
      timeToTicketMs: latency(timeToTicketMs), spreadDelayMs: latency(spreadDelayMs), waitAfterSpreadMs: latency(waitAfterSpreadMs), sendLagMs: lag, claimsBeforeTheirTurn: earlyClaims,
      turnWaitMs: latency(turnWaitMs), timeToOrderMs: latency(timeToOrderMs), leftWithoutConfirming: abandoned,
    },
    steps: Object.fromEntries((Object.keys(steps) as Step[]).map((s) => [s, {
      requests: steps[s].ms.length, throttled429: steps[s].throttled, server5xx: steps[s].serverErrors, networkErrors: steps[s].networkErrors,
      codes: steps[s].codes, latencyMs: latency(steps[s].ms),
    }])),
    server: { unitsOut: sold, shardState, orders: live.orders, unitsOrdered: live.unitsOrdered, activeHolds: live.activeHolds, earlyCount: finalState?.earlyCount ?? null, queue: live.queue },
    // Arrival order against draw position in the early group: near 0 means arriving first bought no advantage.
    fairness: { earlyTickets: earlyTickets.length, arrivalVsDrawCorrelation: va && vr ? Math.round((cov / Math.sqrt(va * vr)) * 1000) / 1000 : null },
    joinsPerSecond: seconds,
  };

  const resultsDir = path.join(import.meta.dirname, 'results');
  const dir = path.join(resultsDir, `${summary.at.slice(0, 10)}-load`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${summary.at.slice(11, 19).replace(/:/g, '')}-x${SCALE}-${stage}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  const summaryFile = path.join(resultsDir, 'SUMMARY.md');
  if (!existsSync(summaryFile)) writeFileSync(summaryFile, '# Results, one line per run\n\n| When (UTC) | Experiment | Stage | Workload | Result | Headline | File |\n| --- | --- | --- | --- | --- | --- | --- |\n');
  const t = summary.steps.ticket!.latencyMs;
  const c = summary.steps.claim!.latencyMs;
  appendFileSync(summaryFile, `| ${summary.at.slice(0, 16).replace('T', ' ')} | load x${SCALE} | ${stage} | ${BUYERS} buyers, ${UNITS} units, peak ${summary.peakJoinsPerSec.sent} joins/s | ${summary.pass ? 'PASS' : 'FAIL'} | join p99 ${t.p99} ms, claim p99 ${c.p99} ms; first degradation: ${firstDegradation}; ticket copies ${ticketFn ? `${ticketFn.startedInWindow} new + ${ticketFn.alreadyRunning} already running` : 'not read'} | ${path.relative(resultsDir, file)} |\n`);

  const row = (name: string, s: Step) => `  ${name.padEnd(8)} ${String(summary.steps[s]!.requests).padStart(7)} requests   p50 ${String(summary.steps[s]!.latencyMs.p50).padStart(5)} ms   p95 ${String(summary.steps[s]!.latencyMs.p95).padStart(5)} ms   p99 ${String(summary.steps[s]!.latencyMs.p99).padStart(5)} ms`;
  console.log(`\n${summary.pass ? 'PASS' : 'FAIL'} · load x${SCALE} on ${stage} · ${BUYERS} buyers, ${UNITS} units`);
  console.log(`  sold ${sold} of ${UNITS}, orders ${orders}, buyers with a ticket ${ticketed} of ${BUYERS}`);
  console.log(`  peak joins per second: planned ${plannedPeak}, sent ${summary.peakJoinsPerSec.sent}, accepted ${summary.peakJoinsPerSec.accepted}`);
  console.log([row('join', 'ticket'), row('claim', 'claim'), row('confirm', 'confirm'), row('poll', 'state')].join('\n'));
  const pc = (x: number | null) => (x === null ? '?' : `${Math.round(x * 100)}%`);
  for (const [name, f] of Object.entries(functions ?? {})) {
    console.log(`  ${(name + ' function').padEnd(17)} ${String(f.copiesUsed).padStart(4)} copies used: ${f.startedInWindow} started during the run, ${f.alreadyRunning} already running (${pc(f.warmShare)} warm) · peak ${f.peakAtOnce ?? '?'} at once (${pc(f.peakShareOfLimit)} of the limit) · ${f.refusedByLambda ?? '?'} refused by Lambda`);
  }
  if (account) console.log(`  whole account     limit ${account.limit} at once · peak ${account.peakAtOnce ?? '?'} (${pc(account.peakShareOfLimit)}) across every function and stage`);
  if (coldStart === false) console.log(`  NOT A COLD START: ${ticketFn!.alreadyRunning} of ${ticketFn!.copiesUsed} ticket copies were left running from before. Compare only with runs that say the same.`);
  else if (coldStart) console.log(`  cold start: ${ticketFn!.alreadyRunning} of ${ticketFn!.copiesUsed} ticket copies were left running from before`);
  const w = (xs: number[]) => { const l = latency(xs); return `min ${(l.min / 1000).toFixed(2)} s · avg ${(l.mean / 1000).toFixed(2)} s · max ${(l.max / 1000).toFixed(2)} s`; };
  console.log(`  wait for a ticket (arrival to ticket): ${w(timeToTicketMs)}`);
  if (SPREAD_SEC > 0) console.log(`    of which spreading: ${w(spreadDelayMs)}; the rest: ${w(waitAfterSpreadMs)}`);
  console.log(`  admission start or ticket to hold (their turn): ${w(turnWaitMs)}`);
  console.log(`  arrival to order: ${w(timeToOrderMs)} · last order ${summary.timeline.lastOrderSecAfterAdmission ?? '?'} s after admission${abandoned ? ` · ${abandoned} left without confirming` : ''}`);
  console.log(`  first degradation: ${firstDegradation}${degradation.clientSaturated ? '  (this machine fell behind the arrival curve; treat the peak as a lower bound)' : ''}`);
  for (const [name, ok] of Object.entries(checks)) if (!ok) console.log(`  FAILED CHECK: ${name}`);
  console.log(`wrote ${path.relative(process.cwd(), file)} and a line in ${path.relative(process.cwd(), summaryFile)}`);
  process.exitCode = summary.pass ? 0 : 1;
}

await main();
