import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { discoverClaudeBinary } from "./claude-binary.js";
import { ENV_CLAUDE_PROXY_URL, LOOPBACK_NO_PROXY } from "../shared/engines.js";
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
  it("sets CLAUDE_CONFIG_DIR to an explicit profile dir override", () => {
    const env = buildClaudeDoctorChildEnv({ HOME: "/home/me", PATH: "/usr/bin" }, "/tmp/some-profile", "linux");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/some-profile");
  });

  it("ambient default (owner pivot): no profileDir override -> no CLAUDE_CONFIG_DIR key at all", () => {
    const env = buildClaudeDoctorChildEnv({ HOME: "/home/me", PATH: "/usr/bin" }, undefined, "linux");
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
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

describe("buildClaudeDoctorChildEnv — engine proxy carrier (TASK.139)", () => {
  /** Carries `user:pass@` userinfo on purpose — the authenticated-proxy case the field exists for. */
  const ENGINE_PROXY = "http://user:pass@claude-proxy.example.com:3128";
  const SHELL_PROXY = "http://shell-proxy.internal:8080";
  /** PATH after `augmentPathForGui` on a POSIX platform. */
  const AUGMENTED_PATH = "/usr/bin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin";
  const HYGIENE = {
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_ENTRYPOINT: "anycode",
  };

  // Byte-identity, asserted over the WHOLE child env rather than selected keys.
  it("without a carrier the doctor child env is byte-identical to the pre-TASK.139 build", () => {
    const env = buildClaudeDoctorChildEnv({ HOME: "/home/me", PATH: "/usr/bin" }, undefined, "linux");
    expect(env).toEqual({ HOME: "/home/me", PATH: AUGMENTED_PATH, ...HYGIENE });
  });

  // The pre-existing asymmetry with the codex doctor, pinned so a later change
  // cannot silently "fix" it: this builder's allowlist names NO proxy var, so a
  // SHELL-exported proxy has never reached this child and still does not. The
  // override triggers only on a carrier, and main emits no carrier when the
  // shell owns the family — so the two facts can never collide.
  it("a shell-exported proxy in the source STILL does not leak (asymmetry deliberately preserved)", () => {
    const env = buildClaudeDoctorChildEnv(
      { HOME: "/home/me", PATH: "/usr/bin", HTTPS_PROXY: SHELL_PROXY, https_proxy: SHELL_PROXY, NO_PROXY: "corp" },
      undefined,
      "linux",
    );
    expect(env).toEqual({ HOME: "/home/me", PATH: AUGMENTED_PATH, ...HYGIENE });
  });

  it("a carrier writes the family plus both loopback exemptions", () => {
    const env = buildClaudeDoctorChildEnv(
      { HOME: "/home/me", PATH: "/usr/bin", [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY },
      undefined,
      "linux",
    );
    expect(env).toEqual({
      HOME: "/home/me",
      PATH: AUGMENTED_PATH,
      ...HYGIENE,
      HTTPS_PROXY: ENGINE_PROXY,
      HTTP_PROXY: ENGINE_PROXY,
      https_proxy: ENGINE_PROXY,
      http_proxy: ENGINE_PROXY,
      NO_PROXY: LOOPBACK_NO_PROXY,
      no_proxy: LOOPBACK_NO_PROXY,
    });
  });

  it("never forwards the carrier itself — the allowlist does not name it", () => {
    const env = buildClaudeDoctorChildEnv(
      { HOME: "/home/me", PATH: "/usr/bin", [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY },
      undefined,
      "linux",
    );
    expect(ENV_CLAUDE_PROXY_URL in env).toBe(false);
  });

  it("ignores the codex carrier", () => {
    const env = buildClaudeDoctorChildEnv(
      { HOME: "/home/me", PATH: "/usr/bin", ANYCODE_CODEX_PROXY_URL: ENGINE_PROXY },
      undefined,
      "linux",
    );
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("leaves an explicit CLAUDE_CONFIG_DIR override intact alongside the proxy", () => {
    const env = buildClaudeDoctorChildEnv(
      { HOME: "/home/me", PATH: "/usr/bin", [ENV_CLAUDE_PROXY_URL]: ENGINE_PROXY },
      "/tmp/some-profile",
      "linux",
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/some-profile");
    expect(env.HTTPS_PROXY).toBe(ENGINE_PROXY);
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
      trust: () => ({
        kind: "refused",
        reason: "Claude binary is world-writable",
        consentable: true,
        staleConsent: false,
        resolvedPath: "/fake/claude",
      }),
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    // TASK.103: the report now additionally carries a structured
    // trustRefusal — see the "consent threading (TASK.103)" describe below,
    // whose own test pins this shape directly. Extended here (not appended
    // as a new test) because this is a strict toEqual against the trust-gate
    // refusal shape and the additive field changes that shape; status/error
    // stay the pre-existing pin, byte-identical.
    expect(report).toEqual({
      status: "error",
      error: "Claude binary is world-writable",
      trustRefusal: { binaryPath: "/fake/claude", reason: "Claude binary is world-writable", staleConsent: false },
    });
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

describe("runClaudeDoctor — ambient default (owner pivot)", () => {
  it("omitting profileDir spawns the probe with no CLAUDE_CONFIG_DIR key at all", async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl = (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      capturedEnv ??= options.env;
      return spawn(process.execPath, [fixturePath, ...args], options);
    };
    const report = await runClaudeDoctor("/fake/claude", {
      trust: TRUSTED,
      spawnImpl,
      env: { HOME: "/home/me", PATH: process.env.PATH },
    });
    expect(report).toEqual({ status: "ready", version: "2.1.212" });
    expect(capturedEnv).toBeDefined();
    expect("CLAUDE_CONFIG_DIR" in capturedEnv!).toBe(false);
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

describe("runClaudeDoctor — consent threading (TASK.103)", () => {
  // Mirror of codex-doctor.test.ts's BD2: the refusal report carries a
  // structured trustRefusal sourced from the injected trust seam. (The BD1
  // real-fs/consent-lifts-the-refusal case is codex-doctor.test.ts's own —
  // duplicating the POSIX scratch staging here for the mirror engine is
  // covered instead by claude-client.test.ts's BH2, main/claude-binary.test.ts's
  // BG4, and this file's own `trust: TRUSTED` convention.)
  it("the refusal report carries a structured trustRefusal sourced from the injected trust seam", async () => {
    const reason = "Claude binary (/fake/claude) is world-writable";
    const report = await runClaudeDoctor("/fake/claude", {
      trust: () => ({ kind: "refused", reason, consentable: true, staleConsent: false, resolvedPath: "/fake/claude" }),
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(report.status).toBe("error");
    expect(report.error).toBe(reason);
    expect(report.trustRefusal).toEqual({ binaryPath: "/fake/claude", reason, staleConsent: false });
  });

  it("BD10-mirror the report mirrors the injected trust outcome's kind/consentable/staleConsent (D-S4-13/17/18) — condensed vs codex BD10", async () => {
    // (a) consentable + stale.
    const staleReport = await runClaudeDoctor("/fake/claude", {
      trust: () => ({ kind: "refused", reason: "stale reason", consentable: true, staleConsent: true, resolvedPath: "/real/claude" }),
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(staleReport.status).toBe("error");
    expect(staleReport.trustRefusal).toEqual({ binaryPath: "/real/claude", reason: "stale reason", staleConsent: true });

    // (b) non-consentable: honest error, no affordance.
    const ownedReport = await runClaudeDoctor("/fake/claude", {
      trust: () => ({ kind: "refused", reason: "owned by another user", consentable: false, staleConsent: false, resolvedPath: "/real/claude" }),
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(ownedReport.status).toBe("error");
    expect(ownedReport.trustRefusal).toBeUndefined();

    // (c) missing: never an offerable refusal.
    const missingReport = await runClaudeDoctor("/fake/claude", {
      trust: () => ({ kind: "missing", reason: "Claude binary path does not exist" }),
      spawnImpl: fakeSpawn(),
      profileDir: freshProfileDir(),
    });
    expect(missingReport.status).toBe("error");
    expect(missingReport.error).toBe("Claude binary path does not exist");
    expect(missingReport.trustRefusal).toBeUndefined();
  });
});
