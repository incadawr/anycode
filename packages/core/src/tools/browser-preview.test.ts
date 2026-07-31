import { describe, expect, it, vi } from "vitest";
import {
  browserOpenInputSchema,
  browserOpenTool,
  browserReadInputSchema,
  browserReadTool,
} from "./browser-preview.js";
import type { ToolContext } from "../types/tools.js";
import type {
  PreviewOpenSuccess,
  PreviewPort,
  PreviewReadSuccess,
} from "../ports/preview.js";

function context(preview?: PreviewPort): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/repo",
    ports: {},
    preview,
  } as ToolContext;
}

const openSuccess: PreviewOpenSuccess = {
  previewId: "preview-1",
  url: "file:///repo/index.html",
  kind: "file",
};

const readSuccess: PreviewReadSuccess = {
  previewId: "preview-1",
  url: "file:///repo/index.html",
  text: "hello world",
};

describe("BrowserOpen", () => {
  it("fails closed without a preview port", async () => {
    const result = await browserOpenTool.handler({ path: "/repo/index.html" }, context());
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toBe("Browser preview is unavailable in this session.");
  });

  it("rejects neither path nor url, and rejects both together (exactly-one-of)", () => {
    expect(browserOpenInputSchema.safeParse({}).success).toBe(false);
    expect(
      browserOpenInputSchema.safeParse({ path: "/a.html", url: "http://localhost:3000" }).success,
    ).toBe(false);
    expect(browserOpenInputSchema.safeParse({ path: "/a.html" }).success).toBe(true);
    expect(browserOpenInputSchema.safeParse({ url: "http://localhost:3000" }).success).toBe(true);
  });

  it("declares the frozen §2.2 metadata literal", () => {
    expect(browserOpenTool.metadata).toMatchObject({
      name: "BrowserOpen",
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      riskLevel: "low",
      sideEffectScope: "process",
      needsApproval: false,
      timeoutMs: 30_000,
    });
  });

  describe("resolveMetadata (security invariant owned by this slice)", () => {
    it("a remote non-localhost http(s) url escalates to high-risk/network/needsApproval", () => {
      const resolved = browserOpenTool.resolveMetadata?.({ url: "https://example.com/app" } as never);
      expect(resolved).toMatchObject({
        riskLevel: "high",
        sideEffectScope: "network",
        needsApproval: true,
      });
    });

    it("localhost/127.0.0.1/[::1] urls do NOT escalate", () => {
      for (const url of [
        "http://localhost:3000",
        "https://127.0.0.1:8080/",
        "http://[::1]:9000",
      ]) {
        const resolved = browserOpenTool.resolveMetadata?.({ url } as never);
        expect(resolved).toMatchObject({ riskLevel: "low", sideEffectScope: "process", needsApproval: false });
      }
    });

    it("a path (no url) does not escalate", () => {
      const resolved = browserOpenTool.resolveMetadata?.({ path: "/repo/index.html" } as never);
      expect(resolved).toMatchObject({ riskLevel: "low", needsApproval: false });
    });

    it("an http(s)-looking but unparseable url fails toward the safer (approval-required) branch", () => {
      const resolved = browserOpenTool.resolveMetadata?.({ url: "https://" } as never);
      expect(resolved).toMatchObject({ riskLevel: "high", needsApproval: true });
    });
  });

  it("passes allowRemote:true to the port ONLY for a remote url", async () => {
    const open = vi.fn<PreviewPort["open"]>(async () => ({ ok: true, value: openSuccess }));
    const preview: PreviewPort = {
      open,
      read: async () => ({ ok: true, value: readSuccess }),
      screenshot: async () => ({ ok: false, error: "not built" }),
    };

    await browserOpenTool.handler({ url: "https://example.com" }, context(preview));
    expect(open).toHaveBeenLastCalledWith(
      { url: "https://example.com" },
      expect.objectContaining({ allowRemote: true }),
    );

    await browserOpenTool.handler({ url: "http://localhost:4000" }, context(preview));
    const localCallOpts = open.mock.calls[1]?.[1];
    expect(localCallOpts).not.toHaveProperty("allowRemote");

    await browserOpenTool.handler({ path: "/repo/index.html" }, context(preview));
    const pathCallOpts = open.mock.calls[2]?.[1];
    expect(pathCallOpts).not.toHaveProperty("allowRemote");
  });

  it("forwards preview_id as previewId and returns the port's success value", async () => {
    const open = vi.fn<PreviewPort["open"]>(async () => ({ ok: true, value: openSuccess }));
    const preview: PreviewPort = {
      open,
      read: async () => ({ ok: true, value: readSuccess }),
      screenshot: async () => ({ ok: false, error: "not built" }),
    };

    const result = await browserOpenTool.handler(
      { url: "http://localhost:3000", preview_id: "preview-1" },
      context(preview),
    );

    expect(open).toHaveBeenCalledWith(
      { url: "http://localhost:3000", previewId: "preview-1" },
      { signal: expect.any(AbortSignal), toolCallId: "call-1" },
    );
    expect(result).toMatchObject({ ok: true, output: openSuccess });
  });

  it("maps a host error onto ToolResult, narrowing errorKind to the compatible subset", async () => {
    const preview: PreviewPort = {
      open: async () => ({ ok: false, error: "no such preview", errorKind: "unavailable" }),
      read: async () => ({ ok: true, value: readSuccess }),
      screenshot: async () => ({ ok: false, error: "not built" }),
    };

    const result = await browserOpenTool.handler({ path: "/x.html" }, context(preview));
    expect(result).toMatchObject({ ok: false, error: "no such preview" });
    expect(result.errorKind).toBeUndefined();

    const cancelledPreview: PreviewPort = {
      ...preview,
      open: async () => ({ ok: false, error: "cancelled", errorKind: "cancelled" }),
    };
    const cancelledResult = await browserOpenTool.handler({ path: "/x.html" }, context(cancelledPreview));
    expect(cancelledResult).toMatchObject({ ok: false, errorKind: "cancelled" });

    const timeoutPreview: PreviewPort = {
      ...preview,
      open: async () => ({ ok: false, error: "timed out", errorKind: "timeout" }),
    };
    const timeoutResult = await browserOpenTool.handler({ path: "/x.html" }, context(timeoutPreview));
    expect(timeoutResult).toMatchObject({ ok: false, errorKind: "timed_out" });
  });
});

