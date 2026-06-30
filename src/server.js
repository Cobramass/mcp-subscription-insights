#!/usr/bin/env node
/**
 * Demo MCP server — "Subscription Insights".
 *
 * Exposes a SaaS subscription dataset to an LLM via three **workflow-shaped**
 * tools (find_at_risk_customers, revenue_breakdown, customer_health) over the
 * Model Context Protocol, stdio transport.
 *
 * Production-shape choices a client is paying for:
 *   - logs ONLY to stderr (stdout carries JSON-RPC; a stray console.log corrupts it)
 *   - tool errors are returned as protocol-safe `isError` results, never thrown
 *     across the wire (a thrown error that escapes can kill the session)
 *   - high-signal, pre-reasoned returns (not a raw "run SQL" escape hatch — that
 *     is the prompt-injection / data-exfiltration footgun the README calls out)
 *   - inputs validated by schema before they reach the logic
 *
 * Run:  node src/server.js   (then speak MCP to it over stdio, e.g. via Claude
 *       Desktop / `npx @modelcontextprotocol/inspector node src/server.js`)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadCustomers, logInfo } from "./data.js";
import { findAtRiskCustomers, revenueBreakdown, customerHealth } from "./tools.js";

const SERVER = { name: "subscription-insights", version: "1.0.0" };

/** Wrap a pure tool fn as an MCP handler: validate → run → protocol-safe result. */
function handler(fn, dataset) {
  return async (args) => {
    try {
      const result = fn(dataset, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // Surface as an in-band error result so the agent can read + recover,
      // instead of throwing and tearing down the connection.
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  };
}

async function main() {
  // Load + normalise once at startup. A load failure is fatal and explicit —
  // far better than booting and answering every query with "no data".
  const dataset = await loadCustomers();

  const server = new McpServer(SERVER);

  server.registerTool(
    "find_at_risk_customers",
    {
      title: "Find at-risk customers",
      description:
        "Rank customers by churn risk with an explainable score (0–100) and the human reasons behind it. Use to answer 'who is about to churn and what should I do?'.",
      inputSchema: {
        minScore: z.number().min(0).max(100).optional().describe("Only return customers at or above this risk score (default 30)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max customers to return (default 10)."),
        asOf: z.string().optional().describe('Reference date for recency math, ISO "YYYY-MM-DD" (default: newest activity in the data).'),
      },
    },
    handler(findAtRiskCustomers, dataset)
  );

  server.registerTool(
    "revenue_breakdown",
    {
      title: "Revenue breakdown",
      description:
        "Monthly recurring revenue + annual run-rate, grouped by plan, with a count of customers whose MRR is unknown so the total is trustworthy.",
      inputSchema: {
        groupBy: z.enum(["plan"]).optional().describe('Grouping dimension (currently "plan").'),
      },
    },
    handler(revenueBreakdown, dataset)
  );

  server.registerTool(
    "customer_health",
    {
      title: "Customer health 360",
      description:
        "Full health picture for one account (by id or name): health score, churn signals, and a recommended next action.",
      inputSchema: {
        customerId: z.string().describe('Customer id (e.g. "C-1003") or exact name.'),
        asOf: z.string().optional().describe('Reference date for recency math, ISO "YYYY-MM-DD".'),
      },
    },
    handler(customerHealth, dataset)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo(`${SERVER.name} v${SERVER.version} ready on stdio (3 tools)`);
}

main().catch((err) => {
  // Last-resort: report on stderr + non-zero exit. Never write to stdout here.
  process.stderr.write(`[mcp-demo] FATAL ${err.stack ?? err.message}\n`);
  process.exit(1);
});
