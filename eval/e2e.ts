/**
 * End-to-end smoke test of a deployed stage, in real time (~9 minutes). Exercises what only a deploy can prove:
 * EventBridge opening a drop, the per-minute tick schedule, the early-group freeze, claims, checkout, a hold
 * expiring back to stock, closing at endAt, and cancelling a Live drop.
 *
 *   AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1 pnpm --filter @dropdeck/eval e2e -- --stage dev-simon
 *
 * Merchant calls invoke the merchant Lambda directly with a synthetic tenant (console sign-in needs a browser);
 * buyer calls go through the public API and CloudFront exactly as the page does.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import type { Drop, PublicState } from '@dropdeck/shared';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { stage: { type: 'string' } },
});
const stage = args.stage;
if (!stage) throw new Error('--stage is required');

const steps: Array<{ at: string; step: string; ok: boolean; detail?: unknown }> = [];
/** Thrown by need(): later steps depend on this one, so stop and report instead of cascading. */
class Stop extends Error {}
const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
function check(step: string, ok: boolean, detail?: unknown) {
  steps.push({ at: since(), step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${since()}] ${step}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}
function need(step: string, ok: boolean, detail?: unknown) {
  check(step, ok, detail);
  if (!ok) throw new Stop(step);
}
const sleepUntil = async (ms: number) => { while (Date.now() < ms) await new Promise((r) => setTimeout(r, Math.min(1000, ms - Date.now()))); };

async function stack() {
  const cf = new CloudFormationClient({});
  const name = `DropDeck-${stage}`;
  const out = Object.fromEntries(((await cf.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0]?.Outputs ?? [])
    .map((o) => [o.OutputKey!, o.OutputValue!]));
  const fns = (await cf.send(new ListStackResourcesCommand({ StackName: name }))).StackResourceSummaries ?? [];
  const fn = (prefix: string) => fns.find((r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId?.startsWith(prefix))!.PhysicalResourceId!;
  return { site: out.SiteUrl!, api: out.ApiUrl!, merchantFn: fn('MerchantApi') };
}

async function main() {
  const { site, api, merchantFn } = await stack();
  const lambda = new LambdaClient({});
  const scheduler = new SchedulerClient({});
  const tenant = `e2e-${randomUUID().slice(0, 8)}`;

  /** Calls the merchant Lambda as the API Gateway JWT authorizer would, for a synthetic tenant. */
  async function merchant<T>(routeKey: string, body?: unknown, dropId?: string): Promise<{ status: number; body: T }> {
    const event = {
      routeKey, pathParameters: dropId ? { dropId } : {}, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false,
      requestContext: { authorizer: { jwt: { claims: { sub: tenant }, scopes: [] } } },
    };
    const r = await lambda.send(new InvokeCommand({ FunctionName: merchantFn, Payload: Buffer.from(JSON.stringify(event)) }));
    const res = JSON.parse(Buffer.from(r.Payload!).toString()) as { statusCode: number; body: string };
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : null) as T };
  }
  async function buyer<T = Record<string, unknown>>(p: string, body?: unknown, token?: string) {
    const r = await fetch(`${api}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as T & { code?: string; retryAfter?: number } };
  }
  const state = async (d: string) => (await fetch(`${site}/d/${tenant}/${d}/state.json`)).json() as Promise<PublicState>;
  const waitFor = async (what: string, until: number, pred: () => Promise<boolean>) => {
    while (Date.now() < until) {
      if (await pred()) return true;
      await new Promise((r) => setTimeout(r, 2000));
    }
    check(`timed out waiting: ${what}`, false);
    return false;
  };

  // ---- Set up: profile and two drops opening together (one runs its course, one is cancelled while Live) ----
  check('profile saved', (await merchant('PUT /m/profile', { name: 'E2E Bakery', paynow: '+65 9000 0000' })).status === 200);
  const openAt = t0 + 270_000; // entry window at +210 s: the 3-minute scheduling lead plus slack
  const spec = (title: string) => ({
    title, variants: [{ name: 'Loaf', stock: 2, priceCents: 800 }],
    openAt: new Date(openAt).toISOString(), endAt: new Date(openAt + 240_000).toISOString(),
    entryWindowMin: 1, graceSec: 30, perBuyerLimit: 1, holdSec: 120, admitWindowSec: 300,
    ratePreset: 'fast', verification: 'off', shardCount: 1,
  });
  const main = (await merchant<Drop>('POST /m/drops', spec('E2E main'))).body;
  const doomed = (await merchant<Drop>('POST /m/drops', spec('E2E cancel'))).body;
  for (const d of [main, doomed]) {
    const r = await merchant<Drop>('POST /m/drops/{dropId}/schedule', undefined, d.dropId);
    check(`scheduled ${d.title}`, r.status === 200 && r.body.state === 'Scheduled', r.status === 200 ? undefined : r.body);
  }
  const page = await fetch(`${site}/d/${tenant}/${main.dropId}/`);
  check('drop page and drop.json served', page.ok && (await fetch(`${site}/d/${tenant}/${main.dropId}/drop.json`)).ok);
  check('state.json says Scheduled before open', (await state(main.dropId)).state === 'Scheduled');

  // ---- EventBridge opens both 90 s ahead of entryOpensAt (OPEN_LEAD_MS), so they are Live in time ----
  const entryOpens = openAt - 60_000;
  await sleepUntil(entryOpens - 5_000);
  const early = await buyer(`/api/d/${tenant}/${main.dropId}/ticket`);
  check('no tickets before the advertised entry time', early.status === 409 && early.body.code === 'NOT_LIVE', early.body.code);
  await sleepUntil(entryOpens);
  for (const d of [main, doomed]) {
    const live = await waitFor(`${d.title} Live`, entryOpens + 10_000, async () => (await state(d.dropId)).state === 'Live');
    need(`${d.title} Live by the advertised entry time (scheduler lag absorbed by the lead)`, live, { secAfterEntry: Math.round((Date.now() - entryOpens) / 1000) });
  }
  const tick = await scheduler.send(new GetScheduleCommand({ Name: `tick-${main.dropId}`, GroupName: `dropdeck-${stage}` })).catch((e) => e as Error);
  check('per-minute tick schedule created', !(tick instanceof Error) && tick.ScheduleExpression === 'rate(1 minute)', tick instanceof Error ? tick.name : undefined);

  // ---- Three buyers join the draw before open; one buyer on the doomed drop ----
  const tickets = await Promise.all([1, 2, 3].map(() => buyer<{ ticket: string; r?: number }>(`/api/d/${tenant}/${main.dropId}/ticket`)));
  need('early tickets carry a random draw position', tickets.every((t) => t.status === 201 && typeof t.body.r === 'number'), tickets.map((t) => t.body.code ?? t.status));
  const doomedTicket = await buyer<{ ticket: string }>(`/api/d/${tenant}/${doomed.dropId}/ticket`);
  need('ticket on the drop that will be cancelled', doomedTicket.status === 201, doomedTicket.body.code);

  // ---- Admission: freeze, then claims as the watermark passes each ticket ----
  const start = openAt + 30_000;
  await waitFor('early group frozen', start + 70_000, async () => (await state(main.dropId)).earlyCount === 3);
  check('early group frozen at 3', (await state(main.dropId)).earlyCount === 3);
  async function claimWhenAdmitted(drop: Drop, ticket: string) {
    for (;;) {
      const r = await buyer<{ hold: string; holdId: string }>(`/api/d/${tenant}/${drop.dropId}/claim`, { ticket, variantId: 'v1', qty: 1 });
      if (r.body.code !== 'NOT_ADMITTED') return r;
      await new Promise((res) => setTimeout(res, (r.body.retryAfter ?? 2) * 1000));
    }
  }
  const [a, b, c] = await Promise.all(tickets.map((t) => claimWhenAdmitted(main, t.body.ticket)));
  const claims = [a!, b!, c!];
  const held = claims.filter((r) => r.status === 201);
  const refused = claims.filter((r) => r.status !== 201);
  need('two of three buyers hold the two units; the third is refused sold out', held.length === 2 && refused[0]?.body.code === 'VARIANT_SOLD_OUT', claims.map((r) => r.body.code ?? r.status));
  const doomedHold = await claimWhenAdmitted(doomed, doomedTicket.body.ticket);
  need('buyer holds a unit on the drop that will be cancelled', doomedHold.status === 201, doomedHold.body.code);

  // ---- Cancel the second drop while a hold is open ----
  check('merchant cancels a Live drop', (await merchant<Drop>('POST /m/drops/{dropId}/cancel', undefined, doomed.dropId)).body.state === 'Cancelled');
  await waitFor('cancelled state.json', Date.now() + 70_000, async () => (await state(doomed.dropId)).state === 'Cancelled');
  check('page shows Cancelled', (await state(doomed.dropId)).state === 'Cancelled');
  const refusedOnCancel = await buyer(`/api/holds/${encodeURIComponent(doomedHold.body.holdId)}/confirm`, { name: 'X', email: 'x@example.com' }, doomedHold.body.hold);
  check('checkout refused on the cancelled drop', refusedOnCancel.status !== 200, refusedOnCancel.body.code);

  // ---- One holder confirms; the other lets the hold expire ----
  const [first, second] = held;
  const order = await buyer<{ orderRef: string; merchant: { paynow?: string } }>(
    `/api/holds/${encodeURIComponent(first!.body.holdId)}/confirm`, { name: 'Ann', email: `ann+${tenant}@example.com` }, first!.body.hold);
  need('first holder confirms and sees PayNow details', order.status === 200 && order.body.merchant?.paynow === '+65 9000 0000', order.body.orderRef ?? order.body.code);
  await waitFor('sold-out flag', Date.now() + 15_000, async () => (await state(main.dropId)).soldOut?.v1 === true);
  check('sold-out flag published', (await state(main.dropId)).soldOut?.v1 === true);

  const unheld = refused[0] ? tickets[claims.indexOf(refused[0])]! : undefined;
  void second;
  await waitFor('expired hold returned to stock', Date.now() + 200_000, async () => (await state(main.dropId)).soldOut?.v1 === false);
  check('expired hold went back to stock and the flag cleared', (await state(main.dropId)).soldOut?.v1 === false);
  if (unheld) {
    const retry = await buyer<{ hold: string; holdId: string }>(`/api/d/${tenant}/${main.dropId}/claim`, { ticket: unheld.body.ticket, variantId: 'v1', qty: 1 });
    check('the refused buyer now gets the returned unit', retry.status === 201, retry.body.code);
  }

  // ---- Close at endAt ----
  const endAt = openAt + 240_000;
  await sleepUntil(endAt);
  await waitFor('Closed', endAt + 75_000, async () => (await state(main.dropId)).state === 'Closed');
  check('drop closed at endAt', (await state(main.dropId)).state === 'Closed');
  const gone = await scheduler.send(new GetScheduleCommand({ Name: `tick-${main.dropId}`, GroupName: `dropdeck-${stage}` })).then(() => false, () => true);
  check('tick schedule deleted on close', gone);
  const late = await buyer(`/api/d/${tenant}/${main.dropId}/ticket`);
  check('no new tickets after close', late.status === 409, late.body.code);

  return { tenant, drops: [main.dropId, doomed.dropId] };
}

async function run() {
  let ids: { tenant?: string; drops?: string[] } = {};
  try {
    ids = await main();
  } catch (e) {
    if (!(e instanceof Stop)) check(`crashed: ${(e as Error).message}`, false);
  }
  const failed = steps.filter((s) => !s.ok);
  const summary = { at: new Date().toISOString(), stage, ...ids, pass: failed.length === 0, steps };
  const dir = path.join(import.meta.dirname, 'results', `${summary.at.slice(0, 10)}-e2e`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${summary.at.slice(11, 19).replace(/:/g, '')}-${stage}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`${summary.pass ? 'ALL PASS' : `${failed.length} FAILED`} · wrote ${path.relative(process.cwd(), file)}`);
  process.exitCode = summary.pass ? 0 : 1;
}

await run();
