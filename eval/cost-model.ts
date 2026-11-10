/**
 * Bill of materials and cost comparison for DropDeck (docs/cost-bom.md).
 *
 *   pnpm --filter @dropdeck/eval cost              print the BOM tables
 *   pnpm --filter @dropdeck/eval cost -- --write   also replace the generated block in docs/cost-bom.md
 *   ... -- --measured eval/results/drop.json       use metered numbers from a real drop instead of the model
 *
 * Every price is a published on-demand rate for ap-southeast-1 (Singapore), from the AWS price list files fetched
 * 2026-10-07 (https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<service>/current/ap-southeast-1/index.json).
 * Workload numbers are assumptions until replaced by --measured; each is named below so it can be challenged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- prices (USD)

const P = {
  cfHttpsRequest: 0.012 / 10_000, // CloudFront, Asia, per HTTPS request
  cfTransferGB: 0.12, // CloudFront, Asia, first 10 TB
  cfFunction: 0.10 / 1e6, // CloudFront Functions (first 2M a month free)
  apiRequest: 1.25 / 1e6, // API Gateway HTTP API, first 300M
  lambdaGbS: 0.0000133334, // Lambda ARM
  lambdaRequest: 0.2 / 1e6,
  lambdaPcGbS: 0.0000041593, // provisioned concurrency, ARM, while allocated
  lambdaPcComputeGbS: 0.000009705, // compute under provisioned concurrency, ARM
  ddbWrite: 0.71 / 1e6, // DynamoDB on-demand write request unit
  ddbRead: 0.1425 / 1e6,
  ddbStorageGB: 0.285, // per GB-month beyond 25 GB
  s3Put: 0.005 / 1000,
  s3Get: 0.0004 / 1000,
  s3StorageGB: 0.025,
  scheduler: 1.25 / 1e6, // EventBridge Scheduler (first 14M a month free)
  emailSes: 0.10 / 1000,
  logsGB: 0.70, // CloudWatch Logs ingestion (first 5 GB a month free)
  wafAcl: 5, // per web ACL per month
  wafRule: 1, // per rule per month
  wafRequest: 0.60 / 1e6,
  albHour: 0.0252, // Application Load Balancer
  albLcuHour: 0.008,
  ec2T4gMedium: 0.0424, // per hour
  ec2C7gLarge: 0.0833,
  natHour: 0.059,
  natGB: 0.059,
  cacheT4gSmall: 0.0384, // ElastiCache Valkey
  ebsGB: 0.096, // gp3 per GB-month
};

/** Always-free monthly allowances (they do not expire after 12 months). Whether they apply to the NUS sandbox's credit account is unverified, so every table shows both. */
const FREE = { cfRequests: 10e6, cfTransferGB: 1000, cfFunctions: 2e6, lambdaRequests: 1e6, lambdaGbS: 400_000, scheduler: 14e6, logsGB: 5 };

const SGD_PER_USD = 1.30; // assumption, for comparing with prices in S$
const HOURS = 730;

// ---------------------------------------------------------------- workload

interface Workload {
  sessions: number; // buyer sessions per drop (tickets + people who only watched)
  units: number; // stock per drop
  ordersPerUnit: number; // orders per unit sold (buyers take 1-2 each)
  holdsPerOrder: number; // reservations per order (some expire unpaid)
  pageRequests: number; // first-load requests per session (measured: 18-19)
  pageMB: number; // first-load transfer per session, MB (measured: 0.27-0.59)
  pollKB: number; // one state.json response with headers
  minutes: { countdown: number; queueNear: number; queueFar: number; held: number }; // per session, by phase
  dropMinutes: number; // controller lifetime: entry window + drop + hold tail
  merchantViewMinutes: number; // merchant watching the live view (polls every 5 s)
}

/** The preliminary report's reference drop: 200 units, about 5,000 buyer sessions. */
const REFERENCE: Workload = {
  sessions: 5000, units: 200, ordersPerUnit: 1 / 1.5, holdsPerOrder: 1.3,
  pageRequests: 19, pageMB: 0.45, pollKB: 0.6,
  minutes: { countdown: 5, queueNear: 3, queueFar: 3, held: 1 },
  dropMinutes: 45, merchantViewMinutes: 30,
};

