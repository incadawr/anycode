import { describe, expect, it, vi } from "vitest";
import { buildClaudeLoginScript, runClaudeLogin, type ClaudeLoginFs, type RunClaudeLoginOptions } from "./claude-login.js";

/** The real fs trust gate has nothing to stat in these tests (see claude-doctor.test.ts's own precedent). */
const TRUSTED = (): null => null;
const UNTRUSTED = (): string => "Claude binary path is not trusted";

function fakeFs(): { fs: ClaudeLoginFs; calls: { mkdir: unknown[]; writeFile: Array<{ path: string; data: string; options: { mode: number } }>; unlink: Array<{ path: string }> } } {
  const calls: { mkdir: unknown[]; writeFile: Array<{ path: string; data: string; options: { mode: number } }>; unlink: Array<{ path: string }> } = {
    mkdir: [],
    writeFile: [],
    unlink: [],
  };
  const fs: ClaudeLoginFs = {
    mkdir: (path, options) => {
      calls.mkdir.push({ path, options });
    },
    writeFile: (path, data, options) => {
      calls.writeFile.push({ path, data, options });
    },
    unlink: (path) => {
      calls.unlink.push({ path });
    },
  };
  return { fs, calls };
}

function baseOptions(overrides: Partial<RunClaudeLoginOptions> = {}): RunClaudeLoginOptions {
  return {
    profileDir: "/Users/x/.anycode/claude/profile-default",
    openPath: async () => "",
    probe: async () => true,
    trust: TRUSTED,
    fsImpl: fakeFs().fs,
    platform: "darwin",
    pollIntervalMs: 5,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("buildClaudeLoginScript", () => {
  it("login-arg mode: exact export + exec claude auth login + the unset triple, no token-shaped string (P0 verdict: real command is `auth login`, not `/login`)", () => {
    const script = buildClaudeLoginScript("/opt/claude/claude", "/Users/x/.anycode/claude/profile-default", "login-arg");
    expect(script).toContain("unset ANTHROPIC_API_KEY");
    expect(script).toContain("unset ANTHROPIC_AUTH_TOKEN");
    expect(script).toContain("unset CLAUDECODE");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/Users/x/.anycode/claude/profile-default'");
    expect(script).toContain("exec '/opt/claude/claude' auth login");
    expect(script).not.toMatch(/sk-ant|Bearer |CLAUDE_CODE_OAUTH_TOKEN|setup-token/i);
  });

  it("plain mode: bare exec, no argv (soft-degradation seam, cut §1)", () => {
    const script = buildClaudeLoginScript("/opt/claude/claude", "/tmp/profile", "plain");
    expect(script).toContain("exec '/opt/claude/claude'");
    expect(script).not.toContain("auth login");
  });

  it("defaults to login-arg mode when no mode is given", () => {
    expect(buildClaudeLoginScript("/opt/claude/claude", "/tmp/profile")).toContain("auth login");
  });

  it("quotes a path containing a single quote safely", () => {
    const script = buildClaudeLoginScript("/opt/cla'ude/claude", "/tmp/profile", "login-arg");
    expect(script).toContain("'/opt/cla'\\''ude/claude'");
  });

  it("ambient default (owner pivot): no profileDir override -> no CLAUDE_CONFIG_DIR export at all, plain `claude auth login`", () => {
    const script = buildClaudeLoginScript("/opt/claude/claude", undefined, "login-arg");
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
    expect(script).toContain("exec '/opt/claude/claude' auth login");
  });
});

describe("runClaudeLogin — script plumbing", () => {
  it("writes the exact buildClaudeLoginScript output, mode 0700, into the given tmpDir, after mkdir'ing the profile dir 0700", async () => {
    const { fs, calls } = fakeFs();
    await runClaudeLogin(
      "/opt/claude/claude",
      baseOptions({ fsImpl: fs, tmpDir: "/tmp/fake-tmp", profileDir: "/Users/x/.anycode/claude/profile-default" }),
    );
    expect(calls.mkdir).toEqual([{ path: "/Users/x/.anycode/claude/profile-default", options: { recursive: true, mode: 0o700 } }]);
    expect(calls.writeFile).toHaveLength(1);
    expect(calls.writeFile[0]!.path.startsWith("/tmp/fake-tmp/")).toBe(true);
    expect(calls.writeFile[0]!.options).toEqual({ mode: 0o700 });
    expect(calls.writeFile[0]!.data).toBe(buildClaudeLoginScript("/opt/claude/claude", "/Users/x/.anycode/claude/profile-default", "login-arg"));
  });

  it("never returns anything beyond ok/reason — no field could ever carry token/account material", async () => {
    const outcome = await runClaudeLogin("/fake/claude", baseOptions());
    expect(Object.keys(outcome)).toEqual(["ok"]);
  });

  it("ambient default (owner pivot): omitting profileDir never mkdir's anything, and the written script carries no CLAUDE_CONFIG_DIR", async () => {
    const { fs, calls } = fakeFs();
    await runClaudeLogin(
      "/opt/claude/claude",
      baseOptions({ fsImpl: fs, tmpDir: "/tmp/fake-tmp", profileDir: undefined }),
    );
    expect(calls.mkdir).toEqual([]);
    expect(calls.writeFile).toHaveLength(1);
    expect(calls.writeFile[0]!.data).not.toContain("CLAUDE_CONFIG_DIR");
    expect(calls.writeFile[0]!.data).toBe(buildClaudeLoginScript("/opt/claude/claude", undefined, "login-arg"));
  });
});

describe("runClaudeLogin — trust / entrance gates", () => {
  it("trust-fail produces no file and never calls openPath", async () => {
    const openPath = vi.fn(async () => "");
    const { fs, calls } = fakeFs();
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ trust: UNTRUSTED, openPath, fsImpl: fs }));
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(openPath).not.toHaveBeenCalled();
    expect(calls.mkdir).toHaveLength(0);
    expect(calls.writeFile).toHaveLength(0);
  });

  it("pre-aborted signal produces no file and never calls openPath", async () => {
    const controller = new AbortController();
    controller.abort();
    const openPath = vi.fn(async () => "");
    const { fs, calls } = fakeFs();
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ openPath, fsImpl: fs, signal: controller.signal }));
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(openPath).not.toHaveBeenCalled();
    expect(calls.mkdir).toHaveLength(0);
    expect(calls.writeFile).toHaveLength(0);
  });

  it("non-darwin -> unsupported, with zero side effects (win/linux are future work, cut §5)", async () => {
    const trust = vi.fn(() => null);
    const openPath = vi.fn(async () => "");
    const { fs, calls } = fakeFs();
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ trust, openPath, fsImpl: fs, platform: "linux" }));
    expect(outcome).toEqual({ ok: false, reason: "unsupported" });
    expect(trust).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(calls.mkdir).toHaveLength(0);
  });
});

