/**
 * What AWS recorded for a stage's functions over a time window: how many copies (execution environments) served
 * the requests, how many of those were started inside the window, the peak in use at once and how many requests
 * Lambda refused. Two runs are only comparable if they started from the same place, and a function left running
 * by an earlier run answers its first requests in milliseconds instead of a second.
 *
 * Read from each function's REPORT log lines (CloudWatch Logs Insights) and from Lambda's own metrics.
 */
import { CloudFormationClient, ListStackResourcesCommand, type StackResourceSummary } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { GetAccountSettingsCommand, LambdaClient } from '@aws-sdk/client-lambda';

export interface FunctionUsage {
  invocations: number;
  /** Copies that served at least one request in the window. */
  copiesUsed: number;
  /** Of those, the ones started inside the window (cold starts). */
  startedInWindow: number;
  /** Of those, the ones already running when the window began. */
  alreadyRunning: number;
  avgStartMs: number | null;
  /** Highest number in use at once in any minute of the window. null if the metric is not published yet. */
  peakAtOnce: number | null;
  refusedByLambda: number | null;
  /** Share of the copies used that were already running, 0 to 1: 0 is a cold start, 1 fully warm. */
  warmShare: number | null;
  /** Peak in use at once as a share of the account's limit, 0 to 1. */
  peakShareOfLimit: number | null;
}

export interface AccountUsage {
  /** Copies the account may run at once, across every function and stage. */
  limit: number;
  /** Highest number in use at once across the whole account in any minute of the window, and as a share of the limit. */
  peakAtOnce: number | null;
  peakShareOfLimit: number | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function reportLines(logs: CloudWatchLogsClient, logGroupName: string, fromMs: number, toMs: number) {
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupName, startTime: Math.floor(fromMs / 1000), endTime: Math.ceil(toMs / 1000),
    queryString: 'filter @type="REPORT" | stats count() as invocations, sum(ispresent(@initDuration)) as started, count_distinct(@logStream) as copies, avg(@initDuration) as avgStartMs',
  }));
  for (let i = 0; i < 60; i++) {
    const r = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === 'Complete') return Object.fromEntries((r.results?.[0] ?? []).map((f) => [f.field!, Number(f.value)]));
    if (r.status !== 'Running' && r.status !== 'Scheduled') throw new Error(`log query ${r.status}`);
    await sleep(1000);
  }
  throw new Error('log query timed out');
}

/** Without a function name, the metric is the whole account's. */
async function metric(cw: CloudWatchClient, functionName: string | undefined, name: string, stat: 'Sum' | 'Maximum', fromMs: number, toMs: number): Promise<number | null> {
  const r = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/Lambda', MetricName: name, Dimensions: functionName ? [{ Name: 'FunctionName', Value: functionName }] : [],
    StartTime: new Date(Math.floor(fromMs / 60_000) * 60_000), EndTime: new Date(Math.ceil(toMs / 60_000) * 60_000), Period: 60, Statistics: [stat],
  }));
  const values = (r.Datapoints ?? []).map((d) => d[stat] ?? 0);
  if (!values.length) return null;
  return stat === 'Sum' ? values.reduce((n, v) => n + v, 0) : Math.max(...values);
}

/** `functions` are the stack's logical-id prefixes, e.g. ['Ticket', 'Claim', 'Checkout']. */
export async function stageUsage(stage: string, functions: string[], fromMs: number, toMs: number): Promise<{ account: AccountUsage; functions: Record<string, FunctionUsage> }> {
  // The stack has more resources than one page holds.
  const cf = new CloudFormationClient({});
  const resources: StackResourceSummary[] = [];
  for (let token: string | undefined, first = true; first || token; first = false) {
    const page = await cf.send(new ListStackResourcesCommand({ StackName: `DropDeck-${stage}`, NextToken: token }));
    resources.push(...(page.StackResourceSummaries ?? []));
    token = page.NextToken;
  }
  const physical = (type: string, prefix: string) => {
    const r = resources.find((x) => x.ResourceType === type && x.LogicalResourceId?.startsWith(prefix));
    if (!r?.PhysicalResourceId) throw new Error(`no ${type} starting ${prefix} in DropDeck-${stage}`);
    return r.PhysicalResourceId;
  };
  const logs = new CloudWatchLogsClient({});
  const cw = new CloudWatchClient({});
  const share = (n: number | null, of: number) => (n === null || !of ? null : Math.round((n / of) * 1000) / 1000);
  const limit = (await new LambdaClient({}).send(new GetAccountSettingsCommand({}))).AccountLimit?.ConcurrentExecutions ?? 0;
  const accountPeak = await metric(cw, undefined, 'ConcurrentExecutions', 'Maximum', fromMs, toMs);
  const out: Record<string, FunctionUsage> = {};
  for (const name of functions) {
    const fn = physical('AWS::Lambda::Function', name);
    const [lines, peakAtOnce, refusedByLambda] = await Promise.all([
      reportLines(logs, physical('AWS::Logs::LogGroup', `${name}Logs`), fromMs, toMs),
      metric(cw, fn, 'ConcurrentExecutions', 'Maximum', fromMs, toMs),
      metric(cw, fn, 'Throttles', 'Sum', fromMs, toMs),
    ]);
    const copiesUsed = lines.copies ?? 0;
    const startedInWindow = lines.started ?? 0;
    out[name.toLowerCase()] = {
      invocations: lines.invocations ?? 0, copiesUsed, startedInWindow, alreadyRunning: Math.max(0, copiesUsed - startedInWindow),
      avgStartMs: Number.isFinite(lines.avgStartMs) ? Math.round(lines.avgStartMs!) : null, peakAtOnce, refusedByLambda,
      warmShare: share(Math.max(0, copiesUsed - startedInWindow), copiesUsed), peakShareOfLimit: share(peakAtOnce, limit),
    };
  }
  return { account: { limit, peakAtOnce: accountPeak, peakShareOfLimit: share(accountPeak, limit) }, functions: out };
}
