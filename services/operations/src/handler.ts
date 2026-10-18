import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, getDrop, table } from '@dropdeck/shared/ddb';
import { ApiError, keys, s3Keys, type Drop, type PublicState } from '@dropdeck/shared';
import { healthIssues, type DropHealth } from '@dropdeck/shared/operations';
import { batches, observation, edgeObservation, sesObservation, type Observation } from './events.js';
import { healthEvent } from '@dropdeck/shared/observability';

const s3 = new S3Client({});
const opsTable = () => { if (!process.env.OPS_TABLE_NAME) throw new Error('OPS_TABLE_NAME missing'); return process.env.OPS_TABLE_NAME; };
const registryKey = (t: string, d: string) => ({ PK: 'REGISTRY', SK: `${t}/${d}` });

/** A delayed sample must not delete a newer registration from a concurrent reschedule. */
async function retire(row: Record<string, unknown>) {
  try {
    await ddb.send(new DeleteCommand({
      TableName: opsTable(), Key: registryKey(String(row.tenantId), String(row.dropId)),
      ConditionExpression: row.sourceVersionClock === undefined ? 'attribute_not_exists(#clock)' : '#clock = :clock',
      ExpressionAttributeNames: { '#clock': 'sourceVersionClock' },
      ...(row.sourceVersionClock === undefined ? {} : { ExpressionAttributeValues: { ':clock': row.sourceVersionClock } }),
    }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
  }
}

/** Metrics are diagnostic estimates, never billing input. Group retries are deduplicated transactionally. */
export async function ingest(events: Observation[], source: string) {
  const now = Date.now();
  for (const group of batches(events.filter(e => e.at >= now - 48 * 3600_000 && e.at <= now + 60_000))) {
    const pk = `DROP#${group.tenantId}/${group.dropId}`;
    const entries = Object.entries(group.counts).filter(([,n]) => n !== 0);
    if (entries.length) {
      const names = Object.fromEntries(entries.map(([k],i) => [`#m${i}`,k]));
      const values = Object.fromEntries(entries.map(([,v],i) => [`:m${i}`,v]));
      const ttl = Math.floor(now/1000) + 2 * 86400;
      try {
        await ddb.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: opsTable(), Item: { PK: 'RECEIPT', SK: `${source}/${group.receipt}`, ttl }, ConditionExpression: 'attribute_not_exists(PK)' } },
          ...[60_000, 3600_000].map((period,i) => ({ Update: {
            TableName: opsTable(), Key: { PK: pk, SK: `${i ? 'HOUR' : 'MIN'}#${Math.floor(group.at/period)*period}` },
            UpdateExpression: `SET #ttl = :ttl, #at = :at ADD ${entries.map((_,j) => `#m${j} :m${j}`).join(', ')}`,
            ExpressionAttributeNames: { ...names, '#ttl': 'ttl', '#at': 'at' },
            ExpressionAttributeValues: { ...values, ':ttl': ttl, ':at': Math.floor(group.at/period)*period },
          } })),
        ] }));
      } catch (e) {
        if ((e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed') throw e;
      }
    }
    // Monotonic per-field timestamps prevent delayed logs from overwriting newer evidence.
    const newest=new Map<string,{event:Observation;value:string|number}>();
    for(const event of group.events) for(const [name,value] of Object.entries(event.fields)) if(!newest.has(name)||event.at>newest.get(name)!.event.at) newest.set(name,{event,value});
    for (const [name,{event,value}] of newest) {
      const clockName = `${name}Clock`;
      try {
        await ddb.send(new UpdateCommand({ TableName: opsTable(), Key: registryKey(event.tenantId,event.dropId),
          UpdateExpression: 'SET tenantId = :t, dropId = :d, #field = :value, #clock = :at, #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#clock) OR #clock < :at',
          ExpressionAttributeNames: { '#field': name, '#clock': clockName, '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':t': event.tenantId, ':d': event.dropId, ':value': value, ':at': event.at, ':ttl': Math.floor(now/1000)+2*86400 },
        }));
      } catch (e) { if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e; }
    }
  }
}

