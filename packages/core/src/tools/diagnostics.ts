/**
 * Diagnostics-after-edit wrappers (Phase 6 slice 6.1, design §2-C4). These tools
 * are registered by the CLI wiring OVER the default Edit/Write (same names
 * "Edit"/"Write"); the default tool registry, the desktop model-facing surface,


 * path — name, riskLevel, needsApproval, hooks, rules — is byte-identical to the
 * unwrapped tool; the system prompt's toolNames snapshot is unchanged (no new
 * tool NAMES exist).
 *

 *   1. delegate to the UNCHANGED inner handler.
 *   2. short-circuit — returning the inner result untouched — when the inner
 *      call failed/was denied, the session carries no LspPort, or the turn was
 *      aborted. A denied/failed write therefore NEVER triggers a re-read or a
 *      language-server spawn (spawn lives strictly AFTER a successful write).
 *   3. re-read the just-written file through FileSystemPort; any read error is
 *      swallowed and the inner result is returned unchanged.
 *   4. ask LspPort.diagnosticsAfterWrite. When available with findings, attach an
 *      additive `diagnostics` string; available with zero findings attaches the
 *      "none reported" signal (a clean file is worth telling the model); an
 *      unavailable outcome (no server / initializing / timeout / failed) attaches
 *      NO field, keeping the result byte-identical to today.
 *
 * The extended output type lives here as WithDiagnostics<T>; tools/schemas.ts,
 * tools/edit.ts and tools/write.ts stay byte-identical (L2).
 */

import type { ToolDefinition, ToolResult } from "../types/tools.js";
import type { FileDiagnostic } from "../ports/lsp.js";
import { LSP_DIAGNOSTICS_MAX_ITEMS } from "../types/config.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import type { EditInput, EditOutput, WriteInput, WriteOutput } from "./schemas.js";

/** Inner tool output widened with an optional, model-visible diagnostics string. */
export type WithDiagnostics<Out> = Out & { diagnostics?: string };

/** Sort rank: errors first, then warnings, then info, then hints. */
const SEVERITY_RANK: Record<FileDiagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

/**
 * Renders diagnostics into a compact, deterministic, model-visible block:
 * error->warning->info->hint (stable within a severity), one line each as
 * `${line}:${column} ${severity}: ${message}` with an optional ` [code]` suffix,
 * capped at LSP_DIAGNOSTICS_MAX_ITEMS with a trailing `… and N more`.
 */
export function formatDiagnostics(diags: FileDiagnostic[]): string {
  const sorted = [...diags].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const shown = sorted.slice(0, LSP_DIAGNOSTICS_MAX_ITEMS);
  const lines = shown.map((d) => {
    const codeSuffix = d.code ? ` [${d.code}]` : "";
    return `${d.line}:${d.column} ${d.severity}: ${d.message}${codeSuffix}`;
  });
  const overflow = sorted.length - shown.length;
  if (overflow > 0) {
    lines.push(`… and ${overflow} more`);
  }
  return lines.join("\n");
}

/**
 * Wraps a write-effect tool so that, after a successful inner write and only
 * when a LspPort is present on the context, the just-written file's diagnostics
 * are attached to the output. `pickPath` extracts the absolute file path from the
 * (unchanged) inner input.
 */
function wrapWithDiagnostics<In, Out>(
  inner: ToolDefinition<In, Out>,
  pickPath: (input: In) => string,
): ToolDefinition<In, WithDiagnostics<Out>> {
  return {

    // new tool name. NOT a copy — the shared reference makes the "byte-identical
    // permission path" invariant structural (§6#6a asserts the identity).
    metadata: inner.metadata,
    // Input surface untouched: the inner tool's schema is reused verbatim.
    inputSchema: inner.inputSchema,
    handler: async (input, ctx): Promise<ToolResult<WithDiagnostics<Out>>> => {
      // The inner result viewed as a not-yet-diagnosed result: this widening is
      // sound because `diagnostics` is optional, so an un-augmented Out already
      // satisfies WithDiagnostics<Out>. Every short-circuit below returns it
      // byte-identical to the inner tool.
      const res = (await inner.handler(input, ctx)) as ToolResult<WithDiagnostics<Out>>;

      // no LspPort, or an aborted turn all return the inner result untouched. No
      // re-read and no server spawn ever happen without a successful inner write.
      if (!res.ok || !ctx.lsp || ctx.abortSignal.aborted) {
        return res;
      }

      const path = pickPath(input);
      let content: string;
      try {
        content = await ctx.ports.fs.readFile(path);
      } catch {
        // Re-read failed (raced deletion, etc.): today's behavior, no field.
        return res;
      }

      const outcome = await ctx.lsp.diagnosticsAfterWrite(path, content);
      if (!outcome.available) {
        // Infrastructure noise (no_server / initializing / timeout / server_failed)
        // is never shown to the model: result stays byte-identical to today.
        return res;
      }

      const diagnostics =
        outcome.diagnostics.length > 0 ? formatDiagnostics(outcome.diagnostics) : "none reported";
      const output = { ...res.output, diagnostics } as WithDiagnostics<Out>;
      return { ...res, output };
    },
  };
}

/* */
export const diagnosticsEditTool: ToolDefinition<EditInput, WithDiagnostics<EditOutput>> =
  wrapWithDiagnostics(editTool, (input) => input.file_path);

/* */
export const diagnosticsWriteTool: ToolDefinition<WriteInput, WithDiagnostics<WriteOutput>> =
  wrapWithDiagnostics(writeTool, (input) => input.file_path);
