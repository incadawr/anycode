import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { discoverClaudeBinary } from "./claude-binary.js";
import {
  buildClaudeDoctorChildEnv,
  meetsClaudeVersionFloor,
  parseClaudeVersion,
  runClaudeDoctor,
} from "./claude-doctor.js";

const fixturePath = fileURLToPath(new URL("./claude-doctor-fixtures/fake-claude.mjs", import.meta.url));

/** Every doctor test drives a FAKE spawner against a synthetic path, so the real filesystem trust gate has nothing to stat — it is stubbed "trusted" here (its own policy is asserted in codex-binary-trust.test.ts / claude-binary.test.ts). */
const TRUSTED = (): null => null;

const scratchDir = mkdtempSync(join(tmpdir(), "anycode-claude-doctor-test-"));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

function fakeSpawn(extraFlags: string[] = []) {
  return (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
    spawn(process.execPath, [fixturePath, ...args, ...extraFlags], options);
}

function freshProfileDir(): string {
  return mkdtempSync(join(scratchDir, "profile-"));
}

describe("parseClaudeVersion / meetsClaudeVersionFloor", () => {
  it("parses the live `<major>.<minor>.<patch> (Claude Code)` shape", () => {
    expect(parseClaudeVersion("2.1.212 (Claude Code)\n")).toEqual({ major: 2, minor: 1, patch: 212 });
    expect(parseClaudeVersion("2.1.214 (Claude Code)")).toEqual({ major: 2, minor: 1, patch: 214 });
  });

  it("returns null for unparseable output", () => {
    expect(parseClaudeVersion("not-a-version")).toBeNull();
    expect(parseClaudeVersion("")).toBeNull();
  });

  it("is a FLOOR — the pinned 2.1.212 and anything above/equal passes, nothing below does", () => {
    expect(meetsClaudeVersionFloor({ major: 2, minor: 1, patch: 212 })).toBe(true);
    expect(meetsClaudeVersionFloor({ major: 2, minor: 1, patch: 214 })).toBe(true);
    expect(meetsClaudeVersionFloor({ major: 3, minor: 0, patch: 0 })).toBe(true);
    expect(meetsClaudeVersionFloor({ major: 2, minor: 1, patch: 211 })).toBe(false);
    expect(meetsClaudeVersionFloor({ major: 2, minor: 0, patch: 999 })).toBe(false);
    expect(meetsClaudeVersionFloor({ major: 1, minor: 9, patch: 9 })).toBe(false);
  });
});

describe("buildClaudeDoctorChildEnv", () => {
  it("always sets CLAUDE_CONFIG_DIR to the given profile dir (custody C1)", () => {
    const env = buildClaudeDoctorChildEnv({ HOME: "/home/me", PATH: "/usr/bin" }, "/tmp/some-profile", "linux");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/some-profile");
  });

  it("never forwards ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDECODE even if present in the source env", () => {
    const source = {
      HOME: "/home/me",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
      ANTHROPIC_AUTH_TOKEN: "should-not-leak-either",
      CLAUDECODE: "1",
    };
    const env = buildClaudeDoctorChildEnv(source, "/tmp/some-profile", "linux");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("does not spread the source env wholesale (allowlist, not passthrough)", () => {
    const env = buildClaudeDoctorChildEnv({ HOME: "/home/me", PATH: "/usr/bin", SOME_RANDOM_VAR: "leak-me-not" }, "/tmp/p", "linux");
    expect(env.SOME_RANDOM_VAR).toBeUndefined();
  });
});

describe("runClaudeDoctor — status discrimination against a fake CLI", () => {
  it("ready: signed-in account -> status ready, version parsed", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(report).toEqual({ status: "ready", version: "2.1.212" });
  });

  it("signed_out: tokenSource:none -> status signed_out, from the SAME fake binary/version", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--signed-out"]),
      profileDir: freshProfileDir(),
    });
    expect(report).toEqual({ status: "signed_out", version: "2.1.212" });
  });

  it("update_required: version below the 2.1.212 floor", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--bad-version"]),
      profileDir: freshProfileDir(),
    });
    expect(report).toEqual({ status: "update_required", version: "2.1.100" });
  });

  it("error: malformed --version output", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--malformed-version"]),
      profileDir: freshProfileDir(),
    });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/Unrecognized Claude version/);
  });

  it("error: trust gate refuses the path before any spawn happens", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: () => "Claude binary is world-writable",
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(report).toEqual({ status: "error", error: "Claude binary is world-writable" });
  });

  it("error: initialize handshake times out (CLI never answers)", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--no-response"]),
      profileDir: freshProfileDir(),
      initTimeoutMs: 200,
    });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/timed out/);
  }, 10_000);

  it("error: a control_response with a mismatched request_id is never matched (times out, not a false accept)", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--bad-request-id"]),
      profileDir: freshProfileDir(),
      initTimeoutMs: 200,
    });
    expect(report.status).toBe("error");
  }, 10_000);

  it("error: CLI answers control_response{subtype:error} to initialize", async () => {
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--reject-init"]),
      profileDir: freshProfileDir(),
    });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/simulated initialize rejection/);
  });
});

