/**
 * Taskana 4764: the ONE shared module that gives Claude and Codex engine
 * tabs the browser tools. Both engine doors (claude's in-process MCP door
 * `bridge-presentation-stamp.ts`, codex's dynamicTools bridge
 * `dynamic-tool-bridge.ts`) serve the SAME core `ToolDefinition`s the native
 * tab registers (host/index.ts ~line 3199): browserOpenTool/browserReadTool/
 * browserScreenshotTool plus createBrowserControlTools. No tool logic is
 * copied — this module is declarations + one serialized dispatch wrapper.
 *
 * Security posture (the whole story, deliberately identical for both
 * engines):
 *   - `resolveMetadata().needsApproval` of the SAME core tools drives the
 *     SAME `IpcPermissionBroker` (the session's raw broker, NOT the
 *     classifying decorator) -> the SAME modal, the same always-allow rules
 *     keyed by the canonical tool name, the same unattended latch/120 s
 *     deadline/`denyAll` on Stop.
 *   - The "Full browser access" switch is read LIVE through the same
 *     `fullAccess()` closure the native boot uses (host/index.ts
 *     `browserAccess`); the control-tool factory already folds it into
 *     `resolveMetadata`, so with the switch on, remote navigate/click/type
 *     and eval do not ask — exactly like a native tab. `BrowserOpen` of a
 *     remote url asks even with the switch on (its metadata is static), also
 *     exactly like a native tab.
 *   - No preset/mode ever suppresses the ask in engine tabs (native
 *     auto/yolo modes do not exist here) — a deliberate, documented
 *     difference.
 *   - Domain policy stays in main (PreviewHost/BrowserController): the tools
 *     pass `allowRemote:true` only after approval (or with the switch on),
 *     and main re-checks every decision regardless.
 *   - Calls are SERIALIZED through one promise chain (every browser tool is
 *     `concurrentSafe:false`; two parallel model tool calls must not
 *     interleave on one preview).
 *   - The bridge never logs inputs, urls or results (counts only).
 */

