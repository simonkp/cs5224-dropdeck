/**
 * Operator jobs for one stage, from a laptop with AWS access.
 *
 *   pnpm ops -- <stage> tenants                    list shops (the TENANTS registry)
 *   pnpm ops -- <stage> backfill                   add shops saved before the registry existed
 *   pnpm ops -- <stage> make-operator <email>      give a console login access to /ops/ and /admin/*
 *   pnpm ops -- <stage> delete-tenant <tenantId>   delete a shop and all its data (PDPA); asks you to type its link
 *
 * Uses AWS_PROFILE (default dropdeck-uni) and AWS_REGION (default ap-southeast-1).
 */
import { createInterface } from 'node:readline/promises';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminAddUserToGroupCommand, AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@dropdeck/shared';

process.env.AWS_PROFILE ??= 'dropdeck-uni';
process.env.AWS_REGION ??= 'ap-southeast-1';

const [stage, command, arg] = process.argv.slice(2).filter((a) => a !== '--');
const flags = process.argv.slice(2);
if (!stage || !command) {
  console.log('Usage: pnpm ops -- <stage> tenants | backfill | make-operator <email> | delete-tenant <tenantId> [--confirm <slug>]');
  process.exit(1);
}

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});
const scheduler = new SchedulerClient({});

const out = Object.fromEntries(((await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: `DropDeck-${stage}` }))).Stacks?.[0]?.Outputs ?? [])
  .map((o) => [o.OutputKey!, o.OutputValue!]));
const table = out.TableName!;
const bucket = out.BucketName!;
const pool = out.UserPoolId!;

async function queryAll(pk: string, prefix = ''): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': prefix }, ExclusiveStartKey: start,
    }));
    items.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}

async function deleteKeys(list: Array<{ PK: unknown; SK: unknown }>): Promise<void> {
  for (let i = 0; i < list.length; i += 25) {
    let batch: Record<string, unknown>[] | undefined = list.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } }));
    for (let attempt = 0; batch?.length && attempt < 6; attempt++) {
      const r = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: batch as never } }));
      batch = r.UnprocessedItems?.[table] as Record<string, unknown>[] | undefined;
      if (batch?.length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
    }
  }
}

async function deletePrefix(prefix: string): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const objects = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    n += objects.length;
    token = r.NextContinuationToken;
  } while (token);
  return n;
}

async function userBySub(sub: string) {
  const r = await cognito.send(new ListUsersCommand({ UserPoolId: pool, Filter: `sub = "${sub.replace(/"/g, '')}"`, Limit: 1 }));
  return r.Users?.[0];
}

switch (command) {
  case 'tenants': {
    const rows = await queryAll(keys.tenantsPrefix().PK, keys.tenantsPrefix().SKPrefix);
    for (const r of rows) console.log(`${String(r.tenantId).padEnd(40)} ${String(r.slug ?? '').padEnd(24)} ${r.name}`);
    console.log(`${rows.length} shop(s) on ${stage}`);
    break;
  }

  case 'backfill': {
    // Profiles predating the registry: one scan, filtered to profile items.
    let start: Record<string, unknown> | undefined;
    let added = 0;
    do {
      const r = await doc.send(new ScanCommand({
        TableName: table, FilterExpression: 'SK = :p', ExpressionAttributeValues: { ':p': 'PROFILE' }, ExclusiveStartKey: start,
      }));
      for (const p of r.Items ?? []) {
        await doc.send(new PutCommand({
          TableName: table,
          Item: { ...keys.tenantEntry(String(p.tenantId)), type: 'Tenant', tenantId: p.tenantId, name: p.name, slug: p.slug, updatedAt: new Date().toISOString() },
        }));
        added++;
      }
      start = r.LastEvaluatedKey;
    } while (start);
    console.log(`registry now covers ${added} profile(s) on ${stage}`);
    break;
  }

  case 'make-operator': {
    if (!arg) throw new Error('make-operator needs the console login email');
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: pool, Filter: `email = "${arg.replace(/"/g, '')}"`, Limit: 1 }));
    const user = r.Users?.[0];
    if (!user) throw new Error(`No console login ${arg} on ${stage}`);
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: pool, Username: user.Username!, GroupName: 'operators' }));
    console.log(`${arg} is now an operator on ${stage}. Sign out and in again, then open ${out.SiteUrl}/ops/`);
    break;
  }

  case 'delete-tenant': {
    if (!arg) throw new Error('delete-tenant needs a tenant id (see: pnpm ops -- <stage> tenants)');
    const t = arg;
    const profile = (await doc.send(new GetCommand({ TableName: table, Key: keys.profile(t) }))).Item;
    const slug = profile?.slug as string | undefined;
    const label = slug ?? t;
    const given = flags.includes('--confirm') ? flags[flags.indexOf('--confirm') + 1] : undefined;
    const typed = given ?? (await createInterface({ input: process.stdin, output: process.stdout })
      .question(`Delete shop "${profile?.name ?? '(no profile)'}" (${t}) on ${stage}, with all its drops, orders, images and sign-in?\nType ${label} to confirm: `));
    if (typed?.trim() !== label) {
      console.log('Not confirmed; nothing deleted.');
      process.exit(1);
    }

    // 1. Items under the shop's own partition: profile, drops, orders, usage, upload counters.
    const own = await queryAll(`T#${t}`);
    const dropIds = own.filter((i) => String(i.SK).startsWith('DROP#')).map((i) => String(i.dropId));
    // 2. Per-drop items keyed elsewhere: stock shards, queue counters, holds (names and emails), per-email limits.
    const prefixes = [`S#${t}#`, `Q#${t}#`, `H#${t}#`, `L#${t}#`];
    const scattered: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await doc.send(new ScanCommand({
        TableName: table,
        FilterExpression: prefixes.map((_, i) => `begins_with(PK, :p${i})`).join(' OR '),
        ExpressionAttributeValues: Object.fromEntries(prefixes.map((p, i) => [`:p${i}`, p])),
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: start,
      }));
      scattered.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    await deleteKeys([...own, ...scattered] as Array<{ PK: unknown; SK: unknown }>);
    // 3. The shop link and the registry entry.
    if (slug) {
      await doc.send(new DeleteCommand({ TableName: table, Key: keys.slug(slug), ConditionExpression: 'attribute_not_exists(PK) OR tenantId = :t', ExpressionAttributeValues: { ':t': t } }));
    }
    await doc.send(new DeleteCommand({ TableName: table, Key: keys.tenantEntry(t) }));
    // 4. Published files and uploaded images.
    const files = (await deletePrefix(`d/${t}/`)) + (await deletePrefix(`b/${t}/`)) + (slug ? await deletePrefix(`s/${slug}/`) : 0);
    // 5. Open and tick schedules of its drops.
    for (const d of dropIds) {
      for (const name of [`open-${d}`, `tick-${d}`]) {
        await scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: `dropdeck-${stage}` })).catch(() => undefined);
      }
    }
    // 6. The sign-in, if the shop has one (seeded demo shops do not).
    const user = await userBySub(t);
    if (user) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: user.Username! }));
    console.log(`Deleted ${t}: ${own.length + scattered.length} table items, ${files} files, ${dropIds.length} drops' schedules, sign-in ${user ? 'removed' : 'none'}.`);
    break;
  }

  default:
    throw new Error(`Unknown command ${command}`);
}
