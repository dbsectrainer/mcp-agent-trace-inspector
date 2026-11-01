import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { listTraces, getSteps } from "./db.js";
// Pricing per 1K tokens (input+output average) — rough estimate
const COST_PER_1K_TOKENS_USD = 0.003;
function computeAverageLatencyMs(db) {
  const traces = listTraces(db);
  if (traces.length === 0) return 0;
  let totalLatency = 0;
  let count = 0;
  for (const trace of traces) {
    const steps = getSteps(db, trace.id);
    for (const step of steps) {
      if (step.latency_ms !== null && step.latency_ms !== undefined) {
        totalLatency += step.latency_ms;
        count++;
      }
    }
  }
  return count > 0 ? totalLatency / count : 0;
}
function computeErrorRatePct(db) {
  const traces = listTraces(db);
  if (traces.length === 0) return 0;
  let totalSteps = 0;
  let errorSteps = 0;
  for (const trace of traces) {
    const steps = getSteps(db, trace.id);
    for (const step of steps) {
      totalSteps++;
      try {
        const output = JSON.parse(step.output_json);
        if (output.error || output.isError === true) {
          errorSteps++;
        }
      } catch {
        // ignore
      }
    }
  }
  return totalSteps > 0 ? (errorSteps / totalSteps) * 100 : 0;
}
function computeTotalCostUsd(db) {
  const traces = listTraces(db);
  let totalTokens = 0;
  for (const trace of traces) {
    const steps = getSteps(db, trace.id);
    for (const step of steps) {
      if (step.token_count !== null && step.token_count !== undefined) {
        totalTokens += step.token_count;
      }
    }
  }
  return (totalTokens / 1000) * COST_PER_1K_TOKENS_USD;
}
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const isHttps = parsed.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    const req = reqFn(options, (res) => {
      res.resume(); // drain response
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
function buildSlackBlocks(alert) {
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Alert Fired: ${alert.rule.type}*\n${alert.message}\nValue: ${alert.value.toFixed(2)}, Threshold: ${alert.rule.threshold}`,
        },
      },
    ],
  };
}
export async function checkAndAlert(db, rules, channels) {
  const fired = [];
  for (const rule of rules) {
    let value = 0;
    let message = "";
    switch (rule.type) {
      case "latency":
        value = computeAverageLatencyMs(db);
        message = `Average step latency ${value.toFixed(0)}ms exceeds threshold ${rule.threshold}ms`;
        break;
      case "error_rate":
        value = computeErrorRatePct(db);
        message = `Error rate ${value.toFixed(1)}% exceeds threshold ${rule.threshold}%`;
        break;
      case "cost":
        value = computeTotalCostUsd(db);
        message = `Total cost $${value.toFixed(4)} exceeds threshold $${rule.threshold}`;
        break;
    }
    if (value > rule.threshold) {
      const alert = { rule, value, message };
      fired.push(alert);
      const sendPromises = [];
      if (channels.slackWebhook) {
        sendPromises.push(
          postJson(channels.slackWebhook, buildSlackBlocks(alert)).catch(
            (err) => {
              console.error("[alerting] Slack webhook failed:", err);
            },
          ),
        );
      }
      if (channels.genericWebhook) {
        sendPromises.push(
          postJson(channels.genericWebhook, {
            alert_type: rule.type,
            threshold: rule.threshold,
            value,
            message,
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            console.error("[alerting] Generic webhook failed:", err);
          }),
        );
      }
      await Promise.all(sendPromises);
    }
  }
  return fired;
}
// Database helpers for persisting alert rules
export function initAlertRulesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      threshold REAL NOT NULL
    );
  `);
}
export function saveAlertRules(db, rules) {
  initAlertRulesTable(db);
  db.exec("DELETE FROM alert_rules");
  const stmt = db.prepare(
    "INSERT INTO alert_rules (type, threshold) VALUES (?, ?)",
  );
  for (const rule of rules) {
    stmt.run(rule.type, rule.threshold);
  }
}
export function loadAlertRules(db) {
  initAlertRulesTable(db);
  const rows = db.prepare("SELECT type, threshold FROM alert_rules").all();
  return rows.map((r) => ({
    type: r.type,
    threshold: r.threshold,
  }));
}