describe("runClaudeLogin — openPath failure", () => {
  it("a non-empty openPath result (Electron's own failure contract) -> failed, and never begins polling", async () => {
    const probe = vi.fn(async () => true);
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ openPath: async () => "Could not open path", probe }));
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("runClaudeLogin — polling", () => {
  it("resolves ok once probe reports ready, after polling through not-ready responses (fake probe: signed_out x2 -> ready)", async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls += 1;
      return calls >= 3;
    });
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ probe }));
    expect(outcome).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("times out when probe never reports ready, with a BOUNDED number of polls", async () => {
    const probe = vi.fn(async () => false);
    const outcome = await runClaudeLogin("/fake/claude", baseOptions({ probe, pollIntervalMs: 10, timeoutMs: 60 }));
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(probe.mock.calls.length).toBeLessThan(20);
  });

  it("cancels via the abort signal, without waiting for the full timeout, and stops polling", async () => {
    const controller = new AbortController();
    const probe = vi.fn(async () => false);
    const start = Date.now();
    setTimeout(() => controller.abort(), 20);
    const outcome = await runClaudeLogin(
      "/fake/claude",
      baseOptions({ probe, signal: controller.signal, pollIntervalMs: 10_000, timeoutMs: 30_000 }),
    );
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("runClaudeLogin — unlinks the script file on every exit path once it has been written", () => {
  it.each([
    ["success", async (): Promise<string> => "", async (): Promise<boolean> => true, { ok: true }] as const,
    ["openPath failure", async (): Promise<string> => "boom", async (): Promise<boolean> => true, { ok: false, reason: "failed" }] as const,
    ["timeout", async (): Promise<string> => "", async (): Promise<boolean> => false, { ok: false, reason: "timeout" }] as const,
  ])("%s", async (_label, openPath, probeImpl, expected) => {
    const { fs, calls } = fakeFs();
    const outcome = await runClaudeLogin(
      "/fake/claude",
      baseOptions({ openPath, probe: probeImpl, fsImpl: fs, pollIntervalMs: 5, timeoutMs: 20 }),
    );
    expect(outcome).toEqual(expected);
    expect(calls.unlink).toHaveLength(1);
    expect(calls.unlink[0]!.path).toBe(calls.writeFile[0]!.path);
  });
});
