/**
 * Held-out eval — the business logic.
 *
 * Asserts the tools behave on the messy real-world dataset, not just the happy
 * path: at-risk detection finds the genuinely-troubled accounts, revenue
 * reconciles, lookups fail loudly and helpfully, and dirty rows never crash.
 *
 * node:test — zero extra deps. Run: `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadCustomers, _resetCache } from "../src/data.js";
import { findAtRiskCustomers, revenueBreakdown, customerHealth } from "../src/tools.js";

// Fix the reference date so recency-based scoring is deterministic in CI.
const ASOF = "2026-06-27";

async function dataset() {
  _resetCache();
  return loadCustomers();
}

test("data loads and surfaces (does not drop) dirty rows", async () => {
  const ds = await dataset();
  assert.equal(ds.customers.length, 20, "all 20 addressable rows kept");
  const flagged = ds.customers.filter((c) => c.dataQuality.length > 0);
  assert.ok(flagged.length >= 4, "messy rows carry data-quality flags");

  const byId = Object.fromEntries(ds.customers.map((c) => [c.id, c]));
  assert.ok(byId["C-1008"].dataQuality.includes("missing_mrr"), "null mrr flagged");
  assert.ok(byId["C-1018"].dataQuality.some((f) => f.startsWith("unknown_plan")), "unknown plan flagged");
  assert.ok(byId["C-1019"].dataQuality.includes("bad_signupDate"), "unparseable date flagged");
  assert.ok(byId["C-1020"].dataQuality.includes("negative_seatsLicensed"), "negative seats flagged");
  assert.equal(byId["C-1019"].signupDate, null, "bad date coerced to null, not NaN");
});

test("find_at_risk_customers surfaces the genuinely troubled accounts", async () => {
  const ds = await dataset();
  const out = findAtRiskCustomers(ds, { asOf: ASOF });

  const ids = out.customers.map((c) => c.id);
  // Alpine Ski House: idle, 13% seat use, double downgrade, 9 tickets, 4 payment fails.
  assert.ok(ids.includes("C-1010"), "the worst account is flagged");
  const alpine = out.customers.find((c) => c.id === "C-1010");
  assert.equal(alpine.riskBand, "high");
  assert.ok(alpine.reasons.length >= 3, "risk is explained with multiple reasons");
  assert.ok(typeof alpine.recommendedAction === "string" && alpine.recommendedAction.length > 0);

  // Contoso: active daily, 98% seat use, no issues — must NOT be in the at-risk list.
  assert.ok(!ids.includes("C-1003"), "a healthy account is not a false positive");

  assert.equal(out.countAtRisk, out.customers.length);
  assert.ok(typeof out.monthlyRevenueAtRisk === "number");
  assert.ok(out.customers.every((c, i) => i === 0 || out.customers[i - 1].riskScore >= c.riskScore), "sorted desc by risk");
});

test("find_at_risk_customers respects minScore and limit", async () => {
  const ds = await dataset();
  const strict = findAtRiskCustomers(ds, { asOf: ASOF, minScore: 60, limit: 3 });
  assert.ok(strict.customers.length <= 3, "limit honoured");
  assert.ok(strict.customers.every((c) => c.riskScore >= 60), "minScore honoured");
});

test("revenue_breakdown reconciles and flags unknowns", async () => {
  const ds = await dataset();
  const rev = revenueBreakdown(ds, {});
  assert.equal(rev.customerCount, 20);
  assert.ok(rev.totalMonthlyRecurringRevenue > 0);
  assert.equal(rev.annualRunRate, Number((rev.totalMonthlyRecurringRevenue * 12).toFixed(2)), "ARR = MRR×12");

  const sumOfGroups = rev.byPlan.reduce((s, g) => s + g.mrr, 0);
  assert.equal(Number(sumOfGroups.toFixed(2)), rev.totalMonthlyRecurringRevenue, "group MRR sums to total");
  assert.ok(rev.byPlan.every((g, i) => i === 0 || rev.byPlan[i - 1].mrr >= g.mrr), "groups sorted by revenue");
  assert.ok(rev.customersWithUnknownMrr >= 1, "unknown-MRR rows are reported, not hidden");

  const counted = rev.byPlan.reduce((s, g) => s + g.customers, 0);
  assert.equal(counted, 20, "every customer appears in exactly one group");
});

test("revenue_breakdown rejects an unsupported grouping (no silent fallback)", async () => {
  const ds = await dataset();
  assert.throws(() => revenueBreakdown(ds, { groupBy: "country" }), /Unsupported groupBy/);
});

test("customer_health works by id and by name, with signals", async () => {
  const ds = await dataset();
  const byId = customerHealth(ds, { customerId: "C-1003", asOf: ASOF });
  assert.equal(byId.name, "Contoso Ltd");
  assert.ok(byId.healthScore >= 70, "a healthy account scores high");
  assert.equal(typeof byId.signals.daysSinceActive, "number");

  const byName = customerHealth(ds, { customerId: "Contoso Ltd", asOf: ASOF });
  assert.equal(byName.id, "C-1003", "name lookup resolves to the same record");
});

test("customer_health fails loudly + helpfully on a bad id (no empty 'all good')", async () => {
  const ds = await dataset();
  assert.throws(() => customerHealth(ds, { customerId: "C-9999" }), /No customer matching/);
  assert.throws(() => customerHealth(ds, {}), /Missing required argument/);
  // partial match should suggest candidates
  assert.throws(() => customerHealth(ds, { customerId: "contoso" }), /Did you mean/i);
});

test("dirty rows never crash a health lookup", async () => {
  const ds = await dataset();
  for (const id of ["C-1008", "C-1018", "C-1019", "C-1020"]) {
    const h = customerHealth(ds, { customerId: id, asOf: ASOF });
    assert.ok(typeof h.healthScore === "number" && Number.isFinite(h.healthScore), `${id} scored without NaN`);
  }
});
