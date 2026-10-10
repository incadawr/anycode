/**
 * TASK.237 LIVE upgrade leg (env-gated, ANYCODE_CODEX_LIVE_SMOKE=1): drives
 * the PRODUCTION `runCodexManagedUpgrade` against the REAL npm registry in a
 * THROWAWAY home seeded with the incident's machine state — a managed
 * 0.144.3 tree (a shell stub at the installer's exact path: the upgrade
 * decision reads the directory name, never runs the old binary) and settings
 * pointing at it — and proves the outcome the DoD
 * names: the settings path is repointed to the recommended 0.160.0 AND the
 * NEW binary's live model/list serves the gpt-6 family the old one lacked.
 *
 * Without the env gate every case is an explicit SKIP, never a green PASS
 * (hazard §14.11). Account state: the model/list probe runs against the
 * AMBIENT codex account (CODEX_HOME untouched = whatever this machine's
 * login is); the assertion is about the CATALOG DIFFERENCE between binary
 * versions, which is account-independent to first order. A signed-out
 * account answers an empty model/list; that FAILS this leg — without a
 * catalog the DoD's "models are re-read" is unproven, so it is never a PASS.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_CODEX_MANIFEST } from "../shared/codex-support.js";
import { setActiveCodexVersionPolicy, resetActiveCodexVersionPolicy } from "./codex-manifest.js";
import { runCodexManagedUpgrade } from "./codex-managed-upgrade.js";

const LIVE = process.env.ANYCODE_CODEX_LIVE_SMOKE === "1";
const OLD_VERSION = "0.144.3";
const NEW_VERSION = BUNDLED_CODEX_MANIFEST.recommended; // 0.160.0
const TRIPLE = "aarch64-apple-darwin";

/**
 * One-shot JSON-RPC line client for the model/list probe: writes the
 * requests, then reads stdout until the reply with `awaitId` arrives (the
 * catalog is fetched over the network, so its latency varies) and only then
 * closes stdin. Closing stdin earlier lets the app-server exit unanswered.
 */
function rpcReply(binaryPath: string, requests: Array<Record<string, unknown>>, awaitId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffered = "";
    let reply: unknown = null;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`app-server never answered request ${awaitId} within 60s`));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: unknown };
          if (message.id === awaitId) {
            reply = message;
            child.stdin.end();
          }
        } catch {
          // not a JSON line — tolerant
        }
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(reply);
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

async function collectModelIds(binaryPath: string): Promise<string[] | null> {
  const reply = (await rpcReply(
    binaryPath,
    [
      { id: 1, method: "initialize", params: { clientInfo: { name: "anycode-smoke", title: "smoke", version: "0.0.0" }, capabilities: { experimentalApi: false } } },
      { method: "initialized" },
      { id: 2, method: "model/list", params: {} },
    ],
    2,
  )) as { result?: { data?: Array<{ id?: unknown }> } } | null;
  const data = reply?.result?.data;
  return Array.isArray(data) ? data.map((entry) => String(entry.id)) : null;
}

describe("codex managed-upgrade live smoke (real registry; SKIP without ANYCODE_CODEX_LIVE_SMOKE=1)", () => {
  it.runIf(LIVE)(
    "upgrades a real managed 0.144.3 to the recommended version and the new binary's model/list serves the current catalog",
    async () => {
      setActiveCodexVersionPolicy({ manifest: BUNDLED_CODEX_MANIFEST, riskAcceptedVersions: [] });
      const home = mkdtempSync(join(tmpdir(), "anycode-managed-upgrade-live-"));
      try {
        // Seed the incident's machine state: a managed 0.144.3 at the
        // installer's exact path (a stub — only its location is read) and
        // settings pointing at it.
        const oldBinaryPath = join(home, ".anycode", "codex", "bin", OLD_VERSION, "vendor", TRIPLE, "bin", "codex");
        mkdirSync(dirname(oldBinaryPath), { recursive: true });
        writeFileSync(oldBinaryPath, "#!/bin/sh\necho codex-cli 0.144.3\n");
        chmodSync(oldBinaryPath, 0o755);

        let persisted: string | undefined;
        const result = await runCodexManagedUpgrade({
          home,
          platform: "darwin",
          arch: "arm64",
          readBinaryPathSetting: async () => oldBinaryPath,
          swapBinaryPath: async (expected, next) => {
            if (expected !== oldBinaryPath) return { ok: false, reason: "changed" };
            persisted = next;
            return { ok: true };
          },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.upgraded).toBe(true);
        if (!result.upgraded) return;
        expect(result.fromVersion).toBe(OLD_VERSION);
        expect(result.toVersion).toBe(NEW_VERSION);
        expect(persisted).toBe(join(home, ".anycode", "codex", "bin", NEW_VERSION, "vendor", TRIPLE, "bin", "codex"));
        expect(existsSync(persisted!)).toBe(true);

        // The NEW binary's live catalog — the half of the DoD the user sees.
        // No catalog (signed out, blocked) is a FAIL, not a partial pass.
        const ids = await collectModelIds(persisted!);
        expect(ids, "model/list on the upgraded binary returned no catalog (account signed out?) — DoD unproven").not.toBeNull();
        expect(ids!.length, "model/list on the upgraded binary returned an empty catalog — DoD unproven").toBeGreaterThan(0);
        console.log(`[managed-upgrade-live-smoke] new model/list (${ids!.length} models): ${ids!.join(", ")}`);
        const hasGpt6 = ids!.some((id) => /gpt-6/i.test(id));
        console.log(`[managed-upgrade-live-smoke] new catalog contains gpt-6 family: ${hasGpt6}`);
        expect(hasGpt6).toBe(true);
      } finally {
        resetActiveCodexVersionPolicy();
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    15 * 60_000,
  );

  it.runIf(!LIVE)("SKIP: live upgrade smoke not run — set ANYCODE_CODEX_LIVE_SMOKE=1 with network access to execute it", (context) => {
    context.skip();
  });
});