/** state.json polls per session under each polling policy (apps/web/app/d/buyer.ts pollInterval). */
const polls = {
  fixed2s: (w: Workload) => (w.minutes.countdown + w.minutes.queueNear + w.minutes.queueFar + w.minutes.held) * 30,
  adaptive: (w: Workload) => w.minutes.countdown * 2 + w.minutes.queueNear * 30 + w.minutes.queueFar * 12 + w.minutes.held * 6,
};

interface Line { item: string; qty: string; usd: number }

function perDrop(w: Workload, policy: keyof typeof polls, opts: { waf?: boolean; pcMinutes?: number } = {}): Line[] {
  const orders = Math.round(w.units * w.ordersPerUnit);
  const holds = Math.round(orders * w.holdsPerOrder);
  const pollReqs = w.sessions * polls[policy](w);
  const edgeReqs = pollReqs + w.sessions * w.pageRequests;
  const edgeGB = (pollReqs * w.pollKB) / 1024 / 1024 + (w.sessions * w.pageMB) / 1024;
  const merchantCalls = (w.merchantViewMinutes * 60) / 5 * 4; // live, orders, report, profile per refresh
  const apiCalls = w.sessions + holds * 4 + orders + merchantCalls; // ticket; claim, hold read, otp, confirm
  const fnGbS = apiCalls * 0.08 * 0.5 + (w.dropMinutes * 55 * 0.5); // 80 ms at 512 MB; controller ~55 s a minute
  const writes = w.sessions * 1.2 + holds * 3 + orders * 4;
  const reads = apiCalls * 2 + (w.dropMinutes * 24) * 8; // controller: ~8 reads a tick, 24 ticks a minute
  const statePuts = w.dropMinutes * 24;
  const originGets = (w.dropMinutes * 60) / 2 * 3; // state.json refills: 2 s TTL × ~3 caches serving Singapore
  const lines: Line[] = [
    { item: 'CloudFront requests (pages + state.json polls)', qty: `${(edgeReqs / 1e6).toFixed(2)}M (${(pollReqs / 1e6).toFixed(2)}M polls)`, usd: edgeReqs * P.cfHttpsRequest },
    { item: 'CloudFront data out', qty: `${edgeGB.toFixed(1)} GB`, usd: edgeGB * P.cfTransferGB },
    { item: 'CloudFront Functions (URL rewrite)', qty: `${((w.sessions * 3) / 1000).toFixed(0)}k`, usd: w.sessions * 3 * P.cfFunction },
    { item: 'API Gateway (HTTP API)', qty: `${(apiCalls / 1000).toFixed(1)}k`, usd: apiCalls * P.apiRequest },
    { item: 'Lambda (ARM, 512 MB) incl. controller', qty: `${(fnGbS / 1000).toFixed(1)}k GB-s`, usd: fnGbS * P.lambdaGbS + (apiCalls + w.dropMinutes) * P.lambdaRequest },
    { item: 'DynamoDB on-demand', qty: `${(writes / 1000).toFixed(1)}k W / ${(reads / 1000).toFixed(1)}k R`, usd: writes * P.ddbWrite + reads * P.ddbRead },
    { item: 'S3 (state.json writes, edge refills)', qty: `${statePuts} PUT / ${originGets} GET`, usd: statePuts * P.s3Put + originGets * P.s3Get },
    { item: 'EventBridge Scheduler', qty: `${w.dropMinutes + 1}`, usd: (w.dropMinutes + 1) * P.scheduler },
    { item: 'SES email codes', qty: `${holds}`, usd: holds * P.emailSes },
    { item: 'CloudWatch Logs', qty: `${((apiCalls * 0.6) / 1024).toFixed(1)} MB`, usd: ((apiCalls * 0.6) / 1024 / 1024) * P.logsGB },
  ];
  if (opts.waf) lines.push({ item: 'WAF requests (API-only distribution)', qty: `${(apiCalls / 1000).toFixed(1)}k`, usd: apiCalls * P.wafRequest });
  if (opts.pcMinutes) {
    const gbS = opts.pcMinutes * 60 * 10 * 0.5; // 10 warm environments at 512 MB
    lines.push({ item: 'Lambda provisioned concurrency (10 × 512 MB, drop window)', qty: `${opts.pcMinutes} min`, usd: gbS * P.lambdaPcGbS });
  }
  return lines;
}

