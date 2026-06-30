/**
 * Workflow-shaped tool logic.
 *
 * These are NOT 1:1 wrappers over a "get_customers" API. Each answers a question
 * a human actually asks ("who's about to churn?", "where's my revenue?", "what
 * should I do about this account?") and returns a high-signal, pre-reasoned
 * result — the shape that makes an LLM agent useful instead of a SQL console.
 *
 * Pure functions over the normalised dataset → trivially unit-testable, and the
 * MCP layer (server.js) stays a thin transport wrapper.
 */

const DAY_MS = 86_400_000;

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** Reference "today" for recency math. Explicit arg keeps results deterministic in CI. */
function resolveAsOf(asOf, customers) {
  const fromArg = typeof asOf === "string" ? Date.parse(asOf) : NaN;
  if (!Number.isNaN(fromArg)) return new Date(fromArg);
  // else: newest lastActiveDate in the data (stable, no wall-clock dependency)
  const max = customers.reduce((m, c) => (c.lastActiveDate && c.lastActiveDate > m ? c.lastActiveDate : m), new Date(0));
  return max.getTime() > 0 ? max : new Date(0);
}

/**
 * Compute an explainable 0–100 churn-risk score with human reasons.
 * Weighted, capped, and every point traceable to a reason — never a black box.
 */
function scoreRisk(c, asOf) {
  const reasons = [];
  let score = 0;

  const idleDays = daysBetween(c.lastActiveDate, asOf);
  if (idleDays == null) {
    reasons.push("no recent-activity date on file (treated as unknown, not healthy)");
    score += 15;
  } else if (idleDays >= 90) { score += 40; reasons.push(`inactive ${idleDays} days`); }
  else if (idleDays >= 60) { score += 28; reasons.push(`inactive ${idleDays} days`); }
  else if (idleDays >= 30) { score += 14; reasons.push(`low activity (${idleDays} days idle)`); }

  if (c.seatUtilisation != null && c.seatUtilisation < 0.25) {
    score += 20; reasons.push(`only ${Math.round(c.seatUtilisation * 100)}% of seats used`);
  } else if (c.seatUtilisation != null && c.seatUtilisation < 0.5) {
    score += 8; reasons.push(`${Math.round(c.seatUtilisation * 100)}% seat utilisation`);
  }

  if (c.recentDowngrade) { score += 18; reasons.push("downgraded plan recently"); }
  if (c.supportTicketsLast30d >= 5) { score += 15; reasons.push(`${c.supportTicketsLast30d} support tickets in 30d`); }
  else if (c.supportTicketsLast30d >= 3) { score += 7; reasons.push(`${c.supportTicketsLast30d} support tickets in 30d`); }
  if (c.paymentFailures >= 2) { score += 15; reasons.push(`${c.paymentFailures} payment failures`); }
  else if (c.paymentFailures === 1) { score += 5; reasons.push("1 payment failure"); }

  score = Math.min(100, score);
  const band = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  return { score, band, reasons };
}

function recommendedAction(c, risk) {
  if (risk.score < 30) return "Healthy — candidate for an expansion/upsell conversation.";
  const top = risk.reasons[0] ?? "";
  if (/payment/.test(top)) return "Billing outreach: failed payments — fix card on file before it auto-cancels.";
  if (/inactive|idle|activity/.test(top)) return "Re-engagement: book a check-in / send an activation nudge — usage has stalled.";
  if (/seats/.test(top)) return "Onboarding gap: licensed seats aren't being used — drive adoption with the admin.";
  if (/downgraded/.test(top)) return "Save play: recent downgrade — understand what was missing before full churn.";
  if (/support/.test(top)) return "Escalate: high support load signals friction — get a human on the account.";
  return "Proactive check-in recommended.";
}

