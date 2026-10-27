import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("../../scripts/prompt-cache-ui-smoke.mjs", import.meta.url));
const source = readFileSync(script, "utf8");

describe("prompt cache smoke driver", () => {
  it("selects either documented transport and rejects missing or unknown arguments before launch", () => {
    for (const transport of ["openai-chat-completions", "openai-responses"]) {
      expect(execFileSync(process.execPath, [script, "--transport", transport, "--check-args"], { encoding: "utf8" }).trim()).toBe(transport);
      expect(execFileSync(process.execPath, [script, `--transport=${transport}`, "--check-args"], { encoding: "utf8" }).trim()).toBe(transport);
    }
    for (const args of [["--transport"], ["--transport", "bogus"], ["--unknown"]]) {
      expect(spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }).status).not.toBe(0);
    }
  });

  it("isolates home, imports, telemetry and inherited path overrides in the launched environment", () => {
    const start = source.indexOf("const env = {", source.indexOf("const stubEngine"));
    const end = source.indexOf("// No ambient provider env", start);
    const block = source.slice(start, end);
    const build = new Function("process", "profile", "join", "debugPort", "discoveryPath", "settingsPath", "workspace", "stubEngine", `${block} return env;`);
    const env = build({ env: { PATH: "/bin", HOME: "/owner", ANYCODE_HOOKS_HOME: "/owner", XDG_CONFIG_HOME: "/owner", OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.invalid" } }, "/scratch", (...parts: string[]) => parts.join("/"), 123, "/scratch/discovery", "/scratch/settings", "/scratch/workspace", "/scratch/stub");
    expect(env.HOME).toBe("/scratch/home");
    for (const key of ["XDG_CONFIG_HOME", "ANYCODE_PROFILE_HOME", "ANYCODE_MCP_IMPORT_HOME", "ANYCODE_SKILLS_IMPORT_HOME", "ANYCODE_SUBAGENTS_HOME", "ANYCODE_CODEX_PROFILES_HOME", "ANYCODE_TELEMETRY_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANYCODE_USER_DATA_DIR"]) {
      expect(env[key]).toMatch(/^\/scratch\//);
    }
    expect(env.ANYCODE_HOOKS_HOME).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it("unmounts the saved editor before reopening it", async () => {
    const segment = source.slice(source.indexOf("// Unmount before reopening"), source.indexOf('  await screenshot("step-4-enabled-persisted")'));
    const calls: string[] = [];
    let mounted = true;
    const api = async (_method: string, path: string) => {
      calls.push(path);
      if (path.endsWith("/close")) mounted = false;
      if (path.endsWith("/menu")) { assert.equal(mounted, false); mounted = true; }
      return { ok: true };
    };
    const evaluate = async (expression: string) => expression.startsWith("!document.querySelector") ? !mounted : mounted;
    const poll = async (fn: () => Promise<unknown>) => assert.ok(await fn());
    const execute = new Function("api", "poll", "evaluate", "sleep", "cacheSelectValue", "assert", "CONNECTION_ID", `return (async () => { ${segment} })()`);
    await execute(api, poll, evaluate, async () => {}, async () => "implicit", assert, "fixture");
    expect(calls).toEqual(["/settings/provider/drawer/close", "/settings/provider/menu"]);
  });

  it("closes and resumes the enabled session before checking its restored audit", async () => {
    const segment = source.slice(source.indexOf("  // Close and resume the same durable session"), source.indexOf("  pass(5,"));
    const calls: string[] = [];
    const api = async (method: string, path: string, body?: { sessionId?: string }) => {
      calls.push(`${method} ${path}`);
      if (path === "/state") return { tabs: [{ tabId: "on", sessionId: "saved" }] };
      if (path === "/tabs") { assert.equal(body?.sessionId, "saved"); return { ok: true, tabId: "resumed" }; }
      return { ok: true };
    };
    const execute = new Function("api", "poll", "evaluate", "assert", "writeFileSync", "join", "profile", "screenshot", "onTabId", `return (async () => { ${segment} })()`);
    await execute(api, async (fn: () => Promise<unknown>) => fn(), async (expr: string) => expr.includes("textContent") ? "80% cache (16K/20K input)" : true, assert, () => {}, () => "", "", async () => {}, "on");
    expect(calls).toEqual(["GET /state", "POST /tabs/on/close", "POST /tabs", "POST /tabs/resumed/select"]);
  });
});
