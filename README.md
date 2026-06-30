# Subscription Insights — demo MCP server

[![CI](https://github.com/Cobramass/mcp-subscription-insights/actions/workflows/ci.yml/badge.svg)](https://github.com/Cobramass/mcp-subscription-insights/actions/workflows/ci.yml)

A small, **production-shaped** [Model Context Protocol](https://modelcontextprotocol.io)
server that gives an LLM (Claude, or any MCP client) three **workflow-shaped** tools over a
SaaS subscription dataset:

| Tool | Answers | Returns |
|---|---|---|
| `find_at_risk_customers` | "Who's about to churn and why?" | Ranked accounts with an explainable 0–100 risk score, the reasons, and a recommended action |
| `revenue_breakdown` | "Where's my recurring revenue?" | MRR + annual run-rate by plan, with a count of unknown-MRR rows so the total is trustworthy |
| `customer_health` | "What's going on with this account?" | One-account 360: health score, churn signals, next action (lookup by id **or** name) |

It's a portfolio demo — the dataset is synthetic and bundled — but it's built to the same bar
as a paid deliverable. Point it at a real CRM/billing API by swapping the loader in
[`src/data.js`](src/data.js); the tool design and guarantees below stay the same.

## Why these are *workflow* tools, not API wrappers

A naïve MCP server exposes `get_customers` / `run_sql` and makes the model do the analysis (and
the mistakes). These tools each do one **complete job** and hand back a pre-reasoned, high-signal
result. That's the difference between an agent that's useful and one that burns tokens round-tripping
raw rows — and it removes the single biggest MCP security footgun (a raw-SQL/exec escape hatch is a
data-exfiltration and prompt-injection target).

## Run it

```bash
npm install
npm start          # serve over stdio
npm test           # the held-out eval suite (also runs in CI)
npm run inspector  # open the MCP Inspector against the server
```

### Use it from Claude Desktop

Add to `claude_desktop_config.json` (absolute path to `src/server.js`):

```json
{
  "mcpServers": {
    "subscription-insights": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-demo/src/server.js"]
    }
  }
}
```

Then ask Claude *"which customers are at risk of churning?"* and it will call the tool.

## What makes it production-shaped (the bar)

- **Never logs to stdout.** stdio MCP carries JSON-RPC on stdout; a stray `console.log` corrupts
  the stream and breaks the session. All diagnostics go to **stderr** (see `logInfo`/`logWarn`).
- **Protocol-safe errors.** A bad argument returns an in-band `isError` result the agent can read
  and recover from — it never throws across the wire and tears down the connection. The eval
  proves the session survives an error and keeps serving.
- **Graceful degradation on dirty data.** Real exports have null plans, malformed dates, negative
  seat counts. The loader coerces every field, tags problems as structured `dataQuality` flags, and
  **never silently drops a row** — a dropped account is a silent failure the client finds a month
  later. 5 of the 20 bundled rows are deliberately messy and the suite asserts they're handled.
- **No demo-ware math.** Scores are weighted, capped, and every point is traceable to a stated
  reason. Recency uses an explicit `asOf` so results are deterministic (and testable) rather than
  wall-clock-dependent.
- **A held-out eval suite in CI.** [`test/`](test/) covers the logic *and* a real client↔server
  MCP roundtrip; [GitHub Actions](.github/workflows/ci.yml) runs it on Node 20 + 22. An eval in CI
  is the clearest signal that an MCP build is maintained, not a one-off.

## Security notes

MCP servers run with real access to real systems — the failure modes are leakage and RCE
(e.g. the Asana cross-tenant incident; CVE-2025-6514). This demo bakes in the baseline:

- **Read-only, least-privilege.** The tools only read a bundled dataset. There is **no** generic
  query/exec tool, so there's no SQL-injection or arbitrary-code surface.
- **No secrets.** Nothing reads credentials; `.env*` is gitignored. A real deployment should pass
  API tokens via environment, scope them to the minimum, and never log them.
- **Input validation at the boundary.** Every tool input is schema-validated (zod) before it
  reaches the logic; unsupported options error loudly instead of silently falling back.
- **For a *remote* deployment** (HTTP transport) you'd add: OAuth 2.1 + resource indicators,
  `Origin` validation, per-tenant isolation tests, and a scan with [`mcp-scan`](https://github.com/invariantlabs-ai/mcp-scan).
  This demo is stdio/local, so those don't apply here — but the README flags them because a client
  paying for a production server needs them.

## Layout

```
src/
  server.js   MCP transport + tool registration (thin)
  tools.js    workflow logic — pure, unit-testable
  data.js     load + normalise + data-quality flags (stderr logging)
data/
  customers.json   synthetic dataset (incl. deliberately messy rows)
test/
  tools.test.js      logic eval on the messy data
  server.e2e.test.js real MCP roundtrip over stdio
```

Built by Matthew Daly — MCP servers & AI-agent integrations, delivered as a running, documented,
tested repo with a Loom walkthrough.
