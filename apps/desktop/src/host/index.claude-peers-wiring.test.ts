import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { Session } from "./session.js";
import { createSessionPeerBridge } from "./engines/session-peer-bridge.js";
import { claudeAgentPermissionMode, nativePeerAuthorityMode } from "./engines/child-permission-map.js";
import { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";
import { createConnectionTargetsBridge } from "./engines/connection-targets-bridge.js";
import { ClaudeMcpBridge } from "./engines/claude/mcp-bridge.js";
import { ClaudeShadowTranscriptEngine, SqliteClaudeShadowTranscript } from "./engines/claude/shadow-transcript.js";

// Execute the production factory without importing index.ts's utility-process
// entrypoint. AST extraction preserves its closures and configure callback;
// changing the ownership/mode expression in index.ts changes these tests.
const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const factory = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "hostSwitchFactory")!;
const executable = ts.transpileModule(factory.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

async function fixture() {
  let preset = "ask";
  const raw = { snapshot: () => ({ activePresetId: preset }) };
  const session = Object.create(Session.prototype);
  const request = vi.fn(async () => ({ status: "ok", sessions: [] }));
  const broker = { requestPermission: vi.fn(async () => ({ behavior: "allow" })) };
  let authority!: Parameters<typeof createSessionPeerBridge>[0]["authority"];
  const routing = { catalog: [], port: undefined, browser: { specs: [], byClaudeName: () => undefined },
    foreign: { catalog: async () => [], isEnabled: () => false },
    configure: (runtime: any) => { runtime.callbacks = { usageAudit: { sink: {} } }; }, cleanup: () => {} };
  const deps = {
    engineSwitchEnabled: true, process, hostMcpLoginPath: undefined,
    resolveExtensionsHomeOverride: () => undefined, homedir: () => "/home", ENV_SETTINGS_PATH: "SETTINGS",
    persistence: {}, hostWorkspaceTrust: { projectTrusted: true }, NodeFileSystemAdapter: class {},
    parseAskClassifierEnvKind: () => undefined, ENV_PERMISSION_CLASSIFIER: "CLASSIFIER",
    decorateEngineBroker: () => broker, workspace: "/work", session,
    createSwitchEngineFactory: (context: any) => context,
    ENV_CLAUDE_BIN: "CLAUDE_BIN", candidateRouting: async () => routing,
    sessionPeersPort: { request }, createBridgePresentationStamp,
    nativeConnectionBridge: () => createConnectionTargetsBridge(() => ({
      current: { engine: "claude", routeKind: "native_cli", model: "native-model" }, connections: [],
    })),
    createSessionPeerBridge: (options: Parameters<typeof createSessionPeerBridge>[0]) => {
      authority = options.authority;
      return createSessionPeerBridge(options);
    },
    ClaudeMcpBridge, buildClaudeLaunchOptions: (options: any) => options,
    resolveClaudeConfigDir: () => "/home/claude", claudeAgentPermissionMode, nativePeerAuthorityMode,
    ClaudeShadowTranscriptEngine, SqliteClaudeShadowTranscript, bindClaudeUsage: () => {},
  };
  const hostSwitchFactory = new Function(...Object.keys(deps), `${executable}\nreturn hostSwitchFactory;`)(...Object.values(deps));
  const context = hostSwitchFactory("root", broker, {}, {}, undefined, { env: { CLAUDE_BIN: "/claude" }, target: { engine: "claude" } });
  const resolved = await context.resolveClaude();
  const runtime = { engine: raw, identity: { externalSessionRef: "native", model: "model" } };
  resolved.configure(runtime);
  session.engine = runtime.engine; // Session adopts the configured runtime, including its wrapper.
  const call = (name = "sessions_list", args = {}) => resolved.options.stamp.callTool(name, args, new AbortController().signal, { toolUseId: "use" });
  expect(resolved.options.bootNotices).toContainEqual(expect.objectContaining({ type: "engine_notice", message: "Built-in AnyCode skills are unavailable after switching engines. Start a new Claude session to use them." }));
  return { raw, runtime, session, request, broker, authority: () => authority(), call,
    preset: (value: string) => { preset = value; }, close: () => resolved.options.mcpBridge.close() };
}

it("switched Claude peers use the engine adopted by Session, and lose authority when no longer owned", async () => {
  const f = await fixture();
  try {
    expect(f.runtime.engine).toBeInstanceOf(ClaudeShadowTranscriptEngine);
    expect(f.runtime.engine).not.toBe(f.raw);
    expect(f.authority().root).toBe(true);
    const catalog = await f.call("list_connections");
    expect(catalog.isError).toBe(false);
    expect(JSON.parse(catalog.text)).toMatchObject({ current: { engine: "claude", model: "native-model" } });
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.call()).isError).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
    f.session.engine = {}; // Child/non-owned runtime cannot act as the root.
    expect(f.authority().root).toBe(false);
    expect((await f.call()).isError).toBe(true);
    expect(f.request).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it("switched Claude peer authority maps ask to one broker prompt and read-only to a refusal before approval", async () => {
  const f = await fixture();
  try {
    const input = { sessionId: "peer", payload: "hello" };
    f.preset("read-only");
    expect(f.authority().mode).toBe("plan");
    expect((await f.call("session_send", input)).isError).toBe(true);
    expect(f.broker.requestPermission).not.toHaveBeenCalled();
    f.preset("ask");
    expect(f.authority().mode).toBe("build");
    expect((await f.call("session_send", input)).isError).toBe(false);
    expect(f.broker.requestPermission).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it("switched Claude peer mode follows the live preset and read-only denies mutations before approval", async () => {
  const f = await fixture();
  try {
    const input = { sessionId: "peer", payload: "hello" };
    expect(f.authority()).toMatchObject({ root: true, mode: "build" });
    expect((await f.call("session_send", input)).isError).toBe(false);
    expect(f.broker.requestPermission).toHaveBeenCalledOnce();
    f.request.mockClear(); f.broker.requestPermission.mockClear();
    f.preset("read-only");
    expect(f.authority().mode).toBe("plan");
    expect((await f.call("session_send", input)).isError).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.broker.requestPermission).not.toHaveBeenCalled();
    expect((await f.call()).isError).toBe(false);
    f.preset("workspace");
    expect(f.authority().mode).toBe("build");
  } finally { await f.close(); }
});
