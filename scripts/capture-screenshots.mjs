#!/usr/bin/env node
/**
 * Capture real screenshots of the generated trace dashboard.
 *
 * Uses an installed Chrome/Chromium through the DevTools Protocol; no mockup
 * or synthetic image is produced. Run `npm run verify:e2e` first so that
 * docs/evidence/build-results/dashboard-demo.html exists.
 *
 * Optional: CHROME_PATH=/absolute/path/to/chrome npm run screenshots
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const inputPath = join(
  repoRoot,
  "docs",
  "evidence",
  "build-results",
  "dashboard-demo.html",
);
const outputDir = join(repoRoot, "docs", "evidence", "screenshots");
mkdirSync(outputDir, { recursive: true });

if (!existsSync(inputPath)) {
  console.error(
    `Missing ${inputPath}. Run \`npm run verify:e2e\` before capturing screenshots.`,
  );
  process.exit(1);
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const chromePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!chromePath) {
  console.error(
    "No Chrome/Chromium executable found. Set CHROME_PATH to a browser binary.",
  );
  process.exit(1);
}

const html = readFileSync(inputPath);
const htmlSha256 = createHash("sha256").update(html).digest("hex");
const htmlUrl = pathToFileURL(inputPath).href;
const userDataDir = mkdtempSync(join(tmpdir(), "trace-inspector-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let chromeStderr = "";
chrome.stderr.on("data", (chunk) => {
  chromeStderr += chunk.toString();
});

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForDebugPort(timeoutMs = 15000) {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const contents = readFileSync(portFile, "utf8").trim().split("\n");
      if (contents[0]) {
        return {
          port: Number(contents[0]),
          browserWsPath: contents[1],
        };
      }
    }
    await delay(100);
  }
  throw new Error(`Chrome did not expose DevToolsActivePort. ${chromeStderr}`);
}

async function waitForPageTarget(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" && candidate.webSocketDebuggerUrl,
    );
    if (target) return target;
    await delay(100);
  }
  throw new Error("Chrome did not expose a page target");
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
      this.ws.addEventListener(
        "error",
        () => rejectReady(new Error("CDP WebSocket error")),
        { once: true },
      );
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method) ?? [];
      for (const handler of handlers) handler(message.params);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  waitFor(method, timeoutMs = 10000) {
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(
        () => rejectWait(new Error(`Timed out waiting for ${method}`)),
        timeoutMs,
      );
      this.on(method, (params) => {
        clearTimeout(timer);
        resolveWait(params);
      });
    });
  }

  close() {
    this.ws.close();
  }
}

function pngDimensions(buffer) {
  if (buffer.length < 24) throw new Error("PNG too small");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function capture(client, {
  name,
  width,
  height,
  mobile,
  deviceScaleFactor,
  openErrorDetails,
  description,
}) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  const loaded = client.waitFor("Page.loadEventFired");
  await client.send("Page.navigate", { url: `${htmlUrl}?capture=${Date.now()}` });
  await loaded;

  if (openErrorDetails) {
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const rows = [...document.querySelectorAll("tbody tr")];
        const errorRow = rows.find((row) => row.textContent.includes("ERROR"));
        if (errorRow) {
          for (const details of errorRow.querySelectorAll("details")) {
            details.open = true;
          }
          errorRow.scrollIntoView({ block: "start" });
        }
        return { rows: rows.length, opened: Boolean(errorRow) };
      })()`,
      returnByValue: true,
    });
  }

  // Let layout settle after opening <details>.
  await delay(150);
  // Use the actual rendered body height. Page.getLayoutMetrics reports the
  // overflow extent of the scrollable timeline, which would add empty space
  // to the right/bottom of the image on narrow viewports.
  const pageMetrics = await client.send("Runtime.evaluate", {
    expression: `(() => {
      const bodyRect = document.body.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyWidth: bodyRect.width,
        bodyHeight: bodyRect.height,
        scrollHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ),
        devicePixelRatio: window.devicePixelRatio
      };
    })()`,
    returnByValue: true,
  });
  const body = pageMetrics.result.value;
  const clipWidth = width;
  const clipHeight = Math.max(1, Math.ceil(body.bodyHeight));
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: clipWidth,
      height: clipHeight,
      scale: 1,
    },
  });
  const png = Buffer.from(screenshot.data, "base64");
  const filePath = join(outputDir, `${name}.png`);
  writeFileSync(filePath, png);
  const dimensions = pngDimensions(png);
  const bytes = statSync(filePath).size;
  if (bytes < 10_000) {
    throw new Error(`${name}.png is suspiciously small (${bytes} bytes)`);
  }
  console.log(
    `Captured ${filePath} (${dimensions.width}x${dimensions.height}, ${bytes} bytes; ` +
      `inner ${body.innerWidth}x${body.innerHeight}, body ${Math.round(body.bodyWidth)}x${Math.round(body.bodyHeight)})`,
  );
  return {
    file: `docs/evidence/screenshots/${name}.png`,
    width: dimensions.width,
    height: dimensions.height,
    viewport: { width, height, mobile, deviceScaleFactor },
    description,
    bytes,
  };
}

let client;
try {
  const { port } = await waitForDebugPort();
  const target = await waitForPageTarget(port);
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");

  const consoleErrors = [];
  client.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      consoleErrors.push(
        params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") ??
          "console.error",
      );
    }
  });
  client.on("Runtime.exceptionThrown", (params) => {
    consoleErrors.push(
      params.exceptionDetails?.exception?.description ??
        params.exceptionDetails?.text ??
        "uncaught exception",
    );
  });

  const screenshots = [];
  screenshots.push(
    await capture(client, {
      name: "dashboard-desktop",
      width: 1440,
      height: 1000,
      mobile: false,
      deviceScaleFactor: 1,
      openErrorDetails: false,
      description:
        "Desktop rendering of the generated trace dashboard (stats, error-highlighted timeline, latency waterfall).",
    }),
  );
  screenshots.push(
    await capture(client, {
      name: "dashboard-error-step",
      width: 1440,
      height: 1000,
      mobile: false,
      deviceScaleFactor: 1,
      openErrorDetails: true,
      description:
        "Dashboard with the failing step's input/output JSON expanded to verify error highlighting and payload rendering.",
    }),
  );
  screenshots.push(
    await capture(client, {
      name: "dashboard-mobile",
      width: 390,
      height: 844,
      mobile: true,
      deviceScaleFactor: 2,
      openErrorDetails: false,
      description:
        "Mobile viewport (390x844, DPR 2) showing responsive stat cards and the card-style step timeline.",
    }),
  );

  if (consoleErrors.length > 0) {
    throw new Error(
      `Browser console contained ${consoleErrors.length} error(s): ${consoleErrors.join("; ")}`,
    );
  }

  writeFileSync(
    join(outputDir, "screenshots.json"),
    JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        source_html: "docs/evidence/build-results/dashboard-demo.html",
        source_html_sha256: htmlSha256,
        chrome: chromePath,
        console_errors: consoleErrors,
        screenshots,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${screenshots.length} screenshots to ${outputDir}`);
} catch (error) {
  console.error(
    `Screenshot capture failed: ${error instanceof Error ? error.stack ?? error.message : error}`,
  );
  if (chromeStderr) console.error(chromeStderr);
  process.exitCode = 1;
} finally {
  try {
    client?.close();
  } catch {
    // best-effort
  }
  chrome.kill("SIGTERM");
  await delay(250);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  rmSync(userDataDir, { recursive: true, force: true });
}
