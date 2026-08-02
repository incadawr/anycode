/**
 * Unit tests for md-doc-ipc.ts (TASK.99 CUT.md CONTRACTS, M1): mirrors
 * panel-ipc.test.ts's own pattern — `electron`'s `ipcMain` is mocked with a
 * handler-capturing fake (no Electron runtime under vitest), zod-refusal
 * shapes are tested against a stubbed `MdDocDeps` (fast, isolates this
 * module's own boundary logic from `readMdDoc`'s).
 */
import { describe, expect, it, vi } from "vitest";

const { mockHandlers } = vi.hoisted(() => ({
  mockHandlers: new Map<string, (event: unknown, raw: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown): void => {
      mockHandlers.set(channel, listener);
    },
  },
}));

import { MD_PREVIEW_READ_CHANNEL } from "../../shared/md-preview.js";
import { registerMdDocIpc } from "./md-doc-ipc.js";
import type { MdDocDeps } from "./md-doc.js";

function fakeDeps(overrides: Partial<MdDocDeps> = {}): MdDocDeps {
  return {
    getRecordRef: vi.fn(() => undefined),
    resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })),
    stat: vi.fn(async () => ({ size: 0, isFile: true, mtimeMs: 0 })),
    readFileNoFollow: vi.fn(async () => Buffer.from("")),
    ...overrides,
  };
}

function register(deps: MdDocDeps): { invoke: (channel: string, raw: unknown) => unknown } {
  mockHandlers.clear();
  registerMdDocIpc(deps);
  return { invoke: (channel, raw) => mockHandlers.get(channel)?.({}, raw) };
}

describe("registerMdDocIpc — MD_PREVIEW_READ", () => {
  it("is registered", () => {
    register(fakeDeps());
    expect(mockHandlers.has(MD_PREVIEW_READ_CHANNEL)).toBe(true);
  });

  it("valid payload calls getRecordRef with tabId/previewId and forwards a successful read verbatim", async () => {
    const getRecordRef = vi.fn(() => ({ sourcePath: "doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 }));
    const resolveArtifact = vi.fn(async () => ({ realPath: "/workspace/doc.md" }));
    const stat = vi.fn(async () => ({ size: 5, isFile: true, mtimeMs: 123 }));
    const readFileNoFollow = vi.fn(async () => Buffer.from("hello"));
    const { invoke } = register(fakeDeps({ getRecordRef, resolveArtifact, stat, readFileNoFollow }));

    const response = await invoke(MD_PREVIEW_READ_CHANNEL, { tabId: "tab-a", previewId: "p1" });
    expect(getRecordRef).toHaveBeenCalledWith("tab-a", "p1");
    expect(response).toEqual({
      ok: true,
      doc: {
        previewId: "p1",
        sourcePath: "doc.md",
        realSourcePath: "/workspace/doc.md",
        docDir: "/workspace",
        sourceText: "hello",
        sizeBytes: 5,
        mtimeMs: 123,
        docVersion: 0,
      },
    });
  });

  it("forwards an honest refusal verbatim (no_preview when getRecordRef finds nothing)", async () => {
    const { invoke } = register(fakeDeps({ getRecordRef: vi.fn(() => undefined) }));
    const response = await invoke(MD_PREVIEW_READ_CHANNEL, { tabId: "tab-a", previewId: "p1" });
    expect(response).toEqual({ ok: false, reason: "no_preview" });
  });

  it("malformed payload (missing previewId) refuses no_preview without calling getRecordRef", async () => {
    const getRecordRef = vi.fn();
    const { invoke } = register(fakeDeps({ getRecordRef }));
    const response = await invoke(MD_PREVIEW_READ_CHANNEL, { tabId: "tab-a" });
    expect(getRecordRef).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, reason: "no_preview" });
  });

  it("malformed payload (wrong type) refuses no_preview without calling getRecordRef", async () => {
    const getRecordRef = vi.fn();
    const { invoke } = register(fakeDeps({ getRecordRef }));
    const response = await invoke(MD_PREVIEW_READ_CHANNEL, { tabId: 123, previewId: "p1" });
    expect(getRecordRef).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, reason: "no_preview" });
  });

  it("non-object payload refuses no_preview without calling getRecordRef", async () => {
    const getRecordRef = vi.fn();
    const { invoke } = register(fakeDeps({ getRecordRef }));
    const response = await invoke(MD_PREVIEW_READ_CHANNEL, "not-an-object");
    expect(getRecordRef).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, reason: "no_preview" });
  });
});
