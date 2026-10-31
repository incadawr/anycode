import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsIpcSession,
  diagnosticsDefaultFileName,
  handleDiagnosticsPreview,
  handleDiagnosticsSave,
  writeDiagnosticsFile,
  DIAGNOSTICS_FILE_MODE,
  type DiagnosticsIpcDeps,
  type DiagnosticsSaveFs,
} from "./diagnostics-ipc.js";
import type { DiagnosticsBuild } from "./diagnostics-export.js";

const NOW = Date.UTC(2026, 9, 30, 12, 34, 56);
const REQUEST = { sessionId: "sess_root_0001" };

function build(overrides?: Partial<DiagnosticsBuild>): DiagnosticsBuild {
  return {
    bundle: {} as DiagnosticsBuild["bundle"],
    json: JSON.stringify({ format: "anycode-diagnostics", telemetry: { sessions: [] } }),
    summary: {
      generatedAt: "2026-10-30T12:34:56.000Z",
      bytes: 64,
      sections: [{ name: "telemetry", records: 0, bytes: 2 }],
      truncated: false,
      redactions: 3,
    },
    ...overrides,
  };
}

function deps(overrides?: Partial<DiagnosticsIpcDeps>): DiagnosticsIpcDeps {
  return {
    build: async () => build(),
    save: vi.fn(async () => ({ saved: true, path: "/tmp/anycode-diagnostics-target.json" })),
    now: () => NOW,
    ...overrides,
  };
}