/** TOOL: who is most likely to churn, and why. */
export function findAtRiskCustomers({ customers }, { minScore = 30, limit = 10, asOf } = {}) {
  const ref = resolveAsOf(asOf, customers);
  const ranked = customers
    .map((c) => {
      const risk = scoreRisk(c, ref);
      return {
        id: c.id, name: c.name, plan: c.plan, mrr: c.mrr,
        riskScore: risk.score, riskBand: risk.band, reasons: risk.reasons,
        recommendedAction: recommendedAction(c, risk),
        dataQuality: c.dataQuality.length ? c.dataQuality : undefined,
      };
    })
    .filter((c) => c.riskScore >= minScore)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, Math.max(1, Math.min(100, limit)));

  const mrrAtRisk = ranked.reduce((s, c) => s + (typeof c.mrr === "number" ? c.mrr : 0), 0);
  return {
    asOf: ref.toISOString().slice(0, 10),
    criteria: { minScore },
    countAtRisk: ranked.length,
    monthlyRevenueAtRisk: mrrAtRisk,
    customers: ranked,
  };
}

/** TOOL: where the recurring revenue is, grouped + reconciled. */
export function revenueBreakdown({ customers }, { groupBy = "plan" } = {}) {
  if (groupBy !== "plan") {
    // actionable error, not a silent fallback to the default
    throw new Error(`Unsupported groupBy "${groupBy}". Supported: "plan".`);
  }
  const groups = new Map();
  let totalMrr = 0;
  let unknownMrrCount = 0;

  for (const c of customers) {
    const key = c.plan ?? "(no plan)";
    const g = groups.get(key) ?? { plan: key, customers: 0, mrr: 0 };
    g.customers += 1;
    if (typeof c.mrr === "number") { g.mrr += c.mrr; totalMrr += c.mrr; }
    else unknownMrrCount += 1;
    groups.set(key, g);
  }

  const byPlan = [...groups.values()]
    .map((g) => ({ ...g, mrr: Number(g.mrr.toFixed(2)) }))
    .sort((a, b) => b.mrr - a.mrr);

  return {
    totalMonthlyRecurringRevenue: Number(totalMrr.toFixed(2)),
    annualRunRate: Number((totalMrr * 12).toFixed(2)),
    customerCount: customers.length,
    customersWithUnknownMrr: unknownMrrCount, // surfaced so the total is trustworthy
    byPlan,
  };
}

/** TOOL: a single-account 360 with a health verdict + next action. */
export function customerHealth({ customers }, { customerId, asOf } = {}) {
  if (!customerId || typeof customerId !== "string") {
    throw new Error('Missing required argument "customerId" (e.g. "C-1003").');
  }
  const needle = customerId.trim().toLowerCase();
  const c =
    customers.find((x) => x.id.toLowerCase() === needle) ||
    customers.find((x) => x.name.toLowerCase() === needle);

  if (!c) {
    // Don't return an empty object the agent will misread as "all healthy".
    // Fail with a message that helps the caller correct the input.
    const suggestions = customers
      .filter((x) => x.name.toLowerCase().includes(needle) || x.id.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((x) => `${x.id} (${x.name})`);
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    throw new Error(`No customer matching "${customerId}".${hint}`);
  }

  const ref = resolveAsOf(asOf, customers);
  const risk = scoreRisk(c, ref);
  const idleDays = daysBetween(c.lastActiveDate, ref);
  return {
    id: c.id, name: c.name, plan: c.plan, mrr: c.mrr,
    healthScore: 100 - risk.score,
    riskBand: risk.band,
    signals: {
      daysSinceActive: idleDays,
      seatUtilisation: c.seatUtilisation != null ? Number(c.seatUtilisation.toFixed(2)) : null,
      seatsUsed: c.seatsUsed, seatsLicensed: c.seatsLicensed,
      supportTicketsLast30d: c.supportTicketsLast30d,
      paymentFailures: c.paymentFailures,
      recentDowngrade: c.recentDowngrade,
    },
    riskReasons: risk.reasons,
    recommendedAction: recommendedAction(c, risk),
    dataQuality: c.dataQuality.length ? c.dataQuality : undefined,
  };
}

export const TOOLS = { findAtRiskCustomers, revenueBreakdown, customerHealth };