async function inventory(drop: Drop, now: number): Promise<NonNullable<DropHealth['inventory']>> {
  const [holds,orders] = await Promise.all([
    ddb.send(new QueryCommand({ TableName: table(), IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': keys.holdIndex(drop.tenantId,drop.dropId) }, ProjectionExpression: 'qty, expiresAt', Limit: 200 })),
    ddb.send(new QueryCommand({ TableName: table(), KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': `T#${drop.tenantId}`, ':sk': `ORDER#${drop.dropId}#` },
      ProjectionExpression: 'qty', ConsistentRead: true, Limit: 200 })),
  ]);
  const wanted = drop.variants.flatMap(v => Array.from({ length: drop.shardCount }, (_,i) => keys.stockShard(drop.tenantId,drop.dropId,v.id,i)));
  let counterUnits = 0; let partial = Boolean(holds.LastEvaluatedKey || orders.LastEvaluatedKey);
  for (let i=0;i<wanted.length;i+=100) {
    const page = wanted.slice(i,i+100);
    const result = await ddb.send(new BatchGetCommand({ RequestItems: { [table()]: { Keys: page, ConsistentRead: true, ProjectionExpression: 'PK, sold' } } }));
    const rows = result.Responses?.[table()] ?? [];
    if (rows.length !== page.length || Object.keys(result.UnprocessedKeys ?? {}).length) partial = true;
    counterUnits += rows.reduce((n,r) => n+Number(r.sold??0),0);
  }
  return { counterUnits, activeUnits: (holds.Items??[]).reduce((n,h)=>n+Number(h.qty),0),
    expiredUnits: (holds.Items??[]).filter(h=>Number(h.expiresAt)<=now-10_000).reduce((n,h)=>n+Number(h.qty),0),
    orderUnits: (orders.Items??[]).reduce((n,o)=>n+Number(o.qty),0), partial, sampledAt: now };
}

/** Cursor advances across invocations: at most 20 drops, four concurrent reads, per scheduled collection. */
export async function collect() {
  const now = Date.now();
  const owner = randomUUID();
  const collectorKey = { PK:'META',SK:'COLLECTOR' };
  try {
    await ddb.send(new UpdateCommand({TableName:opsTable(),Key:collectorKey,
      UpdateExpression:'SET leaseOwner=:owner, leaseUntil=:until',ConditionExpression:'attribute_not_exists(leaseUntil) OR leaseUntil < :now',
      ExpressionAttributeValues:{':owner':owner,':until':now+90_000,':now':now}}));
  } catch(e) {
    if((e as {name?:string}).name==='ConditionalCheckFailedException') return {sampled:0,failures:0,more:false,skipped:true};
    throw e;
  }
  const cursor = await ddb.send(new GetCommand({ TableName: opsTable(), Key: { PK:'META',SK:'COLLECTOR' }, ConsistentRead: true }));
  const page = await ddb.send(new QueryCommand({ TableName: opsTable(), KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk':'REGISTRY' }, Limit:20, ExclusiveStartKey: cursor.Item?.cursor??undefined }));
  let failures = 0; let unhealthy = 0;
  const rows = (page.Items ?? []).filter(r => !r.ttl || r.ttl > now/1000);
  for (let i=0;i<rows.length;i+=4) await Promise.all(rows.slice(i,i+4).map(async row => {
    try {
      let drop: Drop;
      try {
        drop = await getDrop(String(row.tenantId),String(row.dropId), { consistentRead: true });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'NOT_FOUND') throw e;
        await retire(row);
        return;
      }
      if (drop.state === 'Draft') {
        await retire(row);
        return;
      }
      const inv = await inventory(drop,now);
      let publicState: PublicState | undefined; let publicLastModifiedAt: number | undefined;
      try {
        const published = await s3.send(new GetObjectCommand({ Bucket:process.env.BUCKET_NAME,Key:s3Keys.stateJson(drop.tenantId,drop.dropId) }));
        publicState = JSON.parse(await published.Body!.transformToString()) as PublicState;
        publicLastModifiedAt = published.LastModified?.getTime();
      } catch (e) {
        if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw e;
      }
      const health: DropHealth = { ...row as unknown as DropHealth, tenantId:drop.tenantId,dropId:drop.dropId,title:drop.title,
        lifecycle:drop.state, observedAt:now, inventory:inv, sourceVersion:drop.version, publicVersion:publicState?.sourceVersion,
        publicState:publicState?.state, publicLastModifiedAt };
      const issues = healthIssues(health,now);
      const severity = issues.length ? (issues.some(s=>/heartbeat|failed|differs from database/.test(s)) ? 'critical':'warning') : 'healthy';
      if (issues.length) unhealthy++;
      // Only update collector-owned fields. Never replace heartbeats arriving during this sample.
      const publicFields = { publicState:health.publicState??null,publicVersion:health.publicVersion??null, publicLastModifiedAt:publicLastModifiedAt??null };
      const ttl = Math.floor(Date.parse(drop.endAt)/1000)+2*86400;
      await ddb.send(new UpdateCommand({ TableName:opsTable(),Key:registryKey(drop.tenantId,drop.dropId),
        UpdateExpression:'SET title=:title, lifecycle=:life, observedAt=:now, inventory=:inv, sourceVersion=:version, publicSnapshot=:public, issues=:issues, severity=:severity, #ttl=:ttl'
          + (issues.length ? ', GSI1PK=:open, GSI1SK=:expires' : ' REMOVE GSI1PK, GSI1SK'),
        ExpressionAttributeNames:{ '#ttl':'ttl' }, ExpressionAttributeValues:{ ':title':drop.title, ':life':drop.state, ':now':now, ':inv':inv, ':version':drop.version,
          ':public':publicFields, ':issues':issues, ':severity':severity, ':ttl':ttl,
          ...(issues.length ? { ':open':'UNRESOLVED', ':expires':`${String(ttl*1000).padStart(13,'0')}#${drop.tenantId}/${drop.dropId}` } : {}) } }));
      if (JSON.stringify(row.issues??[]) !== JSON.stringify(issues)) await ddb.send(new PutCommand({ TableName:opsTable(),Item:{ PK:`DROP#${drop.tenantId}/${drop.dropId}`,SK:`INCIDENT#${now}`,at:now,issues,severity,ttl:Math.floor(now/1000)+30*86400 } }));
    } catch { failures++; console.error(JSON.stringify({ level:'error',msg:'ops collection failed',tenantId:row.tenantId,dropId:row.dropId })); }
  }));
  // Sparse expiry-ordered index: keep an incident visible between visits to its collection page.
  // A single matching key proves presence; no unbounded scan or per-drop CloudWatch metric is needed.
  const unresolved = await ddb.send(new QueryCommand({
    TableName:opsTable(), IndexName:'GSI1', KeyConditionExpression:'GSI1PK = :open AND GSI1SK >= :now',
    ExpressionAttributeValues:{ ':open':'UNRESOLVED', ':now':String(now+1).padStart(13,'0') }, Limit:1, Select:'COUNT',
  }));
  const unresolvedIncidentPresent = Number((unresolved.Count??0)>0);
  await ddb.send(new UpdateCommand({TableName:opsTable(),Key:collectorKey,
    UpdateExpression:'SET #at=:now, #count=:count, failures=:failures, #cursor=:cursor REMOVE leaseOwner, leaseUntil',
    ConditionExpression:'leaseOwner=:owner',ExpressionAttributeNames:{'#at':'at','#count':'count','#cursor':'cursor'},
    ExpressionAttributeValues:{':now':now,':count':rows.length,':failures':failures,':cursor':page.LastEvaluatedKey??null,':owner':owner}}));
  process.stdout.write(JSON.stringify({ _aws:{ Timestamp:now,CloudWatchMetrics:[{ Namespace:'DropDeck/Operations',Dimensions:[['Stage']],Metrics:[{Name:'CollectionErrors',Unit:'Count'},{Name:'AffectedDrops',Unit:'Count'},{Name:'UnresolvedIncidentPresent',Unit:'Count'},{Name:'CollectionRuns',Unit:'Count'}] }] }, Stage:process.env.STAGE,CollectionErrors:failures,AffectedDrops:unhealthy,UnresolvedIncidentPresent:unresolvedIncidentPresent,CollectionRuns:1 })+'\n');
  return { sampled:rows.length,failures,more:Boolean(page.LastEvaluatedKey),unresolvedIncidentPresent };
}

type LogInput = { awslogs: { data: string } };
type QueueInput = { Records: Array<{ messageId: string; body: string }> };
export async function handler(event: LogInput | QueueInput | { collect?: boolean }) {
  if ('awslogs' in event) {
    const payload = JSON.parse(gunzipSync(Buffer.from(event.awslogs.data,'base64')).toString()) as { messageType:string;logGroup:string;logEvents:Array<{id:string;message:string}> };
    if (payload.messageType==='CONTROL_MESSAGE') return;
    const events: Observation[] = [];
    for (const e of payload.logEvents) {
      // Lambda's system log prefix can surround JSON; never persist the enclosing log line.
      const start=e.message.indexOf('{'); if(start<0) continue;
      try { const raw=JSON.parse(e.message.slice(start));const o=observation(raw,e.id)??edgeObservation(raw,e.id);if(o) events.push(o); } catch { /* unrelated application log */ }
    }
    await ingest(events,payload.logGroup); return;
  }
  if ('Records' in event) {
    const batchItemFailures: Array<{itemIdentifier:string}> = [];
    for(const r of event.Records) try {
      const envelope=JSON.parse(r.body);const raw=typeof envelope.Message==='string'?JSON.parse(envelope.Message):envelope;
      const o=sesObservation(raw,envelope.MessageId??r.messageId);if(o) { await ingest([o],'ses');healthEvent(o.kind,o.tenantId,o.dropId,{mailMode:'ses'}); }
    } catch { batchItemFailures.push({itemIdentifier:r.messageId}); }
    return {batchItemFailures};
  }
  return collect();
}