const sum = (ls: Line[]) => ls.reduce((n, l) => n + l.usd, 0);

/** The CloudFront and Lambda share of a drop that the always-free allowance absorbs, for a month with `drops` drops. */
function freeTierSaving(w: Workload, policy: keyof typeof polls, drops: number): number {
  const reqs = w.sessions * (polls[policy](w) + w.pageRequests) * drops;
  const free = Math.min(reqs, FREE.cfRequests) * P.cfHttpsRequest;
  return free / drops;
}

// ---------------------------------------------------------------- monthly: platforms

interface Platform { name: string; fixedUsd: number; fixedLines: Line[]; perDropUsd: (w: Workload) => number; note: string }

function platforms(w: Workload): Platform[] {
  const serverlessFixed: Line[] = [
    { item: 'S3 storage (site, images, JSON)', qty: '~2 GB', usd: 2 * P.s3StorageGB },
    { item: 'DynamoDB storage', qty: '< 25 GB', usd: 0 },
    { item: 'Cognito (Essentials, < 10k monthly users)', qty: '', usd: 0 },
    { item: 'Budget alarm, SSM parameters, CloudFront (idle)', qty: '', usd: 0 },
  ];
  const hardened: Line[] = [...serverlessFixed, { item: 'WAF web ACL + 1 rate rule (API-only distribution)', qty: '', usd: P.wafAcl + P.wafRule }];
  const classic: Line[] = [
    { item: 'Application Load Balancer (+1 LCU)', qty: `${HOURS} h`, usd: HOURS * (P.albHour + P.albLcuHour) },
    { item: 'EC2 web/queue servers, 2 × t4g.medium (two AZs)', qty: `${HOURS * 2} h`, usd: HOURS * 2 * P.ec2T4gMedium },
    { item: 'EBS gp3, 2 × 20 GB', qty: '40 GB', usd: 40 * P.ebsGB },
    { item: 'ElastiCache Valkey t4g.small (queue state)', qty: `${HOURS} h`, usd: HOURS * P.cacheT4gSmall },
    { item: 'NAT gateway (private subnets)', qty: `${HOURS} h`, usd: HOURS * P.natHour },
    { item: 'S3, DynamoDB, Cognito as above', qty: '', usd: 2 * P.s3StorageGB },
  ];
  const onPremSgd: Line[] = [
    { item: '2 × 1U servers (HA pair), S$3,500 each over 36 months', qty: '', usd: (7000 / 36) / SGD_PER_USD },
    { item: 'Colocation, 2U with power and 100 Mbps, Singapore', qty: '', usd: 300 / SGD_PER_USD },
    { item: 'Operations (patching, backups, on-call), 4 h at S$50', qty: '', usd: 200 / SGD_PER_USD },
    { item: 'Off-site backup and domain/TLS', qty: '', usd: 20 / SGD_PER_USD },
  ];
  const adaptive = sum(perDrop(w, 'adaptive'));
  const edgeOnly = sum(perDrop(w, 'adaptive').filter((l) => l.item.startsWith('CloudFront')));
  return [
    { name: 'A. DropDeck as built (adaptive polling)', fixedLines: serverlessFixed, fixedUsd: sum(serverlessFixed), perDropUsd: () => adaptive, note: 'pay per use; idle month ≈ storage only' },
    { name: 'B. A + WAF on the API + warm Lambdas', fixedLines: hardened, fixedUsd: sum(hardened), perDropUsd: () => sum(perDrop(w, 'adaptive', { waf: true, pcMinutes: 30 })), note: 'optional hardening, not built' },
    // Same edge traffic (pages and polls still go through CloudFront); the API calls hit the servers already paid
    // for, plus four extra instances for the hour around each drop.
    { name: 'C. Classic servers: ALB + EC2 auto scaling + cache', fixedLines: classic, fixedUsd: sum(classic), perDropUsd: () => edgeOnly + 4 * P.ec2C7gLarge, note: 'always-on servers; +4 × c7g.large for 1 h per drop' },
    // Same CDN as A and C: a 100 Mbps colocation link cannot serve a crowd's pages and polls itself (about three
    // reference drops at once), so the edge traffic is billed here too. Only D carries staff time; A to C carry none.
    { name: 'D. On-premise behind the same CDN', fixedLines: onPremSgd, fixedUsd: sum(onPremSgd), perDropUsd: () => edgeOnly + 0.05, note: 'servers and staff time fixed; CloudFront for pages and polls' },
  ];
}