describe("BrowserRead", () => {
  it("fails closed without a preview port", async () => {
    const result = await browserReadTool.handler(browserReadInputSchema.parse({}), context());
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toBe("Browser preview is unavailable in this session.");
  });

  it("declares the frozen §2.2 metadata literal, incl. the 60_000-byte resultBudget", () => {
    expect(browserReadTool.metadata).toMatchObject({
      name: "BrowserRead",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      timeoutMs: 20_000,
      resultBudget: { maxModelBytes: 60_000, previewDirection: "head" },
    });
  });

  it("defaults format to text and include_console to true", () => {
    expect(browserReadInputSchema.parse({})).toEqual({ format: "text", include_console: true });
  });

  it("rejects wait_ms over the 10_000ms cap", () => {
    expect(browserReadInputSchema.safeParse({ wait_ms: 10_001 }).success).toBe(false);
    expect(browserReadInputSchema.safeParse({ wait_ms: 10_000 }).success).toBe(true);
  });

  it("forwards every optional field to the port under its wire name", async () => {
    const read = vi.fn<PreviewPort["read"]>(async () => ({ ok: true, value: readSuccess }));
    const preview: PreviewPort = {
      open: async () => ({ ok: true, value: openSuccess }),
      read,
      screenshot: async () => ({ ok: false, error: "not built" }),
    };

    await browserReadTool.handler(
      browserReadInputSchema.parse({
        preview_id: "preview-1",
        selector: "#app",
        format: "html",
        wait_for_selector: "#ready",
        wait_ms: 500,
        include_console: false,
      }),
      context(preview),
    );

    expect(read).toHaveBeenCalledWith(
      {
        previewId: "preview-1",
        selector: "#app",
        format: "html",
        waitForSelector: "#ready",
        waitMs: 500,
        includeConsole: false,
      },
      { signal: expect.any(AbortSignal), toolCallId: "call-1" },
    );
  });

  it("embeds the console tail INSIDE the formatted model text (so the TASK.93 budget covers it)", () => {
    const withConsole: PreviewReadSuccess = {
      previewId: "preview-1",
      url: "file:///repo/index.html",
      text: "page body text",
      console: [
        { level: "log", message: "booted", at: "2026-08-01T00:00:00.000Z" },
        { level: "error", message: "TypeError: boom", at: "2026-08-01T00:00:01.000Z" },
      ],
      consoleDropped: 3,
    };

    const rendered = browserReadTool.formatResultForModel?.({ ok: true, output: withConsole });

    expect(rendered).toContain("page body text");
    expect(rendered).toContain("[console tail]");
    expect(rendered).toContain("TypeError: boom");
    expect(rendered).toContain("3 earlier console entries dropped");
    // The console tail is not a separate side-channel — it is textually
    // part of the SAME string the dispatcher's applyResultBudget(text, ...)
    // would budget, so a declared 60_000-byte cap really covers it.
    expect(rendered?.indexOf("[console tail]")).toBeGreaterThan(rendered?.indexOf("page body text") ?? -1);
  });

  it("omits the console section entirely when there are no entries", () => {
    const rendered = browserReadTool.formatResultForModel?.({ ok: true, output: readSuccess });
    expect(rendered).toBe("hello world");
    expect(rendered).not.toContain("console");
  });

  it("formatResultForModel surfaces the plain error string on failure", () => {
    const rendered = browserReadTool.formatResultForModel?.({ ok: false, error: "boom" });
    expect(rendered).toBe("boom");
  });
});
