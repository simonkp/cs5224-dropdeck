import type { Drop, MerchantProfile, Usage } from './types.js';

// No value imports from sibling files: the web app imports this file directly (`@dropdeck/shared/plans`), and its
// bundler does not map the `.js` import specifiers used inside the package.

/** The billing month (yyyy-mm, Singapore time, UTC+8 with no daylight saving) an instant falls in. */
export function usageMonth(at: string | number | Date): string {
  return new Date(new Date(at).getTime() + 8 * 3600_000).toISOString().slice(0, 7);
}

/**
 * Pricing tiers (decision 0007) as data, so the API enforces the same limits the ops page shows and the cost model
 * prices. Pure: no SDK imports, safe for the web bundle (`@dropdeck/shared/plans`).
 */
export type Tier = MerchantProfile['tier'];

export interface Plan {
  label: string;
  /** Monthly fee, S$. */
  monthlySgd: number;
  /** Per scheduled drop, S$ (the Event tier). */
  perDropSgd: number;
  /** null = no limit. */
  dropsPerMonth: number | null;
  /** Stock offered across the month's drops; null = no limit. */
  unitsPerMonth: number | null;
  /** Buyer sessions included in the fee; beyond that, overagePer1kSgd per started 1,000. null = not metered. */
  sessionsIncluded: number | null;
  overagePer1kSgd: number;
}

export const PLANS: Record<Tier, Plan> = {
  starter: { label: 'Starter', monthlySgd: 29, perDropSgd: 0, dropsPerMonth: 2, unitsPerMonth: 200, sessionsIncluded: null, overagePer1kSgd: 0 },
  growth: { label: 'Growth', monthlySgd: 79, perDropSgd: 0, dropsPerMonth: null, unitsPerMonth: null, sessionsIncluded: 5000, overagePer1kSgd: 5 },
  event: { label: 'Event', monthlySgd: 0, perDropSgd: 19, dropsPerMonth: null, unitsPerMonth: null, sessionsIncluded: null, overagePer1kSgd: 0 },
};

export const TIERS = Object.keys(PLANS) as Tier[];

/**
 * Drops that use up a month's allowance: anything scheduled, live or closed whose draw falls in that month, plus
 * cancelled drops that actually opened (the controller metered them). A drop cancelled before it opened is free.
 */
export function monthlyDrops(drops: Drop[], month: string): Drop[] {
  return drops.filter((d) => usageMonth(d.openAt) === month
    && (d.state === 'Scheduled' || d.state === 'Live' || d.state === 'Closed' || (d.state === 'Cancelled' && Boolean(d.meteredAt))));
}

/** Why scheduling `candidate` would break the shop's plan, or null if it fits. */
export function planProblem(tier: Tier, drops: Drop[], candidate: Drop): string | null {
  const plan = PLANS[tier] ?? PLANS.starter;
  const month = usageMonth(candidate.openAt);
  const others = monthlyDrops(drops.filter((d) => d.dropId !== candidate.dropId), month);
  if (plan.dropsPerMonth !== null && others.length + 1 > plan.dropsPerMonth) {
    return `The ${plan.label} plan includes ${plan.dropsPerMonth} drops a month, and ${month} already has ${others.length}. Upgrade to schedule more.`;
  }
  const units = (d: Drop) => d.variants.reduce((n, v) => n + v.stock, 0);
  const used = others.reduce((n, d) => n + units(d), 0);
  if (plan.unitsPerMonth !== null && used + units(candidate) > plan.unitsPerMonth) {
    return `The ${plan.label} plan includes ${plan.unitsPerMonth} units a month; ${month} already has ${used}, and this drop adds ${units(candidate)}. Upgrade, or lower the stock.`;
  }
  return null;
}

export interface InvoiceLine {
  label: string;
  sgd: number;
}

/** What a month would bill under a tier, from its metered usage. A preview: no payment is taken. */
export function invoicePreview(tier: Tier, usage: Pick<Usage, 'drops' | 'cancelled' | 'sessions'> | undefined): { lines: InvoiceLine[]; totalSgd: number } {
  const plan = PLANS[tier] ?? PLANS.starter;
  const u = usage ?? { drops: 0, cancelled: 0, sessions: 0 };
  const lines: InvoiceLine[] = [];
  if (plan.monthlySgd) lines.push({ label: `${plan.label} plan`, sgd: plan.monthlySgd });
  if (plan.perDropSgd) lines.push({ label: `${u.drops + u.cancelled} drop(s) × S$${plan.perDropSgd}`, sgd: (u.drops + u.cancelled) * plan.perDropSgd });
  if (plan.sessionsIncluded !== null && u.sessions > plan.sessionsIncluded) {
    const blocks = Math.ceil((u.sessions - plan.sessionsIncluded) / 1000);
    lines.push({ label: `${blocks} × 1,000 extra buyer sessions`, sgd: blocks * plan.overagePer1kSgd });
  }
  return { lines, totalSgd: lines.reduce((n, l) => n + l.sgd, 0) };
}
