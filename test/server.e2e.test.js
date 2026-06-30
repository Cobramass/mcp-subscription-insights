/**
 * Held-out eval — a real MCP roundtrip.
 *
 * Spawns the actual server as a subprocess, speaks MCP over stdio with the
 * official client, lists the tools, and calls each one — proving the wiring,
 * schemas, and protocol-safe error path all work end to end (not just the pure
 * functions). This is the test that says "it runs in production", not "it runs
 * on my machine".
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "src", "server.js");

let client, transport;

before(async () => {
  transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
  client = new Client({ name: "eval-client", version: "1.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
});

test("server advertises exactly the three workflow tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["customer_health", "find_at_risk_customers", "revenue_breakdown"]);
});

test("find_at_risk_customers returns parseable, high-signal JSON", async () => {
  const res = await client.callTool({ name: "find_at_risk_customers", arguments: { asOf: "2026-06-27" } });
  assert.ok(!res.isError, "successful call is not an error");
  const data = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(data.customers) && data.customers.length > 0);
  assert.ok(data.customers.some((c) => c.id === "C-1010"));
});

test("a bad customerId comes back as a protocol-safe error (not a thrown crash)", async () => {
  const res = await client.callTool({ name: "customer_health", arguments: { customerId: "C-0000" } });
  assert.equal(res.isError, true, "error surfaced in-band");
  assert.match(res.content[0].text, /No customer matching/);
  // connection still alive after the error → a follow-up call still works
  const ok = await client.callTool({ name: "revenue_breakdown", arguments: {} });
  assert.ok(!ok.isError);
});
