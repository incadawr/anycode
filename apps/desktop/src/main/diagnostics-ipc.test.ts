import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsIpcSession,
  diagnosticsDefaultFileName,
  handleDiagnosticsPreview,
  handleDiagnosticsSave,
  type DiagnosticsIpcDeps,
} from "./diagnostics-ipc.js";
import type { DiagnosticsBuild } from "./diagnostics-export.js";

const NOW = Date.UTC(2026, 9, 30, 12, 34, 56);

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
    const result = await handleDiagnosticsPreview(deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.redactions).toBe(3);
    expect(result.preview).toContain("anycode-diagnostics");
  });

  it("collapses a build failure to a closed reason", async () => {
    const result = await handleDiagnosticsPreview(
      deps({
        build: async () => {
          throw new Error("/Users/tester/.anycode/telemetry: EACCES sk-live-secret");
        },
      }),
    );
    expect(result).toEqual({ ok: false, reason: "build_failed" });
  });

  it("refuses to save a bundle at or above the 5 MB ceiling", async () => {
    const oversized = "x".repeat(5 * 1024 * 1024);
    const save = vi.fn(async () => ({ saved: true }));
    const result = await handleDiagnosticsSave(deps({ build: async () => build({ json: oversized }), save }));
    expect(result).toEqual({ ok: false, reason: "too_large" });
    expect(save).not.toHaveBeenCalled();
  });

  it("reports a canceled save without inventing a path", async () => {
    const result = await handleDiagnosticsSave(deps({ save: async () => ({ saved: false }) }));
    expect(result).toEqual({ ok: true, saved: false });
  });

  it("passes the anonymised content and a user-safe default name to the saver", async () => {
    const save = vi.fn(async (_payload: { defaultFileName: string; content: string }) => ({
      saved: true,
      path: "/tmp/out.json",
    }));
    const result = await handleDiagnosticsSave(deps({ save }));
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
    );
    expect(result).toEqual({ ok: false, reason: "write_failed" });
  });

  it("builds the default file name from UTC time only", () => {
    expect(diagnosticsDefaultFileName(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe("anycode-diagnostics-20260102-030405.json");
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
    await session.preview();
    await session.save();
    expect(builds).toBe(1);
    expect(save.mock.calls[0]![0].content).toContain("\"build\":1");
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
    await session.preview();
    clock += 101;
    await session.save();
    expect(builds).toBe(2);
    expect(save.mock.calls[0]![0].content).toContain("\"build\":2");
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
    expect((await session.preview()).ok).toBe(false);
    expect((await session.save()).ok).toBe(true);
    expect(builds).toBe(2);
  });
});
