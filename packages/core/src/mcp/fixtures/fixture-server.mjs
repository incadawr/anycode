/**
 * Hermetic MCP fixture server (design slice-3.2-cut.md §5.1). Plain ESM so it
 * runs directly as `[process.execPath, thisPath]` with NO tsx/build step. Uses
 * the SDK SERVER half (server/mcp.js + StdioServerTransport) — that half appears
 * ONLY here and in tests, never in production code. Deterministic: no network,
 * no timers except the one `slow` uses.
 *
 * Tools:
 *   echo        — reflects its `message` argument (happy-path + arg passing)
 *   schema_rich — nested/required/enum input + readOnlyHint annotation
 *                 (proves rawInputJsonSchema passthrough; annotation is ignored)
 *   slow        — waits `ms` (cancellation mid-call; dispose during a live call)
 *   fail        — returns isError:true (error-outcome without throwing)
 *   big         — returns text larger than MCP_RESULT_MAX_BYTES (result cap)
 *   env_probe   — returns JSON.stringify(process.env) (env scrub proof)
 *
 * Flags:
 *   --ignore-sigterm — installs a no-op SIGTERM handler AND stays alive after
 *     stdin EOF (heartbeat), so ONLY SIGKILL can reap it — proves the transport's
 *     SIGTERM->SIGKILL escalation. Without the flag the process exits on SIGTERM

 *   --stall-list — `initialize` still completes, but the `tools/list` handler
 *     never resolves, so the connect budget (not the SDK's 60s default) must
 *     bound listTools and the connect-failure path must reap this child.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const ignoreSigterm = process.argv.includes("--ignore-sigterm");
const stallList = process.argv.includes("--stall-list");

const server = new McpServer({ name: "anycode-fixture", version: "0.0.1" });

server.registerTool(
  "echo",
  {
    description: "Echoes the message argument back as text.",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text", text: message }] }),
);

server.registerTool(
  "schema_rich",
  {
    description: "A tool with a nested/required/enum input schema.",
    inputSchema: {
      title: z.string(),
      options: z.object({
        mode: z.enum(["fast", "slow"]),
        retries: z.number().int(),
      }),
    },
    annotations: { title: "Schema Rich", readOnlyHint: true, destructiveHint: false },
  },
  async ({ title }) => ({ content: [{ type: "text", text: `ok:${title}` }] }),
);

server.registerTool(
  "slow",
  {
    description: "Waits ms milliseconds then returns.",
    inputSchema: { ms: z.number().int() },
  },
  async ({ ms }, extra) => {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Abort the wait if the client cancels the request.
      extra?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
    return { content: [{ type: "text", text: "done" }] };
  },
);

server.registerTool(
  "fail",
  {
    description: "Always returns an error result.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: "boom: intentional failure" }], isError: true }),
);

server.registerTool(
  "big",
  {
    description: "Returns a very large text payload.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: "x".repeat(250_000) }] }),
);

server.registerTool(
  "env_probe",
  {
    description: "Returns the child process env as JSON.",
    inputSchema: {},
  },
  async () => ({ content: [{ type: "text", text: JSON.stringify(process.env) }] }),
);

if (stallList) {
  // Override the auto-registered tools/list handler with one that never resolves.
  // `initialize` still completes normally, so connect() succeeds and the stall
  // surfaces only on tools/list — exactly the case the connect budget must bound.
  server.server.setRequestHandler(ListToolsRequestSchema, () => new Promise(() => {}));
}

if (ignoreSigterm) {
  // Stubborn child: ignore SIGTERM and survive stdin EOF so ONLY SIGKILL reaps it.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {

  // is delivered (e.g. the host was SIGKILLed and could not SIGTERM its children).
  const exitOnEof = () => process.exit(0);
  process.stdin.on("end", exitOnEof);
  process.stdin.on("close", exitOnEof);
}

const transport = new StdioServerTransport();
await server.connect(transport);
