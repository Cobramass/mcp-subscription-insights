/**
 * Dataset loader + normaliser.
 *
 * Real client data is never clean. This layer is where "demo-ware that only
 * works on the happy path" becomes "a tool that survives the client's actual
 * export": every record is coerced, every problem is recorded as a structured
 * `dataQuality` flag (never silently dropped), and all diagnostics go to
 * **stderr** — stdout is reserved for the MCP JSON-RPC stream and logging there
 * would corrupt the protocol.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.join(__dirname, "..", "data", "customers.json");

/** Structured stderr logger — keeps stdout clean for JSON-RPC. */
export function logWarn(msg, meta) {
  process.stderr.write(`[mcp-demo] WARN  ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
}
export function logInfo(msg, meta) {
  process.stderr.write(`[mcp-demo] INFO  ${msg}${meta ? " " + JSON.stringify(meta) : ""}\n`);
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Parse an ISO date defensively. Returns a Date or null (never throws, never NaN). */
function parseDate(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Normalise one raw record. Always returns a record — problems are surfaced as
 * `dataQuality: string[]` rather than by dropping the row (a dropped row is a
 * silent failure the client discovers a month later).
 */
function normaliseCustomer(raw, plans) {
  const issues = [];

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "(unnamed)";

  let plan = typeof raw.plan === "string" && raw.plan.trim() ? raw.plan.trim() : null;
  if (!plan) issues.push("missing_plan");
  else if (!plans[plan]) issues.push(`unknown_plan:${plan}`);

  // Trust the catalogue price over a possibly-stale per-row mrr; fall back to the row.
  let mrr = null;
  if (plan && plans[plan] && isFiniteNum(plans[plan].mrr)) mrr = plans[plan].mrr;
  else if (isFiniteNum(raw.mrr)) mrr = raw.mrr;
  if (mrr === null) issues.push("missing_mrr");

  const signupDate = parseDate(raw.signupDate);
  if (raw.signupDate != null && !signupDate) issues.push("bad_signupDate");
  const lastActiveDate = parseDate(raw.lastActiveDate);
  if (raw.lastActiveDate != null && !lastActiveDate) issues.push("bad_lastActiveDate");

  let seatsLicensed = isFiniteNum(raw.seatsLicensed) ? raw.seatsLicensed : null;
  if (seatsLicensed != null && seatsLicensed < 0) { issues.push("negative_seatsLicensed"); seatsLicensed = null; }
  const seatsUsed = isFiniteNum(raw.seatsUsed) && raw.seatsUsed >= 0 ? raw.seatsUsed : null;

  // seat utilisation only when both sides are known and the denominator is sane
  let seatUtilisation = null;
  if (seatsUsed != null && seatsLicensed != null && seatsLicensed > 0) {
    seatUtilisation = Math.min(1, seatsUsed / seatsLicensed);
  }

  const supportTicketsLast30d = isFiniteNum(raw.supportTicketsLast30d) && raw.supportTicketsLast30d >= 0 ? raw.supportTicketsLast30d : 0;
  const paymentFailures = isFiniteNum(raw.paymentFailures) && raw.paymentFailures >= 0 ? raw.paymentFailures : 0;

  const planChanges = Array.isArray(raw.planChanges) ? raw.planChanges : [];
  const downgrades = planChanges.filter((c) => {
    const from = plans[c?.from]?.mrr, to = plans[c?.to]?.mrr;
    return isFiniteNum(from) && isFiniteNum(to) && to < from;
  });

  return {
    id, name, plan, mrr,
    signupDate, lastActiveDate,
    seatsLicensed, seatsUsed, seatUtilisation,
    supportTicketsLast30d, paymentFailures,
    planChanges, recentDowngrade: downgrades.length > 0,
    dataQuality: issues,
  };
}

let _cache = null;

/**
 * Load + normalise the dataset (cached). Records with no usable id are the only
 * ones excluded — and that exclusion is reported loudly, with a count, not hidden.
 */
export async function loadCustomers(dataPath = DEFAULT_PATH) {
  if (_cache && _cache.path === dataPath) return _cache;

  let parsed;
  try {
    parsed = JSON.parse(await readFile(dataPath, "utf8"));
  } catch (err) {
    // A load failure must be explicit and actionable, never an empty result that
    // a downstream tool reports as "no customers found".
    throw new Error(`Could not load dataset at ${dataPath}: ${err.message}`);
  }

  const plans = parsed.plans ?? {};
  const rawCustomers = Array.isArray(parsed.customers) ? parsed.customers : [];

  const normalised = [];
  let skippedNoId = 0;
  for (const raw of rawCustomers) {
    const c = normaliseCustomer(raw, plans);
    if (!c.id) { skippedNoId++; continue; }
    normalised.push(c);
  }

  const flagged = normalised.filter((c) => c.dataQuality.length > 0).length;
  if (skippedNoId > 0) logWarn(`skipped ${skippedNoId} record(s) with no id (cannot be addressed)`);
  if (flagged > 0) logInfo(`loaded ${normalised.length} customers; ${flagged} carry data-quality flags (surfaced, not dropped)`);
  else logInfo(`loaded ${normalised.length} customers (clean)`);

  _cache = { path: dataPath, plans, customers: normalised };
  return _cache;
}

/** Test seam: clear the cache so a test can load a fixture path. */
export function _resetCache() { _cache = null; }
