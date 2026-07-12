/**
 * Diagnostics-after-edit wrapper guards (Phase 6 slice 6.1, design §2-C4/§6#6a).

 * the inner tool), delegation byte-equivalence of the inner path (success and
 * !ok/error paths), the fail-soft matrix (no port / unavailable outcome / read
 * error / abort => inner result untouched, no field), the additive-field paths
 * (findings vs "none reported"), and formatDiagnostics sort/cap/code rendering.
 */

import { describe, expect, it, vi } from "vitest";
import { diagnosticsEditTool, diagnosticsWriteTool, formatDiagnostics } from "./diagnostics.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { DiagnosticsOutcome, FileDiagnostic, LspPort } from "../ports/lsp.js";
import { LSP_DIAGNOSTICS_MAX_ITEMS } from "../types/config.js";

// ---------------------------------------------------------------------------
// In-memory fs + stub LspPort

interface FakeFsOptions {
  /** Force readFile to throw (used to exercise the re-read fail-soft path). */
  failReadFile?: boolean;
}

function makeFs(
  initial: Record<string, string> = {},
  options: FakeFsOptions = {},
): FileSystemPort {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    readFile: async (path: string) => {
      if (options.failReadFile) throw new Error("read failed");
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    stat: async () => {
      throw new Error("not implemented");
    },
    exists: async (path: string) => files.has(path),
    mkdir: async () => {},
    readdir: async () => [],
  };
}

function makeLsp(
  outcome: DiagnosticsOutcome,
  record?: (path: string, content: string) => void,
): LspPort {
  return {
    diagnosticsAfterWrite: async (filePath, content) => {
      record?.(filePath, content);
      return outcome;
    },
    status: () => [],
    disposeAll: async () => {},
  };
}

function ctxFor(fs: FileSystemPort, overrides?: Partial<ToolContext>): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: { fs } as unknown as CorePorts,
    ...overrides,
  };
}

const withFindings: DiagnosticsOutcome = {
  available: true,
  diagnostics: [
    { severity: "error", line: 3, column: 5, message: "Type mismatch", code: "TS2322" },
  ],
};
const clean: DiagnosticsOutcome = { available: true, diagnostics: [] };
const unavailable: DiagnosticsOutcome = { available: false, reason: "no_server" };

// ---------------------------------------------------------------------------

describe("diagnostics wrappers — permission identity (R5 / §6#6a)", () => {
  it("carry the SAME metadata OBJECT as their inner tools (byte-identical permission path)", () => {
    // Reference identity, not structural equality: the permission engine, broker,
    // hooks and toolNames snapshot all see the exact inner "Edit"/"Write" profile.
    expect(diagnosticsEditTool.metadata).toBe(editTool.metadata);
    expect(diagnosticsWriteTool.metadata).toBe(writeTool.metadata);
    expect(diagnosticsEditTool.metadata.name).toBe("Edit");
    expect(diagnosticsWriteTool.metadata.name).toBe("Write");
  });

  it("reuse the inner input schema (input surface untouched)", () => {
    expect(diagnosticsEditTool.inputSchema).toBe(editTool.inputSchema);
    expect(diagnosticsWriteTool.inputSchema).toBe(writeTool.inputSchema);
  });
});