import { z } from "zod";
import type {
  McpToolCallResult,
  PermissionRequest,
  PreviewPort,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@anycode/core";
import {
  browserOpenTool,
  browserReadTool,
  browserScreenshotTool,
  createBrowserControlTools,
} from "@anycode/core";
import type { IpcPermissionBroker } from "../permission-broker.js";

/** The bare MCP name prefix the Claude CLI stamps onto this door's tools. */
export const CLAUDE_BROWSER_TOOL_PREFIX = "mcp__anycode__browser_";

/** One browser tool as both engine doors declare it. */
export interface EngineBrowserSpec {
  /** The name the UI/rules/transcript use ("BrowserNavigate"). */
  canonical: string;
  /** Bare MCP name ("browser_navigate"); the CLI shows `mcp__anycode__browser_navigate`. */
  claudeName: string;
  /** Codex dynamicTools name ("anycode_browser_navigate"). */
  codexName: string;
  /** The tool's own metadata.description. */
  description: string;
  /** `z.toJSONSchema(tool.inputSchema)` — refinements are not representable and are dropped; the host re-validates with the zod schema anyway. */
  inputSchema: Record<string, unknown>;
}

/** A dispatched browser call's outcome, shape shared by both engine doors. */
export interface EngineBrowserCallResult {
  text: string;
  isError: boolean;
  /** base64 PNG (no data: prefix), max one image (BrowserScreenshot). */
  images?: Array<{ mediaType: "image/png"; data: string }>;
  status: "success" | "error" | "cancelled" | "denied";
  durationMs: number;
}

export interface EngineBrowserBridgeDeps {
  /** The module-scope previewPort (host/index.ts ~line 995). */
  preview: PreviewPort;
  /** `() => browserAccess.get()` — read live on every call, never cached. */
  fullAccess: () => boolean;
  /** The session's RAW IpcPermissionBroker (the classifier only handles Bash-like tools). */
  broker: Pick<IpcPermissionBroker, "requestPermission">;
  cwd: string;
}

export interface EngineBrowserBridge {
  /** Fixed order, the 10 entries of Taskana 4764 §2.2. */
  specs: readonly EngineBrowserSpec[];
  byClaudeName(name: string): EngineBrowserSpec | undefined;
  byCodexName(name: string): EngineBrowserSpec | undefined;
  call(spec: EngineBrowserSpec, rawArgs: unknown, signal: AbortSignal, toolCallId: string): Promise<EngineBrowserCallResult>;
}

/** "mcp__anycode__browser_navigate" -> "BrowserNavigate"; anything else -> undefined. */
export function canonicalBrowserToolName(cliName: string): string | undefined {
  if (typeof cliName !== "string" || !cliName.startsWith(CLAUDE_BROWSER_TOOL_PREFIX)) return undefined;
  // claudeName is "browser_" + suffix; the map is keyed by the full claudeName.
  const claudeName = `browser_${cliName.slice(CLAUDE_BROWSER_TOOL_PREFIX.length)}`;
  const spec = SPECS_BY_CLAUDE_NAME.get(claudeName);
  return spec === undefined ? undefined : spec.canonical;
}

const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;

/**
 * The fixed §2.2 name table. Deriving snake_case from the canonical name is
 * forbidden on purpose (a naive `replace(/^Browser/, "browser_")` produces
 * `browser_waitfor`); the door names are a frozen wire contract.
 */
const TOOL_NAME_TABLE: ReadonlyArray<{ canonical: string; claudeName: string; codexName: string }> = [
  { canonical: "BrowserOpen", claudeName: "browser_open", codexName: "anycode_browser_open" },
  { canonical: "BrowserRead", claudeName: "browser_read", codexName: "anycode_browser_read" },
  { canonical: "BrowserScreenshot", claudeName: "browser_screenshot", codexName: "anycode_browser_screenshot" },
  { canonical: "BrowserNavigate", claudeName: "browser_navigate", codexName: "anycode_browser_navigate" },
  { canonical: "BrowserSnapshot", claudeName: "browser_snapshot", codexName: "anycode_browser_snapshot" },
  { canonical: "BrowserClick", claudeName: "browser_click", codexName: "anycode_browser_click" },
  { canonical: "BrowserType", claudeName: "browser_type", codexName: "anycode_browser_type" },
  { canonical: "BrowserWaitFor", claudeName: "browser_wait_for", codexName: "anycode_browser_wait_for" },
  { canonical: "BrowserConsole", claudeName: "browser_console", codexName: "anycode_browser_console" },
  { canonical: "BrowserEval", claudeName: "browser_eval", codexName: "anycode_browser_eval" },
];

interface BrowserToolEntry {
  spec: EngineBrowserSpec;
  tool: ToolDefinition<never, never>;
}

/** The fixed 10-tool order (§2.2), built once from the same core objects the native boot registers. */
function buildEntries(fullAccess: () => boolean): BrowserToolEntry[] {
  const control = createBrowserControlTools({ fullAccess });
  const tools: Array<ToolDefinition<never, never>> = [
    browserOpenTool as never as ToolDefinition<never, never>,
    browserReadTool as never as ToolDefinition<never, never>,
    browserScreenshotTool as never as ToolDefinition<never, never>,
    control.navigate as never as ToolDefinition<never, never>,
    control.snapshot as never as ToolDefinition<never, never>,
    control.click as never as ToolDefinition<never, never>,
    control.type as never as ToolDefinition<never, never>,
    control.waitFor as never as ToolDefinition<never, never>,
    control.console as never as ToolDefinition<never, never>,
    control.eval as never as ToolDefinition<never, never>,
  ];
  if (tools.length !== TOOL_NAME_TABLE.length) {
    throw new Error("engine browser bridge: core tool set drifted from the frozen name table");
  }
  return tools.map((tool, index) => {
    const names = TOOL_NAME_TABLE[index]!;
    if (tool.metadata.name !== names.canonical) {
      throw new Error(`engine browser bridge: core tool order drifted (${tool.metadata.name} !== ${names.canonical})`);
    }
    return {
      tool,
      spec: {
        canonical: names.canonical,
        claudeName: names.claudeName,
        codexName: names.codexName,
        description: tool.metadata.description,
        inputSchema: z.toJSONSchema(tool.inputSchema as z.ZodType) as Record<string, unknown>,
      },
    };
  });
}

const SPECS_BY_CLAUDE_NAME = new Map<string, EngineBrowserSpec>(
  buildEntries(() => false).map((entry) => [entry.spec.claudeName, entry.spec]),
);

/** zod issues -> "path: message; path: message" (max 3), never the received value. */
function zodIssuesToText(spec: EngineBrowserSpec, issues: z.ZodIssue[]): string {
  const parts = issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
  return `${spec.canonical}: ${parts.join("; ")}`;
}

export function createEngineBrowserBridge(deps: EngineBrowserBridgeDeps): EngineBrowserBridge {
  const entries = buildEntries(deps.fullAccess);
  const specs: readonly EngineBrowserSpec[] = entries.map((entry) => entry.spec);
  const byClaude = new Map(entries.map((entry) => [entry.spec.claudeName, entry] as const));
  const byCodex = new Map(entries.map((entry) => [entry.spec.codexName, entry] as const));

  /** One at a time: the browser tools are concurrentSafe:false. */
  let chain: Promise<unknown> = Promise.resolve();

  async function dispatch(
    entry: BrowserToolEntry,
    rawArgs: unknown,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<EngineBrowserCallResult> {
    const { spec, tool } = entry;
    const startedAt = Date.now();
    // Malformed arguments never reach the schema or the broker.
    if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return { text: `Malformed arguments for ${spec.canonical}`, isError: true, status: "error", durationMs: Date.now() - startedAt };
    }
    const parsed = (tool.inputSchema as z.ZodType).safeParse(rawArgs);
    if (!parsed.success) {
      return { text: zodIssuesToText(spec, parsed.error.issues), isError: true, status: "error", durationMs: Date.now() - startedAt };
    }
    const input = parsed.data;
    const meta = (tool.resolveMetadata as ((value: unknown) => ToolDefinition["metadata"]) | undefined)?.(input) ?? tool.metadata;
    if (meta.needsApproval === true) {
      const request: PermissionRequest = {
        toolName: spec.canonical,
        toolCallId,
        input,
        metadata: meta,
        mode: "build",
      };
      const decision = await deps.broker.requestPermission(request);
      if (decision.behavior !== "allow") {
        // The handler is NEVER invoked on a deny; `updatedInput` on an allow is
        // IGNORED below — the user approved exactly this input.
        return {
          text: decision.behavior === "deny" && decision.reason ? decision.reason : `${spec.canonical} was denied by the user`,
          isError: true,
          status: "denied",
          durationMs: Date.now() - startedAt,
        };
      }
    }
    // The engine model behind a Claude/Codex tab is image-capable for our
    // purposes: the media gate is open (BrowserScreenshot is its only reader).
    const ctx: ToolContext = {
      toolCallId,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(meta.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS)]),
      cwd: deps.cwd,
      ports: {} as never,
      preview: deps.preview,
      media: { imageInputEnabled: () => true } as never,
    };
    let result: ToolResult;
    try {
      // The handler race: a well-behaved handler returns a cancelled ToolResult
      // when its signal fires; a hanging one is cut loose here so the call
      // (and the serialization chain behind it) always settles.
      const never: Promise<never> = new Promise(() => {});
      const onAbort: Promise<never> = new Promise((_resolve, reject) => {
        const rejectAbort = (): void => reject(new Error("aborted"));
        if (ctx.abortSignal.aborted) rejectAbort();
        else ctx.abortSignal.addEventListener("abort", rejectAbort, { once: true });
      });
      const handler = tool.handler as unknown as (value: unknown, context: ToolContext) => Promise<ToolResult>;
      result = await Promise.race([
        handler(input, ctx),
        never,
        onAbort,
      ]);
    } catch {
      // A thrown message can carry paths — never forwarded.
      if (signal.aborted) {
        return { text: "Browser call was cancelled", isError: true, status: "cancelled", durationMs: Date.now() - startedAt };
      }
      if (ctx.abortSignal.aborted) {
        return { text: `${spec.canonical} timed out`, isError: true, status: "error", durationMs: Date.now() - startedAt };
      }
      return { text: `${spec.canonical} failed`, isError: true, status: "error", durationMs: Date.now() - startedAt };
    }
    if (signal.aborted) {
      return { text: "Browser call was cancelled", isError: true, status: "cancelled", durationMs: Date.now() - startedAt };
    }
    if (result.ok === false && result.errorKind === "cancelled") {
      return { text: "Browser call was cancelled", isError: true, status: "cancelled", durationMs: Date.now() - startedAt };
    }
    const text =
      (tool.formatResultForModel as ((value: ToolResult) => string) | undefined)?.(result) ??
      (result.ok ? "" : result.error ?? `${spec.canonical} failed`);
    const images =
      result.ok && Array.isArray(result.images)
        ? result.images
            .filter((image) => image.mediaType === "image/png" && typeof image.data === "string")
            .slice(0, 1)
            .map((image) => ({ mediaType: "image/png" as const, data: image.data }))
        : undefined;
    return {
      text,
      isError: !result.ok,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      status: result.ok ? "success" : "error",
      durationMs: Date.now() - startedAt,
    };
  }

  const bridge: EngineBrowserBridge = {
    specs,
    byClaudeName: (name) => (typeof name === "string" ? byClaude.get(name)?.spec : undefined),
    byCodexName: (name) => (typeof name === "string" ? byCodex.get(name)?.spec : undefined),
    call: (spec, rawArgs, signal, toolCallId) => {
      const entry = entries.find((candidate) => candidate.spec === spec);
      if (entry === undefined) {
        return Promise.resolve({
          text: `Unknown browser tool ${String(spec.canonical)}`,
          isError: true,
          status: "error" as const,
          durationMs: 0,
        });
      }
      const run = (): Promise<EngineBrowserCallResult> =>
        signal.aborted
          ? // A queued call aborted before its turn never touches the port.
            Promise.resolve({ text: "Browser call was cancelled", isError: true, status: "cancelled" as const, durationMs: 0 })
          : dispatch(entry, rawArgs, signal, toolCallId);
      const next = chain.then(run, run);
      // The chain never rejects: `dispatch` returns results, it does not throw.
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
  return bridge;
}

/** Narrow helper for the Claude door: an EngineBrowserCallResult is a valid McpToolCallResult with images. */
export function toMcpToolCallResult(result: EngineBrowserCallResult): McpToolCallResult {
  return { text: result.text, isError: result.isError, ...(result.images !== undefined ? { images: result.images } : {}) };
}
