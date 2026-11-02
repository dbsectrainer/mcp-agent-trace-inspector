#!/usr/bin/env node
/**
 * End-to-end verification for mcp-agent-trace-inspector.
 *
 * Requires `npm run build` first (or use `npm run verify:e2e`, which builds).
 * Exercises the real stdio server and the real stateless HTTP server; no mock
 * transport is used. Evidence is written under docs/evidence/.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(import.meta.dirname, "..");
const distEntry = join(repoRoot, "dist", "index.js");
const evidenceRoot = join(repoRoot, "docs", "evidence");
const testResultsDir = join(evidenceRoot, "test-results");
const buildResultsDir = join(evidenceRoot, "build-results");
mkdirSync(testResultsDir, { recursive: true });
mkdirSync(buildResultsDir, { recursive: true });

if (!existsSync(distEntry)) {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const startedAt = new Date();
const tempRoot = mkdtempSync(join(tmpdir(), "mcp-trace-inspector-e2e-"));
const logs = [];
const checks = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logs.push(line);
  console.log(line);
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, status: "pass" });
      log(`PASS ${name}`);
    })
    .catch((error) => {
      checks.push({
        name,
        status: "fail",
        error: error instanceof Error ? error.message : String(error),
      });
      log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
      throw error;
    });
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function parseMcpResponse(text) {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(jsonText);
}

async function rpc(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: parseMcpResponse(text),
    headers: response.headers,
  };
}

function initializeBody(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-verifier", version: "1.0.0" },
    },
  };
}

async function waitForListening(child, timeoutMs = 15000) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("HTTP server did not start in time"));
    }, timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      process.stderr.write(`[http-child] ${text}`);
      if (text.includes("listening on")) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolveWait();
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited early with code ${code}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

const stdioReport = {};
const httpReport = {};
let stdioStderr = "";
let httpStderr = "";
let authStderr = "";
let stdioClient;
let httpChild;
let authChild;

try {
  // -------------------------------------------------------------------------
  // 1. stdio transport: full tool surface
  // -------------------------------------------------------------------------
  const home = join(tempRoot, "home");
  const dbPath = join(tempRoot, "stdio.db");
  const auditPath = join(tempRoot, "audit.jsonl");
  const pricingPath = join(tempRoot, "pricing.json");
  writeFileSync(
    pricingPath,
    JSON.stringify({ "demo-model": { input: 0.5, output: 1.0 } }),
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      distEntry,
      `--db=${dbPath}`,
      `--pricing-table=${pricingPath}`,
    ],
    env: {
      ...process.env,
      HOME: home,
      MCP_AUDIT_LOG_PATH: auditPath,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stdioStderr += chunk.toString();
  });

  stdioClient = new Client(
    { name: "e2e-verifier", version: "1.0.0" },
    { capabilities: {} },
  );
  await stdioClient.connect(transport);

  await check("stdio initialize advertises package version", () => {
    assert.equal(stdioClient.getServerVersion()?.name, pkg.name);
    assert.equal(stdioClient.getServerVersion()?.version, pkg.version);
  });

  await check("stdio lists all 13 tools", async () => {
    const response = await stdioClient.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "apply_retention",
      "compare_traces",
      "configure_alerts",
      "export_compliance_log",
      "export_dashboard",
      "export_otel",
      "extract_reasoning_chain",
      "get_trace_summary",
      "list_traces",
      "set_retention_policy",
      "trace_end",
      "trace_start",
      "trace_step",
    ]);
  });

  const call = async (name, args) => {
    const result = await stdioClient.callTool({ name, arguments: args });
    return result.content.map((item) => item.text ?? "").join("\n");
  };

  const firstStart = JSON.parse(
    await call("trace_start", { name: "E2E Verification Trace" }),
  );
  const traceId = firstStart.trace_id;
  assert.ok(traceId);

  await check("trace lifecycle: start, five steps, summary", async () => {
    const steps = [
      {
        tool_name: "prompt",
        input: { query: "Summarize the release notes" },
        output: { plan: "think about the audience" },
        token_count: 120,
        latency_ms: 15,
      },
      {
        tool_name: "reasoning_tool",
        input: { context: "release notes" },
        output: { action: "search" },
        token_count: 80,
        latency_ms: 40,
      },
      {
        tool_name: "failing_tool",
        input: { id: 42 },
        output: { error: "simulated failure" },
        token_count: 10,
        latency_ms: 5,
      },
      {
        tool_name: "http_fetch",
        input: { url: "https://example.com/releases" },
        output: { status: 200, body: "release notes" },
        token_count: 200,
        latency_ms: 120,
      },
      {
        tool_name: "auto_token_tool",
        input: { note: "token count is computed by the server" },
        output: { ok: true },
      },
    ];

    for (const step of steps) {
      const stepResult = JSON.parse(
        await call("trace_step", { trace_id: traceId, ...step }),
      );
      if (step.token_count === undefined) {
        assert.ok(
          Number.isInteger(stepResult.token_count) &&
            stepResult.token_count > 0,
          "automatic token count should be a positive integer",
        );
      }
    }

    const summary = JSON.parse(
      (await call("get_trace_summary", {
        trace_id: traceId,
        model: "demo-model",
      })).split("\n\nJSON:\n")[1],
    );
    assert.equal(summary.status, "running");
    assert.equal(summary.step_count, 5);
    assert.ok(summary.total_tokens >= 410);
    assert.ok(summary.total_latency_ms >= 180);
    assert.ok(Math.abs(summary.estimated_cost_usd - (summary.total_tokens * 0.5) / 1000) < 1e-9);
    assert.equal(summary.reasoning_chain_detected, true);
    stdioReport.summary = summary;
  });

  await check("configure_alerts and trace_end evaluate rules", async () => {
    const configure = JSON.parse(
      await call("configure_alerts", {
        rules: [
          { type: "error_rate", threshold: 0 },
          { type: "latency", threshold: 1 },
        ],
      }),
    );
    assert.equal(configure.rules_saved, 2);

    const ended = JSON.parse(await call("trace_end", { trace_id: traceId }));
    assert.equal(ended.status, "completed");
    assert.equal(ended.alerts_fired, 2);
    assert.deepEqual(
      ended.alerts.map((alert) => alert.type).sort(),
      ["error_rate", "latency"],
    );
    stdioReport.trace_end = ended;

    const endedAgain = JSON.parse(
      await call("trace_end", { trace_id: traceId }),
    );
    assert.equal(endedAgain.already_completed, true);
    assert.equal(endedAgain.alerts_fired, 0);
  });

  await check("export_dashboard produces a self-contained HTML file", async () => {
    const html = await call("export_dashboard", { trace_id: traceId });
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("E2E Verification Trace"));
    assert.ok(html.includes('class="badge">completed</span>'));
    assert.ok(html.includes("error-badge"));
    assert.ok(html.includes("waterfall-bar"));
    assert.ok(!html.includes("<script src="));
    const dashboardPath = join(buildResultsDir, "dashboard-demo.html");
    writeFileSync(dashboardPath, html);
    stdioReport.dashboard_path = dashboardPath;
    stdioReport.dashboard_bytes = Buffer.byteLength(html);
  });

  const secondStart = JSON.parse(
    await call("trace_start", { name: "E2E Comparison Trace" }),
  );
  const secondTraceId = secondStart.trace_id;

  await check("second trace supports compare_traces", async () => {
    await call("trace_step", {
      trace_id: secondTraceId,
      tool_name: "prompt",
      input: { query: "Compare me" },
      output: { plan: "be shorter" },
      token_count: 60,
      latency_ms: 10,
    });
    await call("trace_step", {
      trace_id: secondTraceId,
      tool_name: "reasoning_tool",
      input: {},
      output: { action: "answer" },
      token_count: 40,
      latency_ms: 20,
    });
    await call("trace_end", { trace_id: secondTraceId });

    const comparison = JSON.parse(
      (await call("compare_traces", {
        trace_id_a: traceId,
        trace_id_b: secondTraceId,
      })).split("\n\nJSON:\n")[1],
    );
    assert.equal(comparison.diff.step_count, -3);
    assert.equal(comparison.trace_b.step_count, 2);
    stdioReport.comparison = comparison;
  });

  await check("extract_reasoning_chain finds reasoning steps", async () => {
    const raw = await call("extract_reasoning_chain", { trace_id: traceId });
    const json = JSON.parse(raw.split("\n\nJSON:\n")[1]);
    assert.equal(json.reasoning_step_count, 2);
    assert.deepEqual(
      json.steps.map((step) => step.tool_name),
      ["prompt", "reasoning_tool"],
    );
  });

  await check("list_traces returns both traces", async () => {
    const listed = await call("list_traces", { limit: 10 });
    assert.ok(listed.includes("E2E Verification Trace"));
    assert.ok(listed.includes("E2E Comparison Trace"));
  });

  await check("resources and prompts are exposed", async () => {
    const resource = await stdioClient.readResource({
      uri: `trace://${traceId}`,
    });
    const content = JSON.parse(resource.contents[0].text);
    assert.equal(content.trace_id, traceId);
    assert.equal(content.step_count, 5);

    const prompts = await stdioClient.listPrompts();
    assert.ok(prompts.prompts.some((prompt) => prompt.name === "analyze-trace"));
    const prompt = await stdioClient.getPrompt({
      name: "analyze-trace",
      arguments: { trace_id: traceId },
    });
    assert.ok(prompt.messages[0].content.text.includes(traceId));
  });

  await check("export_otel returns a standard OTLP/JSON document", async () => {
    const document = JSON.parse(
      await call("export_otel", { format: "json", trace_id: traceId }),
    );
    assert.equal(document.resourceSpans.length, 1);
    const spans = document.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 6);
    assert.ok(spans.some((span) => span.name === "failing_tool"));
    assert.ok(spans.every((span) => /^[0-9a-f]{32}$/.test(span.traceId)));
    stdioReport.otlp_span_count = spans.length;
  });

  await check("compliance audit log exports JSON and CSV", async () => {
    const jsonText = await call("export_compliance_log", { format: "json" });
    const entries = JSON.parse(jsonText);
    assert.equal(entries.length, 7);
    assert.ok(entries.every((entry) => entry.trace_id));
    assert.ok(existsSync(auditPath));

    const csv = await call("export_compliance_log", { format: "csv" });
    const lines = csv.split("\n");
    assert.equal(lines[0], "timestamp,trace_id,tool_name,user_id,token_count,cost_usd");
    assert.equal(lines.length, 8);
    stdioReport.audit_entries = entries.length;
  });

  await check("retention policy can be set and applied", async () => {
    const setResult = JSON.parse(
      await call("set_retention_policy", { retention_days: 30 }),
    );
    assert.equal(setResult.retention_days, 30);
    const applied = JSON.parse(await call("apply_retention", {}));
    assert.equal(applied.status, "ok");
    assert.equal(applied.archived, 0);
    assert.equal(applied.deleted, 0);
  });

  await check("invalid operations fail without corrupting state", async () => {
    await assert.rejects(
      stdioClient.callTool({
        name: "trace_step",
        arguments: {
          trace_id: traceId,
          tool_name: "late_tool",
          input: {},
          output: {},
        },
      }),
      /already ended/,
    );
    await assert.rejects(
      stdioClient.callTool({
        name: "list_traces",
        arguments: { limit: 1.5 },
      }),
      /positive integer/,
    );
    await assert.rejects(
      stdioClient.callTool({
        name: "export_compliance_log",
        arguments: { format: "xml" },
      }),
      /format must be/,
    );
  });

  await check("generic alert webhook receives fired alerts", async () => {
    const received = [];
    const hookServer = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          received.push(JSON.parse(body));
        } catch {
          received.push({ malformed: body });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise((resolveListen, reject) => {
      hookServer.once("error", reject);
      hookServer.listen(0, "127.0.0.1", resolveListen);
    });
    const address = hookServer.address();
    const hookPort = typeof address === "object" && address ? address.port : 0;

    try {
      await call("configure_alerts", {
        rules: [{ type: "error_rate", threshold: 0 }],
        webhook_url: `http://127.0.0.1:${hookPort}/alert`,
      });

      const webhookTrace = JSON.parse(
        await call("trace_start", { name: "Webhook Delivery Trace" }),
      );
      await call("trace_step", {
        trace_id: webhookTrace.trace_id,
        tool_name: "webhook_failing_tool",
        input: {},
        output: { error: "webhook verification" },
        token_count: 5,
        latency_ms: 1,
      });
      const ended = JSON.parse(
        await call("trace_end", { trace_id: webhookTrace.trace_id }),
      );

      assert.ok(ended.alerts_fired >= 1);
      assert.ok(received.length >= 1, "webhook received no payload");
      const payload = received[0];
      assert.equal(payload.alert_type, "error_rate");
      assert.equal(typeof payload.message, "string");
      assert.ok(payload.timestamp);
      stdioReport.webhook_alerts = received.length;
      stdioReport.webhook_payload = payload;
    } finally {
      await new Promise((resolveClose) => hookServer.close(resolveClose));
    }
  });

  await stdioClient.close();
  writeFileSync(
    join(testResultsDir, "stdio-e2e.json"),
    JSON.stringify(
      {
        timestamp: startedAt.toISOString(),
        node: process.version,
        package: pkg.version,
        database: dbPath,
        audit_log: auditPath,
        report: stdioReport,
      },
      null,
      2,
    ),
  );
  log("stdio E2E complete");

  // -------------------------------------------------------------------------
  // 2. HTTP transport: stateless multi-request behavior
  // -------------------------------------------------------------------------
  const httpPort = await getFreePort();
  const httpDb = join(tempRoot, "http.db");
  const httpHome = join(tempRoot, "http-home");
  httpChild = spawn(
    process.execPath,
    [
      distEntry,
      `--db=${httpDb}`,
      `--pricing-table=${pricingPath}`,
      `--http-port=${httpPort}`,
      "--http-host=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        HOME: httpHome,
        MCP_AUDIT_LOG_PATH: join(tempRoot, "http-audit.jsonl"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  httpChild.stderr.on("data", (chunk) => {
    httpStderr += chunk.toString();
  });
  httpChild.stdout.on("data", () => {});
  await waitForListening(httpChild);
  const httpUrl = `http://127.0.0.1:${httpPort}/mcp`;

  await check("HTTP serves two sequential initialize requests", async () => {
    const first = await rpc(httpUrl, initializeBody(1));
    assert.equal(first.status, 200);
    assert.equal(first.json.result.serverInfo.version, pkg.version);
    assert.ok(!first.text.includes("Already connected to a transport"));

    const second = await rpc(httpUrl, initializeBody(2));
    assert.equal(second.status, 200);
    assert.equal(second.json.result.serverInfo.name, pkg.name);
    httpReport.initialize_requests = 2;
  });

  const httpTraceStart = await rpc(httpUrl, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "trace_start", arguments: { name: "HTTP E2E Trace" } },
  });
  const httpTraceId = JSON.parse(
    httpTraceStart.json.result.content[0].text,
  ).trace_id;

  await check("HTTP tool calls share the database across requests", async () => {
    const step = await rpc(httpUrl, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "trace_step",
        arguments: {
          trace_id: httpTraceId,
          tool_name: "http_step",
          input: { source: "http" },
          output: { ok: true },
          token_count: 25,
          latency_ms: 12,
        },
      },
    });
    assert.equal(step.status, 200);

    const end = await rpc(httpUrl, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "trace_end", arguments: { trace_id: httpTraceId } },
    });
    assert.equal(JSON.parse(end.json.result.content[0].text).status, "completed");

    const summary = await rpc(httpUrl, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "get_trace_summary",
        arguments: { trace_id: httpTraceId, model: "demo-model" },
      },
    });
    const summaryText = summary.json.result.content[0].text;
    assert.ok(summaryText.includes("HTTP E2E Trace"));

    const listed = await rpc(httpUrl, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_traces", arguments: {} },
    });
    assert.ok(listed.json.result.content[0].text.includes("HTTP E2E Trace"));
  });

  await check("HTTP rejects GET and malformed JSON cleanly", async () => {
    const getResponse = await fetch(httpUrl, { method: "GET" });
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get("allow"), "POST");
    const getBody = await getResponse.json();
    assert.equal(getBody.error.code, -32000);

    const badResponse = await fetch(httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    assert.equal(badResponse.status, 400);
    const badText = await badResponse.text();
    const badBody = JSON.parse(badText);
    assert.equal(badBody.error.code, -32700);
    assert.ok(!badText.includes("SyntaxError"));
  });

  await stopChild(httpChild);
  writeFileSync(
    join(testResultsDir, "http-e2e.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        node: process.version,
        package: pkg.version,
        url: httpUrl,
        report: httpReport,
        stderr: httpStderr,
      },
      null,
      2,
    ),
  );
  log("HTTP E2E complete");

  // -------------------------------------------------------------------------
  // 3. HTTP auth enforcement
  // -------------------------------------------------------------------------
  const authPort = await getFreePort();
  authChild = spawn(
    process.execPath,
    [
      distEntry,
      `--db=${join(tempRoot, "auth.db")}`,
      `--http-port=${authPort}`,
      "--http-host=127.0.0.1",
    ],
    {
      env: {
        ...process.env,
        HOME: join(tempRoot, "auth-home"),
        MCP_AUDIT_LOG_PATH: join(tempRoot, "auth-audit.jsonl"),
        MCP_API_KEY: "e2e-test-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  authChild.stderr.on("data", (chunk) => {
    authStderr += chunk.toString();
  });
  authChild.stdout.on("data", () => {});
  await waitForListening(authChild);
  const authUrl = `http://127.0.0.1:${authPort}/mcp`;

  await check("HTTP authentication rejects missing/incorrect keys", async () => {
    const unauthorized = await rpc(authUrl, initializeBody(1));
    assert.equal(unauthorized.status, 401);

    const wrong = await rpc(authUrl, initializeBody(2), {
      "x-api-key": "wrong",
    });
    assert.equal(wrong.status, 401);

    const authorized = await rpc(authUrl, initializeBody(3), {
      "x-api-key": "e2e-test-key",
    });
    assert.equal(authorized.status, 200);
  });

  await stopChild(authChild);
  writeFileSync(
    join(testResultsDir, "http-auth-e2e.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        url: authUrl,
        checks: ["401 without key", "401 with wrong key", "200 with correct key"],
        stderr: authStderr,
      },
      null,
      2,
    ),
  );
  log("HTTP auth E2E complete");

  // -------------------------------------------------------------------------
  // 4. CLI version + final evidence
  // -------------------------------------------------------------------------
  await check("CLI --version matches package.json", async () => {
    const output = await new Promise((resolveVersion, reject) => {
      const child = spawn(process.execPath, [distEntry, "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("exit", (code) => {
        if (code === 0) resolveVersion(stdout.trim());
        else reject(new Error(stderr || `--version exited ${code}`));
      });
    });
    assert.equal(output, pkg.version);
  });

  writeFileSync(
    join(testResultsDir, "e2e-run.log"),
    `${logs.join("\n")}\n\n=== stdio stderr ===\n${stdioStderr}\n\n=== http stderr ===\n${httpStderr}\n\n=== auth stderr ===\n${authStderr}\n`,
  );
  writeFileSync(
    join(testResultsDir, "e2e-summary.json"),
    JSON.stringify(
      {
        timestamp: startedAt.toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        node: process.version,
        package: pkg.version,
        checks,
        stdio: stdioReport,
        http: httpReport,
      },
      null,
      2,
    ),
  );

  const failures = checks.filter((item) => item.status === "fail");
  log(`E2E summary: ${checks.length - failures.length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  log(`E2E FAILED: ${error instanceof Error ? error.stack ?? error.message : error}`);
  writeFileSync(
    join(testResultsDir, "e2e-summary.json"),
    JSON.stringify(
      {
        timestamp: startedAt.toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        node: process.version,
        package: pkg.version,
        checks,
        error: error instanceof Error ? error.message : String(error),
        stdio_stderr: stdioStderr,
        http_stderr: httpStderr,
        auth_stderr: authStderr,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(testResultsDir, "e2e-run.log"), `${logs.join("\n")}\n`);
  process.exitCode = 1;
} finally {
  try {
    if (stdioClient) await stdioClient.close();
  } catch {
    // best-effort
  }
  if (httpChild) await stopChild(httpChild);
  if (authChild) await stopChild(authChild);
  rmSync(tempRoot, { recursive: true, force: true });
}