describe("diagnostics wrappers — delegation equivalence (no LspPort)", () => {
  it("Edit: byte-identical to editTool on a successful edit when no lsp is present", async () => {
    const wrapped = await diagnosticsEditTool.handler(
      { file_path: "/work/a.ts", old_string: "foo", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo baz" })),
    );
    const inner = await editTool.handler(
      { file_path: "/work/a.ts", old_string: "foo", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo baz" })),
    );
    expect(wrapped).toEqual(inner);
    expect((wrapped.output as { diagnostics?: string }).diagnostics).toBeUndefined();
  });

  it("Edit: byte-identical to editTool on an error path (old_string not found)", async () => {
    const wrapped = await diagnosticsEditTool.handler(
      { file_path: "/work/a.ts", old_string: "missing", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo baz" })),
    );
    const inner = await editTool.handler(
      { file_path: "/work/a.ts", old_string: "missing", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo baz" })),
    );
    expect(wrapped).toEqual(inner);
    expect(wrapped.ok).toBe(false);
  });

  it("Write: byte-identical to writeTool on a successful write when no lsp is present", async () => {
    const wrapped = await diagnosticsWriteTool.handler(
      { file_path: "/work/new.ts", content: "hello" },
      ctxFor(makeFs()),
    );
    const inner = await writeTool.handler(
      { file_path: "/work/new.ts", content: "hello" },
      ctxFor(makeFs()),
    );
    expect(wrapped).toEqual(inner);
  });
});

describe("diagnostics wrappers — fail-soft matrix (R6)", () => {
  it("attaches NO field and never queries the server when the inner call fails", async () => {
    const spy = vi.fn(async (): Promise<DiagnosticsOutcome> => withFindings);
    const lsp: LspPort = { diagnosticsAfterWrite: spy, status: () => [], disposeAll: async () => {} };
    const res = await diagnosticsEditTool.handler(
      { file_path: "/work/a.ts", old_string: "missing", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo" }), { lsp }),
    );
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT query the server and attaches no field when the turn is already aborted", async () => {
    const spy = vi.fn(async (): Promise<DiagnosticsOutcome> => withFindings);
    const lsp: LspPort = { diagnosticsAfterWrite: spy, status: () => [], disposeAll: async () => {} };
    const aborted = new AbortController();
    aborted.abort();
    const res = await diagnosticsWriteTool.handler(
      { file_path: "/work/n.ts", content: "hello" },
      ctxFor(makeFs(), { lsp, abortSignal: aborted.signal }),
    );
    // Inner write still happened (ok:true), but no diagnostics augmentation.
    expect(res.ok).toBe(true);
    expect((res.output as { diagnostics?: string }).diagnostics).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("attaches NO field on an unavailable outcome (result stays byte-identical to today)", async () => {
    const res = await diagnosticsWriteTool.handler(
      { file_path: "/work/n.ts", content: "hello" },
      ctxFor(makeFs(), { lsp: makeLsp(unavailable) }),
    );
    const inner = await writeTool.handler(
      { file_path: "/work/n.ts", content: "hello" },
      ctxFor(makeFs()),
    );
    expect(res).toEqual(inner);
    expect((res.output as { diagnostics?: string }).diagnostics).toBeUndefined();
  });

  it("swallows a re-read error and returns the inner result unchanged", async () => {
    // Write succeeds (exists/writeFile), but the wrapper's re-read throws.
    const spy = vi.fn(async (): Promise<DiagnosticsOutcome> => withFindings);
    const lsp: LspPort = { diagnosticsAfterWrite: spy, status: () => [], disposeAll: async () => {} };
    const res = await diagnosticsWriteTool.handler(
      { file_path: "/work/n.ts", content: "hello" },
      ctxFor(makeFs({}, { failReadFile: true }), { lsp }),
    );
    expect(res.ok).toBe(true);
    expect((res.output as { diagnostics?: string }).diagnostics).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("diagnostics wrappers — additive field (R6)", () => {
  it("attaches formatted diagnostics on an available outcome with findings", async () => {
    let seenPath: string | undefined;
    let seenContent: string | undefined;
    const lsp = makeLsp(withFindings, (p, c) => {
      seenPath = p;
      seenContent = c;
    });
    const res = await diagnosticsEditTool.handler(
      { file_path: "/work/a.ts", old_string: "foo", new_string: "bar", replace_all: false },
      ctxFor(makeFs({ "/work/a.ts": "foo baz" }), { lsp }),
    );
    expect(res.ok).toBe(true);
    // Inner output preserved (Edit reports replacements) + additive diagnostics.
    expect(res.output).toEqual({
      replacements: 1,
      diagnostics: "3:5 error: Type mismatch [TS2322]",
    });
    // Re-read passes the POST-EDIT content and the edited path to the server.
    expect(seenPath).toBe("/work/a.ts");
    expect(seenContent).toBe("bar baz");
  });

  it("attaches 'none reported' on an available outcome with zero findings", async () => {
    const res = await diagnosticsWriteTool.handler(
      { file_path: "/work/n.ts", content: "clean file" },
      ctxFor(makeFs(), { lsp: makeLsp(clean) }),
    );
    expect(res.ok).toBe(true);
    expect((res.output as { diagnostics?: string }).diagnostics).toBe("none reported");
  });
});

// ---------------------------------------------------------------------------

describe("formatDiagnostics", () => {
  it("sorts error -> warning -> info -> hint", () => {
    const diags: FileDiagnostic[] = [
      { severity: "hint", line: 1, column: 1, message: "h" },
      { severity: "error", line: 2, column: 2, message: "e" },
      { severity: "info", line: 3, column: 3, message: "i" },
      { severity: "warning", line: 4, column: 4, message: "w" },
    ];
    expect(formatDiagnostics(diags)).toBe(
      ["2:2 error: e", "4:4 warning: w", "3:3 info: i", "1:1 hint: h"].join("\n"),
    );
  });

  it("appends an optional [code] only when present", () => {
    const diags: FileDiagnostic[] = [
      { severity: "error", line: 1, column: 1, message: "coded", code: "E01" },
      { severity: "error", line: 2, column: 2, message: "bare" },
    ];
    expect(formatDiagnostics(diags)).toBe("1:1 error: coded [E01]\n2:2 error: bare");
  });

  it("caps at LSP_DIAGNOSTICS_MAX_ITEMS with a trailing overflow line", () => {
    const diags: FileDiagnostic[] = Array.from({ length: LSP_DIAGNOSTICS_MAX_ITEMS + 5 }, (_, i) => ({
      severity: "error" as const,
      line: i + 1,
      column: 1,
      message: `m${i}`,
    }));
    const lines = formatDiagnostics(diags).split("\n");
    expect(lines).toHaveLength(LSP_DIAGNOSTICS_MAX_ITEMS + 1);
    expect(lines[LSP_DIAGNOSTICS_MAX_ITEMS]).toBe("… and 5 more");
  });
});