describe("diagnostics IPC (GitHub #18)", () => {
  it("returns the already-anonymised preview and size summary", async () => {
    const result = await handleDiagnosticsPreview(deps(), REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.redactions).toBe(3);
    expect(result.preview).toContain("anycode-diagnostics");
  });

  it("refuses a missing, malformed or path-shaped session id without building", async () => {
    const buildSpy = vi.fn(async () => build());
    const bad: unknown[] = [
      undefined,
      null,
      "sess_root",
      {},
      { sessionId: "" },
      { sessionId: "  sess_root" },
      { sessionId: "../../etc/passwd" },
      { sessionId: "/Users/tester/.anycode/telemetry" },
      { sessionId: "sess_root\nother" },
      { sessionId: "a".repeat(400) },
    ];
    for (const raw of bad) {
      await expect(handleDiagnosticsPreview(deps({ build: buildSpy }), raw)).resolves.toEqual({
        ok: false,
        reason: "invalid_request",
      });
    }
    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("collapses a build failure to a closed reason", async () => {
    const result = await handleDiagnosticsPreview(
      deps({
        build: async () => {
          throw new Error("/Users/tester/.anycode/telemetry: EACCES sk-live-secret");
        },
      }),
      REQUEST,
    );
    expect(result).toEqual({ ok: false, reason: "build_failed" });
  });

  it("refuses to save a bundle at or above the 5 MB ceiling", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024);
    const save = vi.fn(async () => ({ saved: true }));
    const result = await handleDiagnosticsSave(deps({ build: async () => build({ json: oversized }), save }), REQUEST);
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(save).not.toHaveBeenCalled();
  });

  it("reports a canceled save without inventing a path", async () => {
    const result = await handleDiagnosticsSave(deps({ save: async () => ({ saved: false }) }), REQUEST);
    expect(result).toEqual({ ok: true, saved: false });
  });

  it("passes the anonymised content and a user-safe default name to the saver", async () => {
    const save = vi.fn(async (_payload: { defaultFileName: string; content: string }) => ({
      saved: true,
      path: "/tmp/out.json",
    }));
    const result = await handleDiagnosticsSave(deps({ save }), REQUEST);
    expect(save).toHaveBeenCalledTimes(1);
    const payload = save.mock.calls[0]![0];
    expect(payload.defaultFileName).toBe("anycode-diagnostics-20261030-123456.json");
    expect(payload.content).toContain("anycode-diagnostics");
    expect(payload.content).not.toContain("/Users/");
    expect(result).toEqual({ ok: true, saved: true, path: "/tmp/out.json" });
  });

  it("collapses a write failure to a closed reason", async () => {
    const result = await handleDiagnosticsSave(
      deps({
        save: async () => {
          throw new Error("EACCES /Users/tester/Desktop");
        },
      }),
      REQUEST,
    );
    expect(result).toEqual({ ok: false, reason: "write_failed" });
  });

  it("builds the default file name from UTC time only", () => {
    expect(diagnosticsDefaultFileName(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("anycode-diagnostics-20260102-030405.json");
  });
});

describe("diagnostics save file mode (GitHub #18)", () => {
  function saveFs(): { fs: DiagnosticsSaveFs & { writeMode?: number; chmodMode?: number }; calls: string[] } {
    const calls: string[] = [];
    const recorder: DiagnosticsSaveFs & { writeMode?: number; chmodMode?: number } = {
      writeFile: async (path, content, options) => {
        calls.push(`write:${path}:${options.encoding}:${options.mode}`);
        recorder.writeMode = options.mode;
      },
      chmod: async (path, mode) => {
        calls.push(`chmod:${path}:${mode}`);
        recorder.chmodMode = mode;
      },
    };
    return { fs: recorder, calls };
  }

  it("writes 0600 and then forces 0600 again, because an existing file keeps its old mode", async () => {
    const { fs, calls } = saveFs();
    await writeDiagnosticsFile(fs, "/tmp/anycode-diagnostics.json", "{}");
    expect(fs.writeMode).toBe(DIAGNOSTICS_FILE_MODE);
    expect(fs.chmodMode).toBe(0o600);
    expect(calls).toEqual([
      "write:/tmp/anycode-diagnostics.json:utf8:384",
      "chmod:/tmp/anycode-diagnostics.json:384",
    ]);
  });

  it("surfaces a chmod failure to the caller (the save reports write_failed)", async () => {
    const fs: DiagnosticsSaveFs = {
      writeFile: async () => {},
      chmod: async () => {
        throw new Error("EPERM");
      },
    };
    await expect(writeDiagnosticsFile(fs, "/tmp/x.json", "{}")).rejects.toThrow("EPERM");
    const result = await handleDiagnosticsSave(
      deps({
        save: async () => {
          await writeDiagnosticsFile(fs, "/tmp/x.json", "{}");
          return { saved: true };
        },
      }),
      REQUEST,
    );
    expect(result).toEqual({ ok: false, reason: "write_failed" });
  });
});

describe("diagnostics preview -> save session (GitHub #18)", () => {
  it("writes exactly the bundle that was previewed, not a fresh build", async () => {
    let builds = 0;
    const save = vi.fn(async (_payload: { defaultFileName: string; content: string }) => ({ saved: true }));
    const session = createDiagnosticsIpcSession({
      build: async () => {
        builds += 1;
        return build({ json: JSON.stringify({ format: "anycode-diagnostics", build: builds }) });
      },
      save,
    });
    await session.preview(REQUEST);
    await session.save(REQUEST);
    expect(builds).toBe(1);
    expect(save.mock.calls[0]![0].content).toContain('"build":1');
  });

  it("rebuilds when the preview cache has expired", async () => {
    let builds = 0;
    let clock = 1_000;
    const save = vi.fn(async (_payload: { defaultFileName: string; content: string }) => ({ saved: true }));
    const session = createDiagnosticsIpcSession(
      {
        build: async () => {
          builds += 1;
          return build({ json: JSON.stringify({ format: "anycode-diagnostics", build: builds }) });
        },
        save,
        now: () => clock,
      },
      { ttlMs: 100, now: () => clock },
    );
    await session.preview(REQUEST);
    clock += 101;
    await session.save(REQUEST);
    expect(builds).toBe(2);
    expect(save.mock.calls[0]![0].content).toContain('"build":2');
  });

  it("never writes a preview of one session under another session's request", async () => {
    const built: string[] = [];
    const save = vi.fn(async (_payload: { defaultFileName: string; content: string }) => ({ saved: true }));
    const session = createDiagnosticsIpcSession({
      build: async (sessionId) => {
        built.push(sessionId);
        return build({ json: JSON.stringify({ format: "anycode-diagnostics", sessionId }) });
      },
      save,
    });
    await session.preview({ sessionId: "sess_a" });
    await session.save({ sessionId: "sess_b" });
    expect(built).toEqual(["sess_a", "sess_b"]);
    expect(save.mock.calls[0]![0].content).toContain('"sessionId":"sess_b"');
  });

  it("drops a failed preview and rebuilds on save", async () => {
    let builds = 0;
    const session = createDiagnosticsIpcSession({
      build: async () => {
        builds += 1;
        if (builds === 1) throw new Error("boom");
        return build();
      },
      save: async () => ({ saved: true }),
    });
    expect((await session.preview(REQUEST)).ok).toBe(false);
    expect((await session.save(REQUEST)).ok).toBe(true);
    expect(builds).toBe(2);
  });
});
