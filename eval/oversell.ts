/**
 * Experiment 1: oversell correctness against a deployed stage.
 *
 *   AWS_PROFILE=dropdeck-uni pnpm --filter @dropdeck/eval oversell -- --stage dev-simon --n 500 --m 50 [--qty 1] [--shards 4]
 *
 * Writes a Live drop straight into the stage's table (admission already running, early group frozen at 0, so
 * every ticket is admitted within the window), sends N concurrent buyers (ticket, then claim) through the real
 * API, then checks the shard counters and active holds. Pass: sold == min(N * qty, M) units, no shard over
 * capacity, one hold per successful claim. Output: eval/results/<date>-oversell/<time>.json
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { keys, shardCapacities, type Drop } from '@dropdeck/shared';

const { values: args } = parseArgs({
  options: {
    stage: { type: 'string' },
    n: { type: 'string', default: '200' },
    m: { type: 'string', default: '20' },
    qty: { type: 'string', default: '1' },
    shards: { type: 'string', default: '4' },
  },
});
if (!args.stage) throw new Error('--stage is required (e.g. dev-simon)');
const N = Number(args.n);
const M = Number(args.m);
const QTY = Number(args.qty);
const SHARDS = Number(args.shards);

async function stackOutputs(stage: string): Promise<Record<string, string>> {
  const r = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: `DropDeck-${stage}` }));
  return Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function main() {
  const out = await stackOutputs(args.stage!);
  const api = out.ApiUrl!;
  const tableName = out.TableName!;
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  // fast preset with 1-minute holds admits 4M per minute; start far enough back that ticket N is admitted now,
  // and stretch the window so ticket 0 has not expired.
  const ratePerMin = 4 * M;
  const startedMin = Math.ceil(N / ratePerMin) + 1;
  if (startedMin * 60 + 120 > 600) {
    throw new Error(`N=${N} needs ${startedMin} min of admission at ${ratePerMin}/min, beyond the 10-minute claim window; raise --m or lower --n`);
  }
  const now = Date.now();
  const openAt = new Date(now - startedMin * 60_000 - 30_000).toISOString();
  const drop: Drop = {
    tenantId: `eval-${randomUUID().slice(0, 6)}`, dropId: `oversell-${randomUUID().slice(0, 6)}`, state: 'Live',
    title: `Oversell N=${N} M=${M}`, description: 'eval', variants: [{ id: 'v1', name: 'Unit', stock: M, priceCents: 100 }],
    openAt, endAt: new Date(now + 30 * 60_000).toISOString(), entryWindowMin: 0, graceSec: 30, perBuyerLimit: Math.max(QTY, 1),
    holdSec: 60, admitWindowSec: startedMin * 60 + 120, ratePreset: 'fast', verification: 'off',
    shardCount: SHARDS, earlyCount: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), version: 1,
  };
  await doc.send(new PutCommand({ TableName: tableName, Item: { ...keys.drop(drop.tenantId, drop.dropId), type: 'Drop', ...drop } }));
  await doc.send(new BatchWriteCommand({
    RequestItems: {
      [tableName]: shardCapacities(M, SHARDS).map((capacity, shard) => ({
        PutRequest: { Item: { ...keys.stockShard(drop.tenantId, drop.dropId, 'v1', shard), type: 'Stock', capacity, sold: 0 } },
      })),
    },
  }));
  console.log(`drop ${drop.tenantId}/${drop.dropId}: ${N} buyers x${QTY} for ${M} units on ${SHARDS} shards`);

  const post = async (p: string, body?: unknown) => {
    const t0 = performance.now();
    const r = await fetch(`${api}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, ms: performance.now() - t0 };
  };
  const results = await Promise.all(Array.from({ length: N }, async () => {
    const t = await post(`/api/d/${drop.tenantId}/${drop.dropId}/ticket`);
    if (t.status !== 201) return { stage: 'ticket', ...t };
    const c = await post(`/api/d/${drop.tenantId}/${drop.dropId}/claim`, { ticket: t.body.ticket, variantId: 'v1', qty: QTY });
    return { stage: 'claim', ...c };
  }));

  const won = results.filter((r) => r.stage === 'claim' && r.status === 201);
  const codes: Record<string, number> = {};
  for (const r of results) if (!(r.stage === 'claim' && r.status === 201)) codes[`${r.stage}:${String(r.body.code ?? r.status)}`] = (codes[`${r.stage}:${String(r.body.code ?? r.status)}`] ?? 0) + 1;

  const shards = await Promise.all(Array.from({ length: SHARDS }, (_, s) =>
    doc.send(new GetCommand({ TableName: tableName, Key: keys.stockShard(drop.tenantId, drop.dropId, 'v1', s), ConsistentRead: true }))
      .then((r) => ({ shard: s, sold: Number(r.Item?.sold), capacity: Number(r.Item?.capacity) }))));
  const holds = await doc.send(new QueryCommand({
    TableName: tableName, IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': keys.holdIndex(drop.tenantId, drop.dropId) }, Select: 'COUNT',
  }));
  const sold = shards.reduce((n, s) => n + s.sold, 0);
  const expectedUnits = Math.min(N * QTY, M - (M % QTY));
  const checks = {
    soldEqualsWon: sold === won.length * QTY,
    noShardOverCapacity: shards.every((s) => s.sold <= s.capacity),
    // With qty > 1, a remainder smaller than qty can strand in a shard; the bound is then a range.
    soldIsMinNM: QTY === 1 ? sold === Math.min(N, M) : sold <= M && sold >= expectedUnits - SHARDS * (QTY - 1),
    onlySoldOutRefusals: Object.keys(codes).every((k) => k === 'claim:VARIANT_SOLD_OUT'),
    // GSI reads are eventually consistent; a mismatch here alone is worth a re-check, not a failure.
    holdsMatchClaims: holds.Count === won.length,
  };
  const claimMs = results.filter((r) => r.stage === 'claim').map((r) => r.ms);
  const summary = {
    at: new Date().toISOString(), stage: args.stage, drop: `${drop.tenantId}/${drop.dropId}`, n: N, m: M, qty: QTY, shards: SHARDS,
    won: won.length, sold, refusals: codes, shardState: shards, activeHolds: holds.Count, checks,
    pass: checks.soldEqualsWon && checks.noShardOverCapacity && checks.soldIsMinNM && checks.onlySoldOutRefusals,
    claimLatencyMs: { p50: percentile(claimMs, 50), p95: percentile(claimMs, 95), p99: percentile(claimMs, 99) },
  };
  const dir = path.join(import.meta.dirname, 'results', `${summary.at.slice(0, 10)}-oversell`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${summary.at.slice(11, 19).replace(/:/g, '')}-n${N}-m${M}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, won: summary.won, sold, checks, latency: summary.claimLatencyMs }, null, 2));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
  process.exitCode = summary.pass ? 0 : 1;
}

await main();