// ---------------------------------------------------------------- revenue

/** Merchant mix assumption: 60% Starter (2 drops, 1,500 sessions each), 30% Growth (4 drops, 5,000 each), 10% Event (1 drop). */
function monthly(merchants: number) {
  const starter = Math.round(merchants * 0.6), growth = Math.round(merchants * 0.3), event = merchants - starter - growth;
  const drops = { small: starter * 2 + event, reference: growth * 4 };
  const growthOverage = Math.ceil((4 * 5000 - 5000) / 1000) * 5; // S$ per Growth shop a month
  const revenueSgd = starter * 29 + growth * (79 + growthOverage) + event * 19;
  return { starter, growth, event, drops, revenueUsd: revenueSgd / SGD_PER_USD };
}

/**
 * Small-seller scenario (assumed): every shop on Starter, two drops a month of 40 units and 400 buyer sessions each.
 * Sized to sellers with tens of orders a month rather than the reference drop; replace with measured values.
 */
const SMALL_SELLER: Workload = { ...REFERENCE, sessions: 400, units: 40, dropMinutes: 30, merchantViewMinutes: 15 };
const SMALL_DROPS_PER_SHOP = 2;

// ---------------------------------------------------------------- output

const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(n < 10 ? 2 : 0)}`);

function render(w: Workload, measured: boolean): string {
  const out: string[] = [];
  const t = (rows: string[][]) => {
    out.push(`| ${rows[0]!.join(' | ')} |`, `| ${rows[0]!.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`), '');
  };
  out.push(`_Generated by \`eval/cost-model.ts\` (${measured ? 'measured inputs' : 'modelled inputs'}). Prices: AWS on-demand, ap-southeast-1, price list of 2026-10-07. US$ unless marked._`, '');
  out.push('### Per drop (reference drop: 200 units, 5,000 buyer sessions)', '');
  // The fixed 2 s poll is what adaptive polling replaced; it stays here only as the comparison that justified it.
  const a = perDrop(w, 'adaptive');
  const b = perDrop(w, 'fixed2s');
  t([['Item', 'As built (adaptive): quantity', 'As built', 'Fixed 2 s (replaced): quantity', 'Fixed 2 s'],
    ...a.map((l, i) => [l.item, l.qty, usd(l.usd), b[i]!.qty, usd(b[i]!.usd)]),
    ['**Total per drop**', '', `**${usd(sum(a))}**`, '', `**${usd(sum(b))}**`],
    ['With the always-free CloudFront allowance (1 drop a month)', '', usd(sum(a) - freeTierSaving(w, 'adaptive', 1)), '', usd(sum(b) - freeTierSaving(w, 'fixed2s', 1))],
  ]);
  out.push(`Polls per session: ${polls.adaptive(w)} as built, against ${polls.fixed2s(w)} with the fixed 2 s poll it replaced (${(polls.fixed2s(w) / polls.adaptive(w)).toFixed(1)}× fewer). Session time by phase (assumed): countdown ${w.minutes.countdown} min, near the front ${w.minutes.queueNear} min, far back ${w.minutes.queueFar} min, holding ${w.minutes.held} min.`, '');

  out.push('### Sensitivity: cost per drop against how long buyers keep the page open', '');
  t([['Minutes on page', '5', '10', '15', '20', '30'],
    ['As built (adaptive)', ...[5, 10, 15, 20, 30].map((m) => usd(sum(perDrop({ ...w, minutes: { countdown: m * 0.4, queueNear: m * 0.25, queueFar: m * 0.25, held: m * 0.1 } }, 'adaptive'))))],
    ['Fixed 2 s (replaced)', ...[5, 10, 15, 20, 30].map((m) => usd(sum(perDrop({ ...w, minutes: { countdown: m * 0.4, queueNear: m * 0.25, queueFar: m * 0.25, held: m * 0.1 } }, 'fixed2s'))))],
  ]);

  const ps = platforms(w);
  out.push('### Fixed monthly cost of each platform (no drops at all)', '');
  t([['Platform', 'Idle month', 'Per reference drop', 'Note'], ...ps.map((p) => [p.name, usd(p.fixedUsd), usd(p.perDropUsd(w)), p.note])]);
  for (const p of ps) {
    out.push(`<details><summary>${p.name}: fixed items</summary>`, '');
    t([['Item', 'Quantity', 'Per month'], ...p.fixedLines.map((l) => [l.item, l.qty || '-', usd(l.usd)])]);
    out.push('</details>', '');
  }

  out.push('### Monthly cost against revenue as the business grows', '');
  out.push('Merchant mix (assumed): 60% Starter (2 small drops), 30% Growth (4 reference drops), 10% Event (1 small drop). A small drop is a fifth of the reference drop. Revenue at S$1.30 per US$.', '');
  const sizes = [10, 50, 200];
  const rows: string[][] = [['Platform', ...sizes.map((m) => `${m} shops: cost`), ...sizes.map((m) => `${m} shops: gross margin`)]];
  for (const p of ps) {
    const cost = sizes.map((m) => {
      const mo = monthly(m);
      return p.fixedUsd + mo.drops.reference * p.perDropUsd(w) + mo.drops.small * p.perDropUsd(w) / 5;
    });
    const margin = sizes.map((m, i) => `${Math.round(((monthly(m).revenueUsd - cost[i]!) / monthly(m).revenueUsd) * 100)}%`);
    rows.push([p.name, ...cost.map(usd), ...margin]);
  }
  rows.push(['Revenue (all platforms)', ...sizes.map((m) => usd(monthly(m).revenueUsd)), '', '', '']);
  t(rows);
  const m200 = monthly(200);
  out.push(`At 200 shops that is ${m200.drops.reference + m200.drops.small} drops a month (${m200.drops.reference} reference-size). Margins exclude people, payment fees and taxes.`, '');

  const sw = measured ? w : SMALL_SELLER;
  const sDrop = sum(perDrop(sw, 'adaptive'));
  const sEdge = sum(perDrop(sw, 'adaptive').filter((l) => l.item.startsWith('CloudFront')));
  out.push('### Small-seller scenario', '');
  out.push(`Assumed: every shop on Starter (S$29 a month), ${SMALL_DROPS_PER_SHOP} drops a month of ${sw.units} units and ${sw.sessions} buyer sessions each. As built, one such drop costs ${usd(sDrop)}.`, '');
  const sRows: string[][] = [['Platform', ...sizes.map((m) => `${m} shops: cost`), ...sizes.map((m) => `${m} shops: gross margin`)]];
  const sPer: Record<string, number> = { A: sDrop, B: sum(perDrop(sw, 'adaptive', { waf: true, pcMinutes: 30 })), C: sEdge + 4 * P.ec2C7gLarge, D: sEdge + 0.05 };
  for (const p of ps) {
    const per = sPer[p.name[0]!]!;
    const cost = sizes.map((m) => p.fixedUsd + m * SMALL_DROPS_PER_SHOP * per);
    const rev = sizes.map((m) => (m * 29) / SGD_PER_USD);
    sRows.push([p.name, ...cost.map(usd), ...cost.map((c, i) => `${Math.round(((rev[i]! - c) / rev[i]!) * 100)}%`)]);
  }
  sRows.push(['Revenue (all platforms)', ...sizes.map((m) => usd((m * 29) / SGD_PER_USD)), '', '', '']);
  t(sRows);
  return out.join('\n');
}

const args = process.argv.slice(2).filter((a) => a !== '--');
let w = REFERENCE;
const measuredAt = args.indexOf('--measured');
if (measuredAt >= 0) w = { ...REFERENCE, ...JSON.parse(readFileSync(args[measuredAt + 1]!, 'utf8')) };
const md = render(w, measuredAt >= 0);
console.log(md);

if (args.includes('--write')) {
  const doc = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/cost-bom.md');
  const text = readFileSync(doc, 'utf8');
  const start = '<!-- BOM:START -->';
  const end = '<!-- BOM:END -->';
  if (!text.includes(start) || !text.includes(end)) throw new Error(`docs/cost-bom.md needs ${start} and ${end} markers`);
  writeFileSync(doc, `${text.slice(0, text.indexOf(start) + start.length)}\n${md}\n${text.slice(text.indexOf(end))}`);
  console.error('updated docs/cost-bom.md');
}
