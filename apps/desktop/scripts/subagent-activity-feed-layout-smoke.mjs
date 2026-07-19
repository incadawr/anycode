/**
 * Deterministic Chromium layout regression for TASK.73.
 *
 * Unlike the live subagent-card smoke, this needs no provider or running app:
 * it loads the production CSS into an isolated headless Chrome, creates a
 * long activity feed, and measures real Blink layout geometry. Removing the row's
 * `flex-shrink: 0` makes the rows collapse to less than their line box and
 * makes scrollHeight equal clientHeight, so this test fails for the original
 * defect rather than for a mocked approximation of it.
 *
 * Usage: pnpm --filter @anycode/desktop smoke:subagent-feed-layout
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(here, "..", "src", "renderer", "src");
const css = readFileSync(resolve(rendererRoot, "tool-cards.css"), "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const chrome = findChrome();
assert(chrome !== null, "Chrome/Chromium not found; set CHROME_BIN to run the layout smoke");

const runDir = mkdtempSync(join(tmpdir(), "anycode-subagent-feed-layout-"));
let chromeProcess = null;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForDebuggerUrl(child, timeoutMs = 15_000) {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      return match[1];
    }
    if (child.exitCode !== null) {
      throw new Error(`headless Chrome exited ${child.exitCode}: ${stderr.trim()}`);
    }
    await delay(50);
  }
  throw new Error(`headless Chrome did not expose DevTools within ${timeoutMs}ms: ${stderr.trim()}`);
}

async function pageDebuggerUrl(browserDebuggerUrl, timeoutMs = 10_000) {
  const endpoint = new URL(browserDebuggerUrl);
  const listUrl = `http://${endpoint.host}/json/list`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetch(listUrl).then((response) => response.json());
    const page = targets.find((target) => target.type === "page" && target.url.startsWith("file:"));
    if (page?.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }
    await delay(50);
  }
  throw new Error(`headless Chrome did not expose the fixture page within ${timeoutMs}ms`);
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolveValue, rejectValue) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      rejectValue(new Error("DevTools Runtime.evaluate timed out"));
    }, 10_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        rejectValue(new Error(`Runtime.evaluate failed: ${JSON.stringify(message)}`));
        return;
      }
      resolveValue(message.result.result.value);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectValue(new Error("DevTools WebSocket failed"));
    });
  });
}

try {
  const rows = Array.from({ length: 12 }, (_, index) => {
    const dropped = index === 0 ? " subagent-activity-row-dropped" : "";
    return `<li class="subagent-activity-row${dropped}">${index === 0 ? "+8 earlier" : `Read file-${index}.ts`}</li>`;
  }).join("");
  const html = `<!doctype html>
    <title>pending</title>
    <style>
      :root {
        --sp-2: 0.5rem;
        --sp-3: 0.75rem;
        --fs-xs: 0.75rem;
        --font-mono: ui-monospace, monospace;
        --text-3: #777;
        --text-ghost: #999;
        --border: #444;
      }
      * { box-sizing: border-box; }
      body { margin: 0; line-height: 20px; }
      ${css}
    </style>
    <ul class="subagent-activity-feed">${rows}</ul>
    <script>
      const feed = document.querySelector('.subagent-activity-feed');
      const feedRows = [...document.querySelectorAll('.subagent-activity-row')];
      const readings = feedRows.map((row) => ({
        height: row.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(row).lineHeight),
        flexShrink: getComputedStyle(row).flexShrink,
      }));
      const geometry = {
        clientHeight: feed.clientHeight,
        scrollHeight: feed.scrollHeight,
        scrollTop: feed.scrollTop,
        readings,
      };
      feed.scrollTop = feed.scrollHeight;
      geometry.scrolledTop = feed.scrollTop;
      geometry.bottomGap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
      document.body.dataset.result = btoa(JSON.stringify(geometry));
    </script>`;

  const fixturePath = join(runDir, "fixture.html");
  writeFileSync(fixturePath, html);
  chromeProcess = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(runDir, "profile")}`,
      "--remote-debugging-port=0",
      `file://${fixturePath}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const browserUrl = await waitForDebuggerUrl(chromeProcess);
  const pageUrl = await pageDebuggerUrl(browserUrl);
  const encoded = await evaluate(
    pageUrl,
    `new Promise((resolve) => {
      const read = () => {
        const value = document.body?.dataset.result;
        if (value) resolve(value); else setTimeout(read, 10);
      };
      read();
    })`,
  );
  assert(typeof encoded === "string" && encoded.length > 0, "fixture page returned no geometry result");
  const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

  assert(
    geometry.readings.every((row) => row.flexShrink === "0"),
    `expected every ordinary/dropped row to have flex-shrink:0, got ${JSON.stringify(geometry.readings)}`,
  );
  assert(
    geometry.readings.every((row) => row.height + 0.5 >= row.lineHeight),
    `a feed row collapsed below its line box: ${JSON.stringify(geometry.readings)}`,
  );
  assert(
    geometry.scrollHeight > geometry.clientHeight,
    `expected real overflow, got scrollHeight=${geometry.scrollHeight}, clientHeight=${geometry.clientHeight}`,
  );
  assert(
    geometry.scrolledTop > 0 && Math.abs(geometry.bottomGap) <= 1,
    `scroll-to-newest remained a no-op: scrollTop=${geometry.scrolledTop}, bottomGap=${geometry.bottomGap}`,
  );

  console.log(
    `[subagent-feed-layout] PASS rows=${geometry.readings.length} ` +
      `clientHeight=${geometry.clientHeight} scrollHeight=${geometry.scrollHeight} scrollTop=${geometry.scrolledTop}`,
  );
} catch (error) {
  console.error(`[subagent-feed-layout] FAIL ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (chromeProcess && chromeProcess.exitCode === null) {
    chromeProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => chromeProcess.once("exit", resolveExit)),
      delay(2_000),
    ]);
  }
  // Chrome helpers can release the last profile file a few milliseconds after
  // the browser PID exits on macOS. Cleanup is best-effort test hygiene, never
  // a reason to obscure the actual layout assertion.
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (cleanupError) {
    console.warn(`[subagent-feed-layout] could not remove ${runDir}: ${cleanupError?.message ?? cleanupError}`);
  }
}