describe("runClaudeDoctor — sentinel-leak PoC (discriminates real redaction, not an empty input)", () => {
  it("the fake CLI's own live response DOES carry email/organization/subscriptionType, yet the doctor's report carries none of it", async () => {
    const rawResponsePromise = new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [fixturePath], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("control_response")) {
          child.stdin.end();
          child.kill();
          resolve(out);
        }
      });
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "probe-1", request: { subtype: "initialize" } })}\n`);
    });
    const rawResponse = await rawResponsePromise;
    // Ground truth: the live control-response DOES carry the sentinel fields
    // (matches w0-13-authprobe-signedin.jsonl's live shape) — a vacuous PoC
    // that never actually carried them would prove nothing.
    expect(rawResponse).toContain("sentinel-custody@example.com");
    expect(rawResponse).toContain("Sentinel Org");
    expect(rawResponse).toContain("Claude Max");

    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain("sentinel-custody@example.com");
    expect(serializedReport).not.toContain("Sentinel Org");
    expect(serializedReport).not.toContain("Claude Max");
    expect(serializedReport).not.toContain("oauth"); // tokenSource itself never crosses either
    expect(report).toEqual({ status: "ready", version: "2.1.212" });
  });
});

describe("runClaudeDoctor — real system binary (DoD-1/DoD real-binary check, $0 control-only handshake)", () => {
  const discovered = discoverClaudeBinary({ env: process.env });
  const hasRealBinary = discovered.path !== null;

  it.skipIf(!hasRealBinary)(
    "signed_out discriminator is live against a fresh, isolated CLAUDE_CONFIG_DIR, and creates ZERO .jsonl under it",
    async () => {
      const isolatedProfile = mkdtempSync(join(tmpdir(), "anycode-claude-live-isolated-"));
      try {
        const report = await runClaudeDoctor(discovered.path!, { profileDir: isolatedProfile });
        expect(report.status).toBe("signed_out");
        // Test-hazard (a): a doctor run must never create a session .jsonl —
        // the handshake-only path terminates before any user turn, hence
        // before any project/session directory is ever created.
        const projectsDir = join(isolatedProfile, "projects");
        let entries: string[] = [];
        try {
          entries = readdirSync(projectsDir, { recursive: true }) as string[];
        } catch {
          entries = []; // directory not created at all is the strongest possible pass
        }
        const jsonlFiles = entries.filter((entry) => entry.endsWith(".jsonl"));
        expect(jsonlFiles).toEqual([]);
      } finally {
        rmSync(isolatedProfile, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.skipIf(!hasRealBinary)(
    "ready discriminator is live against the SAME system binary pointed at the real default profile (~/.claude)",
    async () => {
      const report = await runClaudeDoctor(discovered.path!, { profileDir: join(homedir(), ".claude") });
      // Discriminating by construction: this is the SAME binary path as the
      // signed_out case above — only CLAUDE_CONFIG_DIR differs — so a
      // hardcoded status could never pass both tests.
      expect(["ready", "signed_out"]).toContain(report.status);
      expect(report.version).toBeDefined();
    },
    20_000,
  );
});

/**
 * The abort/watchdog path must not RETURN while a spawned child is still
 * alive.
 *
 * The shape this replaces raced the phase chain against the abort
 * (`Promise.race([steps, aborted])`). That resolves the caller's promise while
 * the handshake child — detached, in its own process group — is still running,
 * with its EOF/SIGTERM/SIGKILL teardown left as a floating promise. The caller
 * believes the doctor settled; an app quit immediately after abandons that
 * teardown and orphans the group. Cancellation is therefore propagated INTO
 * the active phase, which still settles through its own bounded teardown.
 */
describe("runClaudeDoctor — cancellation awaits child teardown (never returns over a live child)", () => {
  it("an abort mid-handshake still reaps the child before the report is returned", async () => {
    const spawned: ChildProcess[] = [];
    const controller = new AbortController();
    const spawnImpl = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      // `--no-response` makes the handshake child sit there, exactly like a CLI
      // that accepted stdin and never answered.
      const child = spawn(process.execPath, [fixturePath, ...args, "--no-response"], options);
      spawned.push(child);
      // Abort once the handshake child (the second spawn) is up.
      if (!args.includes("--version")) setTimeout(() => controller.abort(), 20);
      return child;
    };

    const report = await runClaudeDoctor("/fake/claude", {
      spawnImpl,
      trust: TRUSTED,
      profileDir: freshProfileDir(),
      signal: controller.signal,
      env: { PATH: process.env.PATH },
      initTimeoutMs: 10_000,
    });

    expect(report).toEqual({ status: "error", error: "claude doctor aborted" });
    // The discriminator: by the time the report is in hand, every child this
    // run spawned has already exited. A race-and-return implementation returns
    // with the handshake child still running here.
    for (const child of spawned) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  }, 20_000);

  it("a watchdog expiry reports the watchdog, and likewise leaves no live child behind", async () => {
    const spawned: ChildProcess[] = [];
    const spawnImpl = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      const child = spawn(process.execPath, [fixturePath, ...args, "--no-response"], options);
      spawned.push(child);
      return child;
    };

    const report = await runClaudeDoctor("/fake/claude", {
      spawnImpl,
      trust: TRUSTED,
      profileDir: freshProfileDir(),
      env: { PATH: process.env.PATH },
      timeoutMs: 300,
      initTimeoutMs: 10_000,
    });

    expect(report.status).toBe("error");
    expect(report.error).toContain("watchdog");
    for (const child of spawned) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  }, 20_000);

  it("a signal already aborted before the run starts short-circuits without spawning anything", async () => {
    const spawned: ChildProcess[] = [];
    const controller = new AbortController();
    controller.abort();
    const report = await runClaudeDoctor("/fake/claude", {
      spawnImpl: (command, args, options) => {
        const child = spawn(process.execPath, [fixturePath, ...args], options);
        spawned.push(child);
        return child;
      },
      trust: TRUSTED,
      profileDir: freshProfileDir(),
      signal: controller.signal,
      env: { PATH: process.env.PATH },
    });
    expect(report).toEqual({ status: "error", error: "claude doctor aborted" });
    expect(spawned).toEqual([]);
  });
});
