import { orchestrationDeveloperBlock } from "@anycode/core";
/**
 * cut §1.5 D2: `resumeClaudeEngine` must spawn `--resume <ref>` (never
 * `--session-id`, which would start a brand-new native session under a
 * different id) and echo the persisted `externalSessionRef` back verbatim —
 * unlike `startClaudeEngine`, which always mints a fresh `randomUUID()`. Both
 * share the same `connectClaudeEngine` handshake; this file pins only the ONE
 * thing that differs between them, against a scripted fake child (no real
 * `claude` binary, mirrors claude-client.test.ts's framing-test fake spawn).
 */

import { buildClaudeRuntime, prepareSwitchRuntime } from "../../engine-switch-runtime.js";
import { ChildReportQueue } from "../../child-report-queue.js";
import { createHarness, finishStep } from "../../test-harness.js";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { RuntimeSessionHistory } from "../../runtime-session-history.js";
import { createDesktopStore } from "../../../renderer/src/store.js";
import { CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS } from "../../../shared/claude-timeouts.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeMcpForwardFile } from "./mcp-forward-file.js";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_NOT_SIGNED_IN, resumeClaudeEngine, startClaudeEngine } from "./claude-engine.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import * as overlayPolicy from "./orchestration-policy.js";
import type { ClaudeSystemInitMessage } from "./protocol.js";
import { ClaudeMcpBridge } from "./mcp-bridge.js";
import { createBridgePresentationStamp } from "./bridge-presentation-stamp.js";
import { createEngineBrowserBridge } from "../browser-bridge.js";

interface FakeStream extends EventEmitter {
  write(chunk: unknown): boolean;
  end(): void;
  pause(): void;
  resume(): void;
}

function makeFakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.write = () => true;
  stream.end = () => {};
  stream.pause = () => {};
  stream.resume = () => {};
  return stream;
}

const MODELS = [{ value: "model-a", resolvedModel: "model-a", displayName: "A" }];

/**
 * A fake `claude` child: answers `--version`, then the `initialize`
 * control-request over the NDJSON stdin/stdout pair. Captures the main
 * spawn's argv. `account` overrides the `initialize` response's account
 * object, so callers can exercise the sign-in predicate against the exact
 * shapes the live CLI returns (default mirrors a plain OAuth session).
 *
 * срез S4 (probes.md P0): when the outbound `initialize` body
 * carries a non-empty `sdkMcpServers`, this fake reproduces the ONE ordering
 * fact P0 measured against the REAL CLI — the CLI drives its OWN mcp
 * handshake (wrapped as a `mcp_message` control_request FROM the CLI TO the
 * host) INSIDE our outbound `initialize` call, before it ever answers ours.
 * The nested request is sent, and its answer captured, BEFORE this fake
 * answers the outer `initialize` — exactly the order a real CLI observes.
 * `nestedMcpResponse()` is `undefined` whenever `sdkMcpServers` never
 * appeared on the wire at all (i.e. `mcpBridge` was never supplied), which is
 * itself part of what the switch test below pins.
 */
function fakeSpawn(
  account: Record<string, unknown> = { tokenSource: "oauth" },
  models: unknown = MODELS,
  initialization?: { hold: boolean },
  shutdown?: { wait: Promise<void>; started: () => void },
): {
  spawnImpl: (command: string, args: readonly string[]) => unknown;
  streams: FakeStream[];
  capturedArgs: () => string[] | undefined;
  controlSubtypes: () => string[];
  /** Every control request the host SENT, with its body (the wire a pick really rides). */
  capturedControls: () => Array<{ subtype: string; request: Record<string, unknown> }>;
  userMessages: unknown[];
  capturedSdkMcpServers: () => unknown;
  nestedMcpResponse: () => { subtype: string; response?: unknown; error?: string } | undefined;
} {
  const streams: FakeStream[] = [];
  const userMessages: unknown[] = [];
  let mainArgs: string[] | undefined;
  const controls: string[] = [];
  const controlRequests: Array<{ subtype: string; request: Record<string, unknown> }> = [];
  let sdkMcpServers: unknown;
  let nestedResponse: { subtype: string; response?: unknown; error?: string } | undefined;
  const NESTED_MCP_REQUEST_ID = "nested-mcp-handshake";
  let callIndex = 0;
  const spawnImpl = (_command: string, args: readonly string[]): unknown => {
    callIndex++;
    const child = new EventEmitter() as unknown as {
      pid: number;
      stdin: FakeStream;
      stdout: FakeStream;
      stderr: FakeStream;
      kill: () => boolean;
    } & EventEmitter;
    child.pid = 2_000 + callIndex;
    if (shutdown) Object.assign(child, { exitCode: null, signalCode: null });
    child.stdin = makeFakeStream();
    child.stdout = makeFakeStream();
    child.stderr = makeFakeStream();
    child.stdin.end = () => {
      shutdown?.started();
      if (shutdown) void shutdown.wait.then(() => child.emit("close", 0, null));
      else queueMicrotask(() => child.emit("close", 0, null));
    };
    child.kill = () => {
      queueMicrotask(() => child.emit("close", 0, null));
      return true;
    };
    if (args.includes("--version")) {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("2.1.212 (Claude Code)\n"));
        child.emit("close", 0, null);
      });
      return child;
    }
    streams.push(child.stdout);
    mainArgs = [...args];
    let buffer = "";
    child.stdin.write = (chunk: unknown) => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        const message = JSON.parse(line) as {
          type: string;
          request_id?: string;
          request?: { subtype: string; sdkMcpServers?: unknown; model?: unknown };
          response?: { request_id: string; subtype: string; response?: unknown; error?: string };
        };
        if (message.type === "user") userMessages.push(message);
        if (message.type === "control_response") {
          // The host answering OUR nested (CLI -> host) mcp_message below.
          if (message.response?.request_id === NESTED_MCP_REQUEST_ID) {
            nestedResponse = message.response;
          }
          continue;
        }
        if (message.type !== "control_request" || message.request === undefined) continue;
        controls.push(message.request.subtype);
        controlRequests.push({ subtype: message.request.subtype, request: { ...message.request } });
        if (message.request.subtype !== "initialize") {
          const response = {};
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })}\n`),
            );
          });
          continue;
        }
        sdkMcpServers = message.request.sdkMcpServers;
        const respondToInitialize = (): void => {
          if (initialization?.hold) return;
          child.stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: { commands: [], models, account } },
              })}\n`,
            ),
          );
        };
        if (Array.isArray(sdkMcpServers) && sdkMcpServers.length > 0) {
          const serverName = sdkMcpServers[0] as string;
          queueMicrotask(() => {
            child.stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({
                  type: "control_request",
                  request_id: NESTED_MCP_REQUEST_ID,
                  request: { subtype: "mcp_message", server_name: serverName, message: { jsonrpc: "2.0", method: "notifications/initialized" } },
                })}\n`,
              ),
            );
            // The real CLI answers OUR initialize only once its own handshake
            // is done (probes.md P0) — a later microtask reproduces that
            // ordering rather than answering both in the same tick.
            queueMicrotask(respondToInitialize);
          });
        } else {
          queueMicrotask(respondToInitialize);
        }
      }
      return true;
    };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return {
    spawnImpl, streams, userMessages,
    capturedArgs: () => mainArgs,
    controlSubtypes: () => [...controls],
    capturedControls: () => [...controlRequests],
    capturedSdkMcpServers: () => sdkMcpServers,
    nestedMcpResponse: () => nestedResponse,
  };
}

function baseOptions(spawnImpl: (command: string, args: readonly string[]) => unknown) {
  return {
    bootstrap: { adopt: () => {} } as never,
    broker: new IpcPermissionBroker(() => {}),
    binaryPath: "/fake/claude",
    cwd: process.cwd(),
    profileDir: "/home/test/.anycode/claude/profile-default",
    sourceEnv: { HOME: "/home/test", PATH: process.env.PATH },
    binaryTrust: () => null,
    spawnImpl: spawnImpl as never,
  };
}

describe("resumeClaudeEngine vs startClaudeEngine (cut §1.5 D2)", () => {
  it("startClaudeEngine spawns --session-id with a fresh uuid", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await buildClaudeRuntime(baseOptions(spawnImpl));
    try {
      expect(connected.engineSettings.snapshot()).toEqual(expect.objectContaining({ model: connected.model }));
      const args = capturedArgs();
      expect(args).toContain("--session-id");
      expect(args).not.toContain("--resume");
      expect(connected.sessionRef).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("switches a Session to a prepared Claude candidate and preserves the source on rejection", async () => {
    const { spawnImpl } = fakeSpawn();
    let model = "missing";
    const h = createHarness({ steps: [finishStep()], switchEngineFactory: async () => prepareSwitchRuntime({ engine: "claude", model, options: baseOptions(spawnImpl) }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "failed", engine: "claude", model: "test-model" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed" && m.requestId === "failed"), 5000);
      expect(h.engine.id).toBe("core");
      h.send({ type: "user_message", requestId: "still-usable", text: "continue" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"), 5000);
      model = "model-a";
      h.send({ type: "engine_switch_request", requestId: "success", engine: "claude", model: "test-model" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switched" && m.requestId === "success"), 5000);
    } finally {
      await h.session.shutdown();
      h.close();
    }
  });

  it("resumeClaudeEngine spawns --resume <ref> and echoes the ref verbatim, never a fresh uuid", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await resumeClaudeEngine({ ...baseOptions(spawnImpl), externalSessionRef: "persisted-ref-123" });
    try {
      const args = capturedArgs()!;
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe("persisted-ref-123");
      expect(args).not.toContain("--session-id");
      expect(connected.sessionRef).toBe("persisted-ref-123");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("resumeClaudeEngine honours a persisted selection the same way a draft one is honoured at boot", async () => {
    const { spawnImpl } = fakeSpawn();
    const connected = await resumeClaudeEngine({
      ...baseOptions(spawnImpl),
      externalSessionRef: "persisted-ref-456",
      selection: { model: "model-a", presetId: "workspace", origin: "persisted" },
    });
    try {
      expect(connected.model).toBe("model-a");
      expect(connected.presetId).toBe("workspace");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

/**
 * the initial `--effort` spawn flag. Unlike model/permissionMode
 * (suppressed on resume, see the hazard (б) describe block below), effort
 * rides EVERY spawn: `system/init` carries no effort field at all, so there
 * is no surviving native truth a resend could clobber.
 */
describe("connect: --effort rides the spawn", () => {
  it("a fresh spawn carries --effort when the selection names one", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine({
      ...baseOptions(spawnImpl),
      selection: { effort: "high", origin: "draft" },
    });
    try {
      const args = capturedArgs()!;
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("high");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a resume ALSO carries --effort, unlike --permission-mode/set_model — there is no native state to protect", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await resumeClaudeEngine({
      ...baseOptions(spawnImpl),
      externalSessionRef: "persisted-ref-effort-1",
      selection: { effort: "xhigh", origin: "persisted" },
    });
    try {
      const args = capturedArgs()!;
      expect(args).toContain("--effort");
      expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("no --effort flag at all when the selection names none — the CLI's own default must not be fabricated", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      expect(capturedArgs()).not.toContain("--effort");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("an unrecognized effort string is dropped before it ever reaches argv (fail-closed against the fixed vocabulary)", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine({
      ...baseOptions(spawnImpl),
      selection: { effort: "ultra-mega", origin: "draft" },
    });
    try {
      expect(capturedArgs()).not.toContain("--effort");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a spawn-time effort the confirmed model does not support is not claimed as the local record", async () => {
    // MODELS' one entry has no supportedEffortLevels at all, so even though
    // "high" rode the spawn argv (fixed-vocabulary check only), the local
    // snapshot must not claim it once the real catalog is known.
    const { spawnImpl } = fakeSpawn();
    const connected = await startClaudeEngine({
      ...baseOptions(spawnImpl),
      selection: { model: "model-a", effort: "high", origin: "draft" },
    });
    try {
      expect(connected.engine.snapshot().effort).toBeUndefined();
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

/**
 * The reported defect: `create_session {engine:"claude", model:"<full id>"}`
 * started a session that actually ran the DEFAULT model. The live catalog
 * carries two ids per model — the wire `value` (`haiku`) and the full
 * `resolvedModel` the CLI reports (`claude-haiku-5-5`) — and the boot resolved
 * only the former, so a request naming the latter fell through to the default.
 * Both are honest names for the same model and BOTH must reach the engine.
 */
describe("connect: a requested model reaches the engine by alias OR by full resolved id", () => {
  /** Two entries: the reported shape (haiku = value, claude-haiku-5-5 = full id) plus the moving default. */
  const FULL_ID_MODELS = [
    { value: "default", resolvedModel: "claude-opus-5", displayName: "Default" },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
  ];

  const setModelBodies = (spawn: ReturnType<typeof fakeSpawn>): unknown[] =>
    spawn.capturedControls().filter((c) => c.subtype === "set_model").map((c) => c.request.model);

  it("a full resolved id boots that model — not the default, and set_model carries the wire value", async () => {
    const spawn = fakeSpawn({ tokenSource: "oauth" }, FULL_ID_MODELS);
    const connected = await startClaudeEngine({
      ...baseOptions(spawn.spawnImpl),
      selection: { model: "claude-haiku-5-5", origin: "draft" },
    });
    try {
      expect(connected.model).toBe("haiku");
      expect(setModelBodies(spawn)).toEqual(["haiku"]);
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("the alias for the same model boots identically", async () => {
    const spawn = fakeSpawn({ tokenSource: "oauth" }, FULL_ID_MODELS);
    const connected = await startClaudeEngine({
      ...baseOptions(spawn.spawnImpl),
      selection: { model: "haiku", origin: "draft" },
    });
    try {
      expect(connected.model).toBe("haiku");
      expect(setModelBodies(spawn)).toEqual(["haiku"]);
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("an id the account offers nothing for still degrades to the default at BOOT (the Sessions API refuses it before publication instead)", async () => {
    const spawn = fakeSpawn({ tokenSource: "oauth" }, FULL_ID_MODELS);
    const connected = await startClaudeEngine({
      ...baseOptions(spawn.spawnImpl),
      selection: { model: "claude-haiku-9-9", origin: "draft" },
    });
    try {
      expect(connected.model).toBe("default");
      // Nothing was sent to the CLI: an unverified id never reaches the wire.
      expect(setModelBodies(spawn)).toEqual([]);
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a full resolved id passed to selectModel is translated to the wire value too", async () => {
    const spawn = fakeSpawn({ tokenSource: "oauth" }, FULL_ID_MODELS);
    const connected = await startClaudeEngine(baseOptions(spawn.spawnImpl));
    try {
      expect(connected.model).toBe("default");
      const selected = await connected.engine.selectModel("claude-haiku-5-5");
      expect(selected).toEqual({ ok: true, model: "haiku" });
      expect(setModelBodies(spawn)).toEqual(["haiku"]);
      expect(connected.engine.snapshot().model).toBe("haiku");
      // The lookup the Sessions API's set_session_model uses.
      expect(connected.engine.resolveModelId("claude-haiku-5-5")).toBe("haiku");
      expect(connected.engine.resolveModelId("claude-imaginary-9")).toBeNull();
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

/**
 * cut §1.5 hazard (б) — a resume must not APPLY a persisted posture before it
 * has read the one that survived. A native Claude session keeps its own model
 * and `permissionMode` across process death (probe #4), and our row can be
 * stale: it may have been written from a change the CLI rejected, or edited by
 * a different tab. Sending `--permission-mode` at spawn and `set_model` right
 * after the handshake overwrites the surviving truth before the first
 * `system/init` can report it — which is how a session the user left at `ask`
 * comes back running `acceptEdits`.
 *
 * A FRESH spawn is the opposite case: there is no prior posture to protect, so
 * the requested one must ride the spawn exactly as before.
 */
describe("connect: a resume applies no posture ahead of the first system/init (cut §1.5 hazard (б))", () => {
  it("resume sends NO --permission-mode flag, even with a persisted preset", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await resumeClaudeEngine({
      ...baseOptions(spawnImpl),
      externalSessionRef: "persisted-ref-1",
      selection: { model: "model-a", presetId: "workspace", origin: "persisted" },
    });
    try {
      expect(capturedArgs()).not.toContain("--permission-mode");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("resume sends NO set_model, even with a persisted model the catalog knows", async () => {
    const { spawnImpl, controlSubtypes } = fakeSpawn();
    const connected = await resumeClaudeEngine({
      ...baseOptions(spawnImpl),
      externalSessionRef: "persisted-ref-2",
      selection: { model: "model-a", presetId: "workspace", origin: "persisted" },
    });
    try {
      expect(controlSubtypes()).not.toContain("set_model");
      // The handshake itself still happens — this is about POSTURE, not about
      // skipping the connect protocol.
      expect(controlSubtypes()).toContain("initialize");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a FRESH spawn still carries the requested posture on the wire (the behaviour resume suppresses)", async () => {
    const { spawnImpl, capturedArgs, controlSubtypes } = fakeSpawn();
    const connected = await startClaudeEngine({
      ...baseOptions(spawnImpl),
      selection: { model: "model-a", presetId: "workspace", origin: "draft" },
    });
    try {
      const args = capturedArgs()!;
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
      expect(controlSubtypes()).toContain("set_model");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a resume whose persisted model is no longer in the catalog degrades quietly to a provisional default", async () => {
    const { spawnImpl, controlSubtypes } = fakeSpawn();
    const connected = await resumeClaudeEngine({
      ...baseOptions(spawnImpl),
      externalSessionRef: "persisted-ref-3",
      selection: { model: "model-gone", presetId: "ask", origin: "persisted" },
    });
    try {
      expect(connected.model).toBe("model-a");
      // Still nothing sent: the real model arrives with the first system/init.
      expect(controlSubtypes()).not.toContain("set_model");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

/**
 * A live handshake against a signed-in subscription profile (binary 2.1.215)
 * returns an `initialize` `account` with NO `tokenSource` key at all — its
 * keys are exactly `email`/`organization`/`subscriptionType`/`apiProvider`.
 * The predicate must fall back to `subscriptionType` in that case, matching
 * `isClaudeSignedIn` in main/claude-doctor.ts.
 */
describe("connect: sign-in detection from the initialize response", () => {
  it("an account with no tokenSource key but a subscriptionType boots successfully (signed-in subscription profile)", async () => {
    const { spawnImpl } = fakeSpawn({
      email: "user@example.com",
      organization: "example-org",
      subscriptionType: "pro",
      apiProvider: "anthropic",
    });
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    await connected.engine.dispose("session-close");
  });

  it("tokenSource: \"none\" refuses the boot with CLAUDE_NOT_SIGNED_IN", async () => {
    const { spawnImpl } = fakeSpawn({ tokenSource: "none" });
    await expect(startClaudeEngine(baseOptions(spawnImpl))).rejects.toThrow(CLAUDE_NOT_SIGNED_IN);
  });

  it("an account with neither tokenSource nor subscriptionType refuses the boot with CLAUDE_NOT_SIGNED_IN", async () => {
    const { spawnImpl } = fakeSpawn({ email: "user@example.com", organization: "example-org" });
    await expect(startClaudeEngine(baseOptions(spawnImpl))).rejects.toThrow(CLAUDE_NOT_SIGNED_IN);
  });
});

/**
 * срез S4 — the MCP bridge's own ordering requirement (probes.md
 * P0's correction #1): `ClaudeMcpBridge` must be routed through
 * `ClaudeApprovalBridge` BEFORE `client.initialize()` is ever sent, because
 * the CLI drives its OWN mcp handshake (`mcp_message` control_requests) FROM
 * INSIDE our outbound `initialize` call, before it answers ours. A bridge
 * wired any later (e.g. a plausible-looking "only attach the door once the
 * session finished initializing" refactor) would still exist by the time
 * `startClaudeEngine` returns, but would have already missed that nested
 * handshake — which is exactly the failure mode a "the option is set" check
 * cannot see, and this test can: it inspects what the fake CLI's OWN nested
 * request received, not what the finished engine looks like afterward.
 */
describe("срез S4 — the MCP bridge is wired BEFORE initialize is sent (probes.md P0)", () => {
  /** A minimal stand-in satisfying exactly what ClaudeApprovalBridge.route reads off `options.bridge` — never a real MCP round trip (that is mcp-bridge.test.ts's job). */
  function fakeBridge(): { bridge: ClaudeMcpBridge; routedCount: () => number } {
    let routed = 0;
    const bridge = {
      announceOn: (extra: Record<string, unknown> = {}) => ({ ...extra, sdkMcpServers: ["anycode"] }),
      handleControlRequest: async (_request: unknown, responder: { success(response?: unknown): void }) => {
        routed += 1;
        responder.success();
      },
    } as unknown as ClaudeMcpBridge;
    return { bridge, routedCount: () => routed };
  }

  it("the CLI's own nested mcp_message handshake, arriving INSIDE our outbound initialize call, is routed to the bridge and answered success — not fail-closed", async () => {
    const { spawnImpl, nestedMcpResponse, capturedSdkMcpServers } = fakeSpawn();
    const { bridge, routedCount } = fakeBridge();
    const connected = await startClaudeEngine({ ...baseOptions(spawnImpl), mcpBridge: bridge });
    try {
      // The switch (plan §5 S4 p.7) held: a bridge was supplied, so `announceOn()`
      // rode the wire.
      expect(capturedSdkMcpServers()).toEqual(["anycode"]);
      // The load-bearing assertion: the nested request that arrived DURING our
      // outbound initialize call was answered `success` (routed to the bridge),
      // never the fail-closed "AnyCode does not handle" error `route()` sends
      // for `mcp_message` when `options.bridge` is `undefined` at that moment.
      expect(nestedMcpResponse()?.subtype).toBe("success");
      expect(routedCount()).toBe(1);
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("no mcpBridge option at all: initialize carries no sdkMcpServers, and the CLI never even attempts the nested handshake (switch, byte-identical to pre)", async () => {
    const { spawnImpl, nestedMcpResponse, capturedSdkMcpServers } = fakeSpawn();
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      expect(capturedSdkMcpServers()).toBeUndefined();
      expect(nestedMcpResponse()).toBeUndefined();
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a REAL bridge's notification ack rides the full wire envelope written by ClaudeClient — response is an object, never absent", async () => {
    // Unlike fakeBridge() above, this drives the real `ClaudeMcpBridge` +
    // `ClaudeClient` pair end to end: the fake CLI's nested
    // `notifications/initialized` (the exact message whose empty-body answer
    // broke CLI 2.1.288+'s SDK MCP connect) is answered by the real bridge
    // and the envelope actually WRITTEN to the child's stdin is inspected.
    const { spawnImpl, nestedMcpResponse, capturedSdkMcpServers } = fakeSpawn();
    const bridge = new ClaudeMcpBridge({
      serverName: "anycode",
      version: "0.0.1",
      listTools: () => [],
      callTool: () => Promise.reject(new Error("no tool calls in this test")),
    });
    const connected = await startClaudeEngine({ ...baseOptions(spawnImpl), mcpBridge: bridge });
    try {
      expect(capturedSdkMcpServers()).toEqual(["anycode"]);
      const nested = nestedMcpResponse();
      expect(nested?.subtype).toBe("success");
      expect(nested?.response).toEqual({ mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } });
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

// the PUBLIC wrappers (startClaudeEngine/resumeClaudeEngine) must
// not drop the child's turn budget — options.maxTurns has to reach the actual
// ClaudeClient spawn argv as --max-turns <n> on BOTH the fresh and the resume
// path (claude-engine.ts spreads ...options into ClaudeClient).
describe("startClaudeEngine/resumeClaudeEngine — maxTurns forwarding", () => {
  it("startClaudeEngine carries options.maxTurns onto the spawn argv as --max-turns <n>", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine({ ...baseOptions(spawnImpl), maxTurns: 14 });
    try {
      const args = capturedArgs() ?? [];
      expect(args).toContain("--max-turns");
      expect(args[args.indexOf("--max-turns") + 1]).toBe("14");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("resumeClaudeEngine carries options.maxTurns onto the spawn argv too", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await resumeClaudeEngine({ ...baseOptions(spawnImpl), maxTurns: 6, externalSessionRef: "ref-180" });
    try {
      const args = capturedArgs() ?? [];
      expect(args).toContain("--resume");
      expect(args).toContain("--max-turns");
      expect(args[args.indexOf("--max-turns") + 1]).toBe("6");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("without options.maxTurns the spawn argv has no --max-turns flag", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      expect(capturedArgs() ?? []).not.toContain("--max-turns");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});

/**
 * cross-review M2, wiring level: the delegation sentence
 * (`mcp__anycode__agent`) may appear on the spawn argv ONLY in a session
 * whose bridge is announced. `connectClaudeEngine` enforces the pairing even
 * against a confused caller (agentBridgePrompt without mcpBridge → plain
 * always-on block), and both a bridge-less boot and the pairing failure are
 * byte-identical to the pre-4056 argv.
 */
describe("agentBridgePrompt rides the argv only when the bridge is announced (M2)", () => {
  const promptAt = (args: string[] | undefined): string | undefined => {
    const list = args ?? [];
    const at = list.indexOf("--append-system-prompt");
    return at === -1 ? undefined : list[at + 1];
  };

  it("a boot with NO bridge never names mcp__anycode__agent in --append-system-prompt", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      expect(promptAt(capturedArgs())).not.toContain("mcp__anycode__agent");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("a boot with the bridge AND the prompt appends the sentence after the always-on block", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const bridge = {
      announceOn: (extra: Record<string, unknown> = {}) => ({ ...extra, sdkMcpServers: ["anycode"] }),
      handleControlRequest: async (_request: unknown, responder: { success(response?: unknown): void }) => {
        responder.success();
      },
    } as unknown as ClaudeMcpBridge;
    const connected = await startClaudeEngine({
      ...baseOptions(spawnImpl),
      mcpBridge: bridge,
      agentBridgePrompt: "To delegate, call mcp__anycode__agent. BRIDGE-SENTINEL",
    });
    try {
      const prompt = promptAt(capturedArgs()) ?? "";
      expect(prompt).toContain("BRIDGE-SENTINEL");
      expect(prompt.indexOf("IMPORTANT SURFACE CORRECTION")).toBeLessThan(prompt.indexOf("BRIDGE-SENTINEL"));
      expect(prompt).toContain("mcp__anycode__agent");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("the pairing gate: agentBridgePrompt WITHOUT mcpBridge is stripped (never name an unannounced tool)", async () => {
    const { spawnImpl, capturedArgs } = fakeSpawn();
    const connected = await startClaudeEngine({ ...baseOptions(spawnImpl), agentBridgePrompt: "To delegate, call mcp__anycode__agent. BRIDGE-SENTINEL" });
    try {
      expect(promptAt(capturedArgs())).not.toContain("BRIDGE-SENTINEL");
      expect(promptAt(capturedArgs())).not.toContain("mcp__anycode__agent");
    } finally {
      await connected.engine.dispose("session-close");
    }
  });
});


// C8/C9/C10/C12/C14: end to end through the REAL
// ClaudeMcpBridge + REAL createEngineBrowserBridge — the door's browser
// tools/call drives the same approval and preview contract as a live tab;
// a recording fake broker stands in for the UI side of IpcPermissionBroker.
describe("— browser tools through the engine door (C8/C9/C10/C12/C14)", () => {
  /** A fake IpcPermissionBroker: records asks, settle-on-demand. */
  function fakeBroker() {
    const requests: Array<{ toolName: string; toolCallId: string; input: unknown }> = [];
    const parked = new Map<string, (decision: { behavior: string; reason?: string }) => void>();
    const broker = new IpcPermissionBroker(() => {}) as never as InstanceType<typeof IpcPermissionBroker>;
    (broker as unknown as { requestPermission: unknown }).requestPermission = (request: { toolName: string; toolCallId: string; input: unknown }) => {
      requests.push(request);
      return new Promise((resolve) => { parked.set(request.toolCallId, resolve as never); });
    };
    return {
      broker,
      requests,
      settle: (toolCallId: string, decision: { behavior: string; reason?: string }) => {
        parked.get(toolCallId)?.(decision);
        parked.delete(toolCallId);
      },
    };
  }

  function makeDoor(broker: unknown, previewControl: (req: unknown, opts: unknown) => Promise<unknown>) {
    const browser = createEngineBrowserBridge({
      preview: { control: previewControl } as never,
      fullAccess: () => false,
      broker: broker as never,
      cwd: "/work",
    });
    const door = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], browser, onEvent: () => {} });
    const bridge = new ClaudeMcpBridge({ serverName: "anycode", version: "0.0.1", listTools: door.listTools, callTool: door.callTool });
    return { bridge, browser };
  }

  function toolsCall(id: number, name: string, args: Record<string, unknown>, toolUseId: string): Record<string, unknown> {
    return { server_name: "anycode", message: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } } } };
  }

  async function driveCall(bridge: ClaudeMcpBridge, params: Record<string, unknown>): Promise<void> {
    await bridge.handleControlRequest(
      { requestId: "r", subtype: "mcp_message", signal: new AbortController().signal, request: params } as never,
      { success: () => {}, error: (error: string) => { throw new Error(error); } } as never,
    );
  }

  it("C8: a remote navigate parks exactly ONE BrowserNavigate ask; deny -> error result, port untouched; allow -> port gets allowRemote:true", async () => {
    // Deny path
    const deniedBroker = fakeBroker();
    const denyPort: Array<unknown> = [];
    const denied = makeDoor(deniedBroker.broker, async (req, opts) => { denyPort.push({ req, opts }); return { ok: true, value: { previewId: "p1", url: "u", text: "ok" } }; });
    const denyHandle = driveCall(denied.bridge, toolsCall(1, "browser_navigate", { url: "https://example.com/" }, "toolu_d"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deniedBroker.requests).toHaveLength(1);
    expect(deniedBroker.requests[0]?.toolName).toBe("BrowserNavigate");
    expect(deniedBroker.requests[0]?.input).toMatchObject({ url: "https://example.com/" });
    expect(denyPort).toHaveLength(0);
    deniedBroker.settle(deniedBroker.requests[0]!.toolCallId, { behavior: "deny", reason: "not today" });
    await denyHandle;
    expect(denyPort).toHaveLength(0);

    // Allow path
    const allowBroker = fakeBroker();
    const allowPort: Array<{ opts: unknown }> = [];
    const allowed = makeDoor(allowBroker.broker, async (req, opts) => { allowPort.push({ opts }); return { ok: true, value: { previewId: "p1", url: "u", text: "ok" } }; });
    const allowHandle = driveCall(allowed.bridge, toolsCall(2, "browser_navigate", { url: "https://example.com/" }, "toolu_a"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    allowBroker.settle(allowBroker.requests[0]!.toolCallId, { behavior: "allow" });
    await allowHandle;
    expect(allowPort).toHaveLength(1);
    expect((allowPort[0]?.opts as { allowRemote?: boolean }).allowRemote).toBe(true);
  });

  it("C9: a localhost navigate parks ZERO permission requests", async () => {
    const broker = fakeBroker();
    const door = makeDoor(broker.broker, async () => ({ ok: true, value: { previewId: "p1", url: "u", text: "ok" } }));
    await driveCall(door.bridge, toolsCall(3, "browser_navigate", { url: "http://localhost:3000/" }, "toolu_l"));
    expect(broker.requests).toHaveLength(0);
  });

  it("C10: denyAll-style Stop settles a parked browser approval with an error and leaves no pending entry", async () => {
    const broker = fakeBroker();
    const port: unknown[] = [];
    const browser = createEngineBrowserBridge({
      preview: { control: async () => { port.push(1); return { ok: true, value: { previewId: "p1", url: "u", text: "ok" } }; } } as never,
      fullAccess: () => false,
      broker: broker.broker as never,
      cwd: "/work",
    });
    const spec = browser.byClaudeName("browser_navigate")!;
    const pending = browser.call(spec, { url: "https://example.com/" }, new AbortController().signal, "toolu_stop");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(broker.requests).toHaveLength(1);
    broker.settle(broker.requests[0]!.toolCallId, { behavior: "deny", reason: "Claude turn was cancelled" });
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.status).toBe("denied");
    expect(result.text).toContain("Claude turn was cancelled");
    expect(port).toHaveLength(0);
  });

  it("C12: two sequential browser calls reuse the same preview (previewId pass-through, no bridge state)", async () => {
    const broker = fakeBroker();
    const seen: Array<unknown> = [];
    const door = makeDoor(broker.broker, async (req) => { seen.push((req as { previewId?: string }).previewId); return { ok: true, value: { previewId: "p1", url: "u", text: "ok" } }; });
    await driveCall(door.bridge, toolsCall(4, "browser_navigate", { url: "http://localhost:3000/a", preview_id: "p1" }, "toolu_a1"));
    await driveCall(door.bridge, toolsCall(5, "browser_navigate", { url: "http://localhost:3000/b", preview_id: "p1" }, "toolu_b1"));
    expect(seen).toEqual(["p1", "p1"]);
  });

  it("C14: hostile tool args are rejected by zod without throwing", async () => {
    const broker = fakeBroker();
    const door = makeDoor(broker.broker, async () => ({ ok: true, value: { previewId: "p1", url: "u", text: "ok" } }));
    const hostile: Array<Record<string, unknown>> = [
      { url: "http://localhost:3000/", __proto__: {} },
      { url: "http://localhost:3000/", text: "x".repeat(200_000) },
    ];
    for (const [index, args] of hostile.entries()) {
      // driveCall resolves void on success; hostile args are parsed by zod
      // (stripped or failed) and NEVER throw out of the door.
      await driveCall(door.bridge, toolsCall(6 + index, "browser_navigate", args, `toolu_h${index}`));
    }
  });
});

function forwardResolver(dir: string, paths: string[]) {
  return async () => {
    if (paths.length) expect(existsSync(paths.at(-1)!)).toBe(false);
    const file = materializeMcpForwardFile('{"mcpServers":{"sample":{"command":"node"}}}', { tmpDir: dir, pid: process.pid });
    paths.push(file.path);
    return { claudeConfigPath: file.path, notices: [], cleanupFile: () => rmSync(file.path, { force: true }) };
  };
}

it.each([false, true])("replaces an idle transport after fresh/resume boot (%s)", async (resume) => {
  const fake = fakeSpawn(), dir = mkdtempSync(join(tmpdir(), "claude-replace-")), paths: string[] = [];
  const options = { ...baseOptions(fake.spawnImpl), resolveMcpForward: forwardResolver(dir, paths),
    mcpBridge: new ClaudeMcpBridge({ serverName: "anycode", version: "1", listTools: () => [], callTool: async () => ({ text: "ok", isError: false }) }) };
  const { engine, sessionRef } = await (resume ? resumeClaudeEngine({ ...options, externalSessionRef: "native-ref" }) : startClaudeEngine(options));
  try {
    const inits: unknown[] = [];
    engine.onEverySystemInit(init => inits.push(init));
    await expect(engine.replaceTransport({ resume: "other-ref" })).rejects.toThrow("identity");
    await engine.selectPreset("workspace");
    const snapshot = engine.snapshot();
    await engine.replaceTransport({ resume: sessionRef });
    expect(paths).toHaveLength(2);
    expect(paths[1]).not.toBe(paths[0]);
    expect(existsSync(paths[0]!)).toBe(false);
    expect(statSync(paths[1]!).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths[1]!, "utf8")).toContain('"sample"');
    expect(fake.capturedArgs()).toContain(sessionRef);
    expect(fake.capturedArgs()).not.toContain("--permission-mode");
    expect(engine.snapshot()).toEqual(snapshot);
    expect(fake.nestedMcpResponse()?.subtype).toBe("success");
    const emit = (index: number, frame: unknown) => fake.streams[index]!.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
    emit(0, { type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"], model: "old", permissionMode: "plan" });
    await new Promise(setImmediate);
    expect(inits).toHaveLength(0);
    emit(1, { type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"], model: "model-a", permissionMode: "acceptEdits" });
    await new Promise(setImmediate);
    expect(inits).toHaveLength(1);
    emit(1, { type: "control_request", request_id: "ask", request: { subtype: "can_use_tool", tool_name: "UnknownTool", tool_use_id: "tool", input: {} } });
    await new Promise(setImmediate);
    expect(options.broker.pendingCount).toBe(1);
    await expect(engine.replaceTransport({ resume: sessionRef })).rejects.toThrow("not ready");
  } finally {
    await engine.dispose("session-close");
    expect(options.broker.pendingCount).toBe(0);
    expect(paths.every(path => !existsSync(path))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["complete", "return"] as const)("reserves transport before turn_start and releases it on %s", async finish => {
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  const started = vi.fn();
  const fake = fakeSpawn(undefined, undefined, undefined, { wait, started });
  const { engine, sessionRef } = await startClaudeEngine(baseOptions(fake.spawnImpl));
  const onInputNotSent = vi.fn();
  const turn = engine.runTurn("first", { signal: new AbortController().signal, onInputNotSent })[Symbol.asyncIterator]();
  let replacing: Promise<void> | undefined;
  try {
    expect((await turn.next()).value).toMatchObject({ type: "turn_start" });
    // Closing the old process would park until release. A suspended turn must
    // reject replacement before that close can retire its notification stream.
    await expect(engine.replaceTransport({ resume: sessionRef })).rejects.toThrow("not ready");
    expect(started).not.toHaveBeenCalled();
    expect(fake.streams).toHaveLength(1);
    if (finish === "return") {
      await turn.return!();
      expect(onInputNotSent).toHaveBeenCalledTimes(1);
      expect(fake.userMessages).toHaveLength(0);
    } else {
      const completed = (async () => {
        const events = [];
        for (;;) { const next = await turn.next(); if (next.done) return events; events.push(next.value); }
      })();
      await vi.waitFor(() => expect(fake.userMessages).toHaveLength(1));
      fake.streams[0]!.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: sessionRef, result: "done", is_error: false }) + "\n"));
      const events = await completed;
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(onInputNotSent).not.toHaveBeenCalled();
    }
    // The turn's finally releases ownership, including iterator.return() at
    // the first yield. Replacement now closes the old process and can finish.
    replacing = engine.replaceTransport({ resume: sessionRef });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    expect(fake.streams).toHaveLength(1);
    release();
    await replacing;
    expect(fake.streams).toHaveLength(2);
    const beforeRetry = fake.userMessages.length;
    const retried = (async () => {
      const events = [];
      for await (const event of engine.runTurn("retry", { signal: new AbortController().signal })) events.push(event);
      return events;
    })();
    await vi.waitFor(() => expect(fake.userMessages).toHaveLength(beforeRetry + 1));
    fake.streams[1]!.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: sessionRef, result: "done", is_error: false }) + "\n"));
    const events = await retried;
    expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    expect(events.some(event => event.type === "error")).toBe(false);
  } finally {
    release();
    await replacing?.catch(() => {});
    await turn.return!();
    await engine.dispose("session-close");
  }
});

it("respawns an idle exited child with resume and delivers through the real client", async () => {
  const fake = fakeSpawn();
  const children: EventEmitter[] = [];
  const spawnImpl = (command: string, args: readonly string[]) => {
    const child = fake.spawnImpl(command, args) as EventEmitter;
    if (!args.includes("--version")) children.push(child);
    return child;
  };
  const { engine, sessionRef } = await resumeClaudeEngine({ ...baseOptions(spawnImpl), externalSessionRef: "idle-session" });
  try {
    children[0]!.emit("close", 17, "SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 0));
    const events: import("@anycode/core").AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("deliver after death", { signal: new AbortController().signal })) events.push(event);
    })();
    await vi.waitFor(() => expect(fake.userMessages).toHaveLength(1));
    expect(children).toHaveLength(2);
    expect(fake.capturedArgs()).toContain("--resume");
    expect(fake.capturedArgs()).toContain(sessionRef);
    fake.streams[1]!.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: sessionRef, result: "done", is_error: false }) + "\n"));
    await turn;
    expect(events.some(event => event.type === "error")).toBe(false);
  } finally { await engine.dispose("session-close"); }
});

it("routes the explicit restart action after an idle resume failure without replaying the draft", async () => {
  const fake = fakeSpawn();
  let child: EventEmitter | undefined;
  let spawns = 0;
  const spawnImpl = (command: string, args: readonly string[]) => {
    if (!args.includes("--version") && ++spawns === 2) throw new Error("spawn refused");
    const result = fake.spawnImpl(command, args);
    if (!args.includes("--version")) child = result as EventEmitter;
    return result;
  };
  const { engine } = await resumeClaudeEngine({ ...baseOptions(spawnImpl), externalSessionRef: "idle-session" });
  const h = createHarness({ steps: [], engine });
  try {
    h.send({ type: "ui_ready" });
    await h.waitFor(m => m.type === "host_ready");
    child!.emit("close", 17, "SIGTERM");
    h.send({ type: "user_message", requestId: "unsent", text: "keep the draft" });
    await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "error"));
    await h.waitUntil(() => h.received.some(m => m.type === "turn_rejected" && m.reason === "input_not_sent"));
    await h.flush();
    expect(fake.userMessages).toEqual([]);
    h.send({ type: "claude_restart_request" });
    await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.startsWith("Claude restarted")));
    expect(spawns).toBe(3);
    expect(fake.userMessages).toEqual([]);
  } finally { await h.session.shutdown(); h.close(); }
});

it("restores input submitted during replacement and serves a retried turn on the new transport", async () => {
  const fake = fakeSpawn();
  let release!: () => void;
  let resolving!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { resolving = done; });
  let resolutions = 0;
  const { engine, sessionRef } = await startClaudeEngine({ ...baseOptions(fake.spawnImpl), resolveMcpForward: async () => {
    if (resolutions++ > 0) { resolving(); await gate; }
    return { claudeConfigPath: null, notices: [], cleanupFile: () => {} };
  } });
  const store = new SqlitePersistenceAdapter(":memory:");
  await store.createSession({ id: "test-session", workspace: process.cwd(), engineId: "claude", externalSessionRef: sessionRef, model: "model-a", mode: "build" });
  const history = new RuntimeSessionHistory(store, "test-session");
  const resetInput = vi.spyOn(store, "resetRuntimeInput");
  const h = createHarness({ steps: [], engine, runtimeHistory: history });
  let replaced: Promise<void> | undefined;
  try {
    h.send({ type: "ui_ready" });
    await h.waitFor(m => m.type === "host_ready");
    replaced = engine.replaceTransport({ resume: sessionRef });
    await entered;
    const renderer = createDesktopStore({ schedule: fn => fn() });
    for (const message of h.received) renderer.getState().applyHostMessage(message);
    const offset = h.received.length;
    renderer.getState().recordSentMessage("keep my draft", [], "during-restart");
    renderer.getState().appendUserText("during-restart", "keep my draft");
    h.send({ type: "user_message", requestId: "during-restart", text: "keep my draft" });
    const recovery = await h.waitFor(m => m.type === "runtime_input_recovery");
    if (recovery.type !== "runtime_input_recovery") throw new Error("missing input recovery");
    expect(recovery).toMatchObject({ text: "keep my draft", status: "pending" });
    expect(resetInput).toHaveBeenCalledTimes(1);
    expect(fake.userMessages).toEqual([]);
    expect(h.received).toContainEqual(expect.objectContaining({ type: "agent_event", event: expect.objectContaining({ type: "engine_notice", message: expect.stringContaining("restarting") }) }));
    expect(h.received.some(m => m.type === "fatal" || (m.type === "agent_event" && m.event.type === "error"))).toBe(false);
    await h.flush();
    expect(resetInput).toHaveBeenCalledWith("test-session", expect.any(String), recovery.turnId);
    expect(history.recoveries()).toMatchObject([{ turnId: recovery.turnId, state: "pending" }]);
    expect(h.received).toContainEqual({ type: "turn_rejected", requestId: "during-restart", reason: "input_not_sent", runtimeRecoveryTurnId: recovery.turnId });
    for (const message of h.received.slice(offset)) renderer.getState().applyHostMessage(message);
    expect(renderer.getState().promptQueue).toMatchObject([{ id: "during-restart", text: "keep my draft", requiresRestore: true, runtimeRecoveryTurnId: recovery.turnId }]);
    release();
    await replaced;
    expect(fake.streams).toHaveLength(2);
    h.send({ type: "runtime_input_discard", turnId: recovery.turnId });
    await h.flush();
    h.send({ type: "user_message", requestId: "retry", text: "keep my draft" });
    await vi.waitFor(() => expect(fake.userMessages).toHaveLength(1));
    fake.streams[1]!.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: sessionRef, result: "done", is_error: false }) + "\n"));
    await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end" && m.event.reason === "completed"));
    expect(h.received.some(m => m.type === "fatal" || (m.type === "agent_event" && m.event.type === "error"))).toBe(false);
  } finally {
    release();
    await replaced;
    await h.session.shutdown(); h.close(); await store.close();
  }
});

it.each(["resolver", "initialize"])("distinguishes replacement handshake timeout from retirement during %s", async stage => {
  const initialization = { hold: false };
  const fake = fakeSpawn(undefined, undefined, initialization);
  let release!: () => void;
  let resolving!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { resolving = done; });
  let resolutions = 0;
  const { engine, sessionRef } = await startClaudeEngine({ ...baseOptions(fake.spawnImpl), resolveMcpForward: async () => {
    if (resolutions++ > 0) { resolving(); if (stage === "resolver") await gate; }
    return { claudeConfigPath: null, notices: [], cleanupFile: () => {} };
  } });
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    initialization.hold = stage === "initialize";
    const replaced = engine.replaceTransport({ resume: sessionRef });
    const failed = expect(replaced).rejects.toMatchObject({ code: "claude_transport_timeout", message: "Claude transport handshake timed out" });
    await entered;
    await new Promise(setImmediate);
    expect(fake.streams).toHaveLength(stage === "initialize" ? 2 : 1);
    await vi.advanceTimersByTimeAsync(CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS);
    await failed;
  } finally {
    vi.useRealTimers(); release(); await engine.dispose("session-close");
  }
});

it.each(["resolver", "constructor", "initialize", "dispose"])("cleans replacement failures: %s", async (failure) => {
  const account = { tokenSource: "oauth" };
  const fake = fakeSpawn(account), dir = mkdtempSync(join(tmpdir(), "claude-failure-")), paths: string[] = [];
  const resolve = forwardResolver(dir, paths);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const options = { ...baseOptions(fake.spawnImpl), notificationHighWater: 512,
    resolveMcpForward: async () => {
      if (paths.length && failure === "resolver") throw new Error("resolver failed");
      if (paths.length && failure === "dispose") await gate;
      return resolve();
    } };
  const { engine, sessionRef } = await startClaudeEngine(options);
  try {
    if (failure === "constructor") options.notificationHighWater = 1;
    if (failure === "initialize") account.tokenSource = "none";
    const replacing = engine.replaceTransport({ resume: sessionRef });
    const replaced = failure === "dispose"
      ? expect(replacing).rejects.toMatchObject({ code: "claude_transport_retired", message: "Claude transport retired" })
      : expect(replacing).rejects.toThrow();
    await new Promise(setImmediate);
    if (failure === "dispose") { await engine.dispose("session-close"); release(); await new Promise(setImmediate); }
    await replaced;
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(fake.streams).toHaveLength(failure === "initialize" ? 2 : 1);
  } finally { await engine.dispose("session-close"); rmSync(dir, { recursive: true, force: true }); }
});

// Synthetic lifecycle coverage grants no production capability qualification.

it.each(["fresh", "fresh-materialized", "resume", "candidate"])("restores external MCP through OFF/ON/OFF (%s)", async kind => {
  const fake = fakeSpawn(), dir = mkdtempSync(join(tmpdir(), "claude-overlay-")), paths: string[] = [];
  const json = '{"mcpServers":{"sample":{"command":"node"}}}';
  let failure = "", changed = false, incomplete = false, missing = false, badReadback = false;

  const resolveMcpForward = vi.fn(async () => {
    if (failure) throw new Error(failure);
    const file = materializeMcpForwardFile(changed ? json.replaceAll("sample", "other") : json, { tmpDir: dir, pid: process.pid });
    paths.push(file.path);
    return { claudeConfigPath: file.path, claudeJson: changed ? json.replaceAll("sample", "other") : json,
      claudeNames: missing ? [] : [changed ? "other" : "sample"], loaderProblems: incomplete ? ["load failed"] : [], forwardProblems: [], notices: [],
      cleanupFile: () => rmSync(file.path, { force: true }) };
  });
  const availability = vi.spyOn(overlayPolicy, "claudeOrchestrationAvailability").mockReturnValue({ supported: true });
  const prepare = vi.spyOn(overlayPolicy, "prepareClaudeOrchestrationSpawn").mockReturnValue({ version: "synthetic", permissionMode: "default" });
  const spawn = vi.spyOn(overlayPolicy, "claudeOrchestrationSpawnOptions").mockReturnValue({ permissionModeFlag: "manual", enableSlashPassthrough: false,
    settingSources: "", mcpConfig: '{"mcpServers":{}}', tools: "Read,Glob,Grep", settings: '{"disableAllHooks":true}', appendPrompt: orchestrationDeveloperBlock("claude") });
  let engine: Awaited<ReturnType<typeof startClaudeEngine>>["engine"] | undefined;
  try {
    const options = { ...baseOptions(fake.spawnImpl), resolveMcpForward, orchestrationFeatureEnabled: true,
      mcpBridge: new ClaudeMcpBridge({ serverName: "anycode", version: "1", listTools: () => ["agent", "agent_status"].map(name => ({
        name, description: name, inputSchema: { type: "object" as const, properties: {} } })), callTool: async () => ({ text: "ok", isError: false }) }),
      orchestrationEvidence: { version: "synthetic", facts: {}, readPosture: async () => {
        const on = fake.capturedArgs()?.includes("--tools");
        return { session_id: engine!.sessionRef, model: "model-a", permissionMode: on ? badReadback ? "plan" : "default" : engine!.activePresetId === "workspace" ? "acceptEdits" : "default",
          claude_code_version: "synthetic", tools: [...overlayPolicy.CLAUDE_ORCHESTRATION_TOOLS, ...(!on ? ["Bash", "Write"] : [])], skills: [], slash_commands: [],
          mcp_servers: on ? [{ name: "anycode" }] : [{ name: "sample" }, { name: "anycode" }] } as unknown as ClaudeSystemInitMessage;
      } } };
    const connected = kind === "resume" ? await resumeClaudeEngine({ ...options, externalSessionRef: "native-ref" })
      : kind === "candidate" ? await prepareSwitchRuntime({ engine: "claude", model: "model-a", options }) : await startClaudeEngine(options);
    engine = connected.engine as Awaited<ReturnType<typeof startClaudeEngine>>["engine"];
    const policy = engine.orchestrationPolicy!, authority = {};
    expect(policy.availability().supported).toBe(true);
    await engine.selectPreset("workspace");
    // An active approval makes the idle engine unavailable before any stop.
    fake.streams[0]!.emit("data", Buffer.from(JSON.stringify({ type: "control_request", request_id: "busy", request: {
      subtype: "can_use_tool", tool_name: "Unknown", tool_use_id: "busy-tool", input: {} } }) + "\n"));
    await new Promise(setImmediate);
    await expect(policy.apply(true, authority)).rejects.toThrow("unavailable");
    expect(fake.streams).toHaveLength(1);
    options.broker.denyAll("test settled", "turn_cancelled");
    await new Promise(setImmediate);
    await engine.selectPreset("workspace");
    const before = engine.snapshot();
    expect(policy.nativeBase?.()).toBeUndefined();
    await policy.apply(true, authority);
    const durable = policy.nativeBase!();
    expect(durable).toMatchObject({ version: 1, engine: "claude", preset: "workspace", permissionMode: "acceptEdits", model: before.model, mcpDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(durable)).not.toContain(dir);
    if (durable?.engine === "claude") durable.tools.push("Mutated");
    expect(policy.nativeBase!()).not.toEqual(durable);
    expect(engine.orchestrationState).toBe("on");
    await expect(engine.verifyOrchestrationOff()).rejects.toThrow("not verified");
    expect(existsSync(paths[0]!)).toBe(false);
    expect(fake.capturedArgs()).toContain(kind === "resume" ? "--resume" : "--session-id");
    expect(fake.capturedArgs()).not.toContain(paths[0]);
    expect(fake.capturedArgs()).toContain('{"mcpServers":{}}');
    expect(fake.capturedArgs()).toContain("--append-system-prompt");
    expect(fake.capturedArgs()?.some(arg => arg.includes(orchestrationDeveloperBlock("claude")))).toBe(true);
    expect(resolveMcpForward).toHaveBeenCalledTimes(1);
    expect((await engine.selectPreset("workspace")).ok).toBe(false);
    if (kind !== "fresh") {
      const events = (async () => { for await (const _ of engine!.runTurn("owner payload", {
        signal: new AbortController().signal, systemContext: "ephemeral reminder sentinel" })) { /* drain */ } })();
      for (let i = 0; i < 100 && !fake.userMessages.length; i++) await new Promise(setImmediate);
      expect(fake.userMessages).toHaveLength(1);
      expect(JSON.stringify(fake.userMessages)).not.toContain("ephemeral reminder sentinel");
      expect(JSON.stringify(fake.userMessages)).not.toContain(orchestrationDeveloperBlock("claude"));
      await expect(policy.apply(false, authority)).rejects.toThrow("unavailable");
      const emit = (frame: unknown) => fake.streams.at(-1)!.emit("data", Buffer.from(JSON.stringify(frame) + "\n"));
      emit({ ...await options.orchestrationEvidence.readPosture(), type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] });
      emit({ type: "result", subtype: "success", session_id: engine.sessionRef, result: "done", total_cost_usd: 0 });
      await events;
    }
    expect(await policy.apply(true, authority)).toEqual({ enabled: true, baseAuthority: authority });
    failure = "resolver failed";
    await expect(policy.apply(false, authority)).rejects.toThrow(failure);
    expect(engine.orchestrationState).toBe("on");
    failure = ""; changed = true;
    await expect(policy.apply(false, authority)).rejects.toThrow("changed");
    expect(existsSync(paths.at(-1)!)).toBe(false);
    changed = false; incomplete = true;
    await expect(policy.apply(false, authority)).rejects.toThrow("incomplete");
    expect(existsSync(paths.at(-1)!)).toBe(false);
    incomplete = false; missing = true;
    await expect(policy.apply(false, authority)).rejects.toThrow("incomplete");
    expect(existsSync(paths.at(-1)!)).toBe(false);
    missing = false;
    expect(await policy.apply(false, authority)).toEqual({ enabled: false, baseAuthority: authority });
    expect(engine.orchestrationState).toBe("off");
    expect(policy.nativeBase!()).toBeUndefined();
    await expect(engine.verifyOrchestrationOff()).resolves.toBeUndefined();
    expect(engine.snapshot()).toEqual(before);
    expect(paths.at(-1)).not.toBe(paths[0]);
    expect(statSync(paths.at(-1)!).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.at(-1)!, "utf8")).toBe(json);
    expect(fake.capturedArgs()).toContain(paths.at(-1));
    expect(fake.capturedArgs()).not.toContain("--tools");
    expect(fake.capturedArgs()?.some(arg => arg.includes(orchestrationDeveloperBlock("claude")))).toBe(false);
    expect(fake.userMessages).toHaveLength(kind === "fresh" ? 0 : 1);
    expect(fake.capturedArgs()).toContain(kind === "fresh" ? "--session-id" : "--resume");
    expect((await engine.selectPreset("workspace")).ok).toBe(true);
    if (kind === "fresh") {
      vi.useFakeTimers();
      const read = vi.spyOn(options.orchestrationEvidence, "readPosture").mockReturnValue(new Promise(() => {}));
      try {
        const pending = policy.apply(true, authority);
        const failed = expect(pending).rejects.toThrow("timed out");
        const notSent = vi.fn();
        for await (const _ of engine.runTurn("pending input", { signal: new AbortController().signal, onInputNotSent: notSent })) { /* drain */ }
        expect(notSent).toHaveBeenCalledOnce();
        expect(fake.userMessages).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS + 1);
        await failed;
        expect(engine.orchestrationState).toBe("off");
        expect(existsSync(paths.at(-1)!)).toBe(true);
      } finally { read.mockRestore(); vi.useRealTimers(); }
    }
    badReadback = true;
    await expect(policy.apply(true, authority)).rejects.toThrow("drift");
    expect(engine.orchestrationState).toBe("quarantined");
    expect(policy.availability().supported).toBe(false);
    expect(paths.every(path => !existsSync(path))).toBe(true);
  } finally {
    await engine?.dispose("session-close");
    availability.mockRestore(); prepare.mockRestore(); spawn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("installs a fail-closed production policy without sending a model payload", async () => {
  const fake = fakeSpawn();
  const { engine } = await startClaudeEngine({ ...baseOptions(fake.spawnImpl), orchestrationFeatureEnabled: true });
  try {
    expect(engine.orchestrationPolicy!.availability()).toMatchObject({ supported: false });
    await expect(engine.orchestrationPolicy!.apply(true, {})).rejects.toThrow("unavailable");
    expect(fake.streams).toHaveLength(1);
    expect(fake.userMessages).toHaveLength(0);
  } finally { await engine.dispose("session-close"); }
});

describe("explicit OFF recovery boot", () => {
  const emptyForward = async () => ({ claudeConfigPath: null, claudeJson: null, claudeNames: [], loaderProblems: [], forwardProblems: [], notices: [], cleanupFile() {} });
  it.each([false, true])("verifies OFF spawn contract before payload with overlay unavailable, resume=%s", async resume => {
    const fake = fakeSpawn();
    const options = { ...baseOptions(fake.spawnImpl), selection: { presetId: "workspace", model: "model-a", origin: "persisted" as const },
      orchestrationRecovery: { nativeBase: { version: 99, engine: "claude", preset: "workspace" } }, resolveMcpForward: emptyForward };
    const { engine } = resume ? await resumeClaudeEngine({ ...options, externalSessionRef: "native-ref" }) : await startClaudeEngine(options);
    try {
      await expect(engine.verifyOrchestrationOff()).resolves.toBeUndefined();
      const args = fake.capturedArgs()!;
      expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
      expect(args).not.toContain("--tools");
      expect(args.join(" ")).not.toContain("Orchestration");
      expect(fake.userMessages).toEqual([]);
      expect(engine.snapshot().activePresetId).toBe("read-only");
      expect(engine.orchestrationPolicy!.availability().supported).toBe(false);
    } finally { await engine.dispose("session-close"); }
    await expect(engine.verifyOrchestrationOff()).rejects.toThrow("not verified");
  });
  it.each(["digest", "loader", "forward"] as const)("uses the recognized native preset and quarantines %s problems after boot", async problem => {
    const { claudeMcpDigest } = await import("../../native-base.js");
    const nativeBase = { version: 1, engine: "claude", model: "model-a", preset: "workspace", permissionMode: "acceptEdits",
      mcpDigest: claudeMcpDigest(await emptyForward()), tools: ["Read", "Bash"] };
    const fake = fakeSpawn();
    const options = { ...baseOptions(fake.spawnImpl), orchestrationRecovery: { nativeBase }, resolveMcpForward: emptyForward };
    const { engine } = await resumeClaudeEngine({ ...options, externalSessionRef: "native-ref" });
    try {
      expect(fake.capturedArgs()![fake.capturedArgs()!.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
      await expect(engine.verifyOrchestrationOff()).resolves.toBeUndefined();
      expect(fake.userMessages).toHaveLength(0);
    } finally { await engine.dispose("session-close"); }
    const refused = fakeSpawn();
    const quarantined = await resumeClaudeEngine({ ...options, ...baseOptions(refused.spawnImpl), externalSessionRef: "native-ref",
      orchestrationRecovery: { nativeBase: { ...nativeBase, ...(problem === "digest" ? { mcpDigest: "f".repeat(64) } : {}) } },
      resolveMcpForward: async () => ({ ...await emptyForward(), loaderProblems: problem === "loader" ? ["invalid config"] : [], forwardProblems: problem === "forward" ? [{ kind: "unusable-entry" as const, server: "broken" }] : [] }) });
    try {
      expect(quarantined.engine.orchestrationState).toBe("quarantined");
      await expect(quarantined.engine.verifyOrchestrationOff()).rejects.toThrow("not verified");
      const notSent = vi.fn();
      for await (const _ of quarantined.engine.runTurn("keep this input", { signal: new AbortController().signal, onInputNotSent: notSent })) { /* drain refusal */ }
      expect(notSent).toHaveBeenCalledOnce();
      expect(refused.userMessages).toHaveLength(0);
    } finally { await quarantined.engine.dispose("session-close"); }
  });
});

// Protocol fixtures exercise lifecycle contracts without qualifying a native version.
async function overlayContractRig() {
  const fixture = JSON.parse(readFileSync(new URL("../../../../scripts/claude-orchestrate-fixture.json", import.meta.url), "utf8"));
  const fake = fakeSpawn();
  let failSpawn = false, holdAck = false;
  const children: EventEmitter[] = [];
  const lateAcks: (() => void)[] = [];
  const spawnImpl = (command: string, args: readonly string[]) => {
    if (failSpawn && !args.includes("--version")) throw new Error("spawn refused");
    const child = fake.spawnImpl(command, args) as EventEmitter & { stdout: FakeStream };
    if (!args.includes("--version")) {
      children.push(child);
      const emit = child.stdout.emit.bind(child.stdout);
      child.stdout.emit = (event: string | symbol, ...args: unknown[]) => {
        if (holdAck && event === "data") {
          const frame = JSON.parse(String(args[0]));
          if (frame.type === "control_response" && frame.response?.response?.models) {
            lateAcks.push(() => emit(event, ...args));
            emit(event, Buffer.from(JSON.stringify({ ...frame, response: { ...frame.response, request_id: "unrelated-ack" } }) + "\n"));
            return true;
          }
        }
        return emit(event, ...args);
      };
    }
    return child;
  };
  const mocks = [
    vi.spyOn(overlayPolicy, "claudeOrchestrationAvailability").mockReturnValue({ supported: true }),
    vi.spyOn(overlayPolicy, "prepareClaudeOrchestrationSpawn").mockReturnValue({ version: fixture.version, permissionMode: "default" }),
    vi.spyOn(overlayPolicy, "claudeOrchestrationSpawnOptions").mockReturnValue({ permissionModeFlag: "manual", enableSlashPassthrough: false,
      settingSources: "", mcpConfig: '{"mcpServers":{}}', tools: "Read,Glob,Grep", settings: '{"disableAllHooks":true}', appendPrompt: "fixture overlay" }),
  ];
  let engine!: Awaited<ReturnType<typeof startClaudeEngine>>["engine"];
  let reads = 0;
  let postureHook: ((init: ClaudeSystemInitMessage, read: number) => Promise<ClaudeSystemInitMessage>) | undefined;
  const readPosture = async () => {
    const on = fake.capturedArgs()!.includes("--tools");
    const init = { ...fixture.frames.init, session_id: engine.sessionRef, model: "model-a",
      permissionMode: on ? "default" : "acceptEdits", tools: [...fixture.frames.init.tools, ...(!on ? ["Bash", "Write"] : [])] } as ClaudeSystemInitMessage;
    const read = ++reads;
    return postureHook ? postureHook(init, read) : init;
  };
  try {
    ({ engine } = await startClaudeEngine({ ...baseOptions(spawnImpl), orchestrationFeatureEnabled: true,
      resolveMcpForward: async () => ({ claudeConfigPath: null, claudeJson: '{"mcpServers":{}}', claudeNames: [], loaderProblems: [], forwardProblems: [], notices: [], cleanupFile: () => {} }),
      mcpBridge: new ClaudeMcpBridge({ serverName: "anycode", version: "1", listTools: () => ["agent", "agent_status"].map(name => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } })), callTool: async () => ({ text: "ok", isError: false }) }),
      orchestrationEvidence: { version: fixture.version, facts: fixture.facts, readPosture } }));
    await engine.selectPreset("workspace");
  } catch (error) { mocks.forEach(mock => mock.mockRestore()); throw error; }
  return { engine, fake, children, lateAcks, policy: engine.orchestrationPolicy!,
    hook: (hook: typeof postureHook) => { postureHook = hook; },
    failSpawn: () => { failSpawn = true; }, holdAck: () => { holdAck = true; },
    close: async () => { await engine.dispose("session-close"); mocks.forEach(mock => mock.mockRestore()); } };
}

it.each([
  ["session_id", "foreign-ref"], ["session_id", undefined], ["model", "foreign-model"],
  ["permissionMode", "plan"], ["claude_code_version", "unknown"], ["mcp_servers", [{ name: "external" }]],
])("refuses base %s drift before stopping the native client", async (key, value) => {
  const r = await overlayContractRig();
  try {
    r.hook(async init => ({ ...init, [key]: value }));
    await expect(r.policy.apply(true, {})).rejects.toThrow("drift");
    expect(r.engine.orchestrationState).toBe("off");
    expect(r.fake.streams).toHaveLength(1);
    expect(r.fake.userMessages).toEqual([]);
    r.hook(undefined);
    await r.policy.apply(true, {});
    await r.policy.apply(false, {});
    expect(r.engine.activePresetId).toBe("workspace");
  } finally { await r.close(); }
});

it.each([
  ["session_id", "foreign-ref"], ["session_id", undefined], ["model", "foreign-model"],
  ["tools", ["Read", "Glob", "Grep", "Bash"]], ["tools", ["Read", "Read", "Grep", "mcp__anycode__agent", "mcp__anycode__agent_status"]],
  ["permissionMode", "acceptEdits"], ["skills", undefined],
])("quarantines unconfirmed replacement %s and blocks user/report dispatch", async (key, value) => {
  const r = await overlayContractRig();
  try {
    r.hook(async (init, read) => read === 2 ? { ...init, [key]: value } : init);
    await expect(r.policy.apply(true, {})).rejects.toThrow("drift");
    expect(r.engine.orchestrationState).toBe("quarantined");
    expect(r.policy.availability().supported).toBe(false);
    await expect(r.policy.apply(false, {})).rejects.toThrow("unavailable");
    for (const input of ["owner draft", "child terminal report"]) {
      const notSent = vi.fn();
      for await (const _ of r.engine.runTurn(input, { signal: new AbortController().signal, onInputNotSent: notSent })) { /* drain */ }
      expect(notSent).toHaveBeenCalledOnce();
    }
    expect(r.fake.userMessages).toEqual([]);
  } finally { await r.close(); }
});

it("quarantines a spawn failure after the old client stopped", async () => {
  const r = await overlayContractRig();
  try {
    r.failSpawn();
    await expect(r.policy.apply(true, {})).rejects.toThrow("spawn refused");
    expect(r.engine.orchestrationState).toBe("quarantined");
    expect(r.fake.streams).toHaveLength(1);
    expect(r.fake.userMessages).toEqual([]);
  } finally { await r.close(); }
});

it.each(["timeout", "death", "shutdown"])("ignores mismatched and late initialize ACK after %s", async failure => {
  const r = await overlayContractRig();
  try {
    r.holdAck();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = r.policy.apply(true, {});
    const rejected = expect(pending).rejects.toThrow();
    for (let i = 0; i < 100 && !r.lateAcks.length; i++) await new Promise(setImmediate);
    expect(r.lateAcks).toHaveLength(1);
    expect(r.engine.orchestrationState).toBe("transitioning");
    await expect(r.policy.apply(false, {})).rejects.toThrow("unavailable");
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS + 1);
    if (failure === "death") r.children.at(-1)!.emit("close", 1, null);
    if (failure === "shutdown") await r.engine.dispose("session-close");
    await rejected;
    r.lateAcks[0]!();
    await new Promise(setImmediate);
    expect(r.engine.orchestrationState).toBe("quarantined");
    expect(r.policy.availability().supported).toBe(false);
    expect(r.fake.userMessages).toEqual([]);
  } finally { vi.useRealTimers(); await r.close(); }
});

it.each([true, false])("keeps host user/report admission closed until restart confirms enabled=%s", async enabled => {
  const r = await overlayContractRig();
  if (!enabled) await r.policy.apply(true, {});
  const reports: ChildReportQueue = new ChildReportQueue({ sendDirect: message => h.outbound.sendDirect(message) });
  const h = createHarness({ steps: [], engine: r.engine, onOrchestrateChanged: () => {},
    pendingChildReports: { resendAll: () => reports.resendAll(), ack: id => reports.ack(id) } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  r.hook(async init => { if (r.fake.streams.length === (enabled ? 2 : 3)) { entered = true; await gate; } return init; });
  try {
    h.send({ type: "ui_ready", orchestrationProtocol: 1 });
    const ready = await h.waitFor(m => m.type === "host_ready");
    if (ready.type !== "host_ready") throw new Error("missing ready");
    const connectionId = ready.orchestrationProtocol!.connectionId;
    // Establish host posture as well as engine posture for the OFF transition.
    if (!enabled) {
      h.send({ type: "set_orchestrate", requestId: "initial-on", connectionId, enabled: true });
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_result" && m.requestId === "initial-on"));
    }
    h.send({ type: "set_orchestrate", requestId: "toggle", connectionId, enabled });
    await vi.waitFor(() => expect(entered).toBe(true));
    reports.add("restart-report", "pending report");
    await h.waitUntil(() => h.received.some(m => m.type === "child_report" && m.id === "restart-report"));
    for (const origin of [undefined, "system"] as const) {
      const requestId = origin ?? "owner";
      h.send({ type: "user_message", requestId, text: origin ? "pending report" : "pending draft", ...(origin ? { origin } : {}) });
      await h.waitUntil(() => h.received.some(m => m.type === "user_message_unavailable" && m.requestId === requestId));
    }
    h.send({ type: "cancel_turn" });
    await h.flush();
    expect(r.engine.orchestrationState).toBe("transitioning");
    expect(h.received.some(m => m.type === "orchestrate_result" && m.requestId === "toggle")).toBe(false);
    expect(reports.snapshot().reports).toEqual([{ id: "restart-report", text: "pending report" }]);
    expect(r.fake.controlSubtypes()).not.toContain("interrupt");
    expect(r.fake.userMessages).toEqual([]);
    release();
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_result" && m.requestId === "toggle" && m.outcome === "applied"));
    expect(r.engine.orchestrationState).toBe(enabled ? "on" : "off");
    const pendingReport = reports.snapshot().reports[0]!;
    h.send({ type: "user_message", requestId: "report-retry", origin: "system", text: pendingReport.text });
    await vi.waitFor(() => expect(r.fake.userMessages).toHaveLength(1));
    r.fake.streams.at(-1)!.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", session_id: r.engine.sessionRef, result: "done" }) + "\n"));
    await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
    expect(r.fake.userMessages).toHaveLength(1);
    h.send({ type: "child_report_ack", id: pendingReport.id });
    await h.flush();
    expect(reports.snapshot().reports).toEqual([]);
  } finally { release(); await h.session.shutdown(); h.close(); await r.close(); }
});

it.each(["permissionMode", "tools", "mcp_servers"])("does not declare OFF after restored %s drift", async key => {
  const r = await overlayContractRig();
  try {
    await r.policy.apply(true, {});
    r.hook(async init => ({ ...init, [key]: key === "permissionMode" ? "default" : [] }));
    await expect(r.policy.apply(false, {})).rejects.toThrow("OFF posture drift");
    expect(r.engine.orchestrationState).toBe("quarantined");
    expect(r.fake.streams).toHaveLength(3);
    expect(r.policy.availability().supported).toBe(false);
    expect(r.fake.userMessages).toEqual([]);
  } finally { await r.close(); }
});

it.each(["enabled", "authority", "readback"])("keeps host user/report blocked after unknown %s acknowledgement", async fault => {
  const r = await overlayContractRig();
  const apply = r.policy.apply.bind(r.policy);
  r.policy.apply = async (enabled, authority) => {
    const snapshot = await apply(enabled, authority);
    return fault === "enabled" ? { ...snapshot, enabled: !enabled }
      : fault === "authority" ? { ...snapshot, baseAuthority: {} } : snapshot;
  };
  if (fault === "readback") r.hook(async (init, read) => read === 2 ? { ...init, session_id: "wrong-ref" } : init);
  const h = createHarness({ steps: [], engine: r.engine });
  try {
    h.send({ type: "ui_ready", orchestrationProtocol: 1 });
    const ready = await h.waitFor(m => m.type === "host_ready");
    if (ready.type !== "host_ready") throw new Error("missing ready");
    h.send({ type: "set_orchestrate", requestId: "unknown", connectionId: ready.orchestrationProtocol!.connectionId, enabled: true });
    await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_result" && m.requestId === "unknown"));
    expect(h.received).toContainEqual(expect.objectContaining({ type: "orchestrate_result", requestId: "unknown", outcome: "unknown" }));
    expect(h.received).toContainEqual(expect.objectContaining({ type: "orchestration_state", posture: "quarantined" }));
    for (const origin of [undefined, "system"] as const) {
      h.send({ type: "user_message", requestId: origin ?? "draft", text: "keep pending", ...(origin ? { origin } : {}) });
      await h.waitUntil(() => h.received.some(m => m.type === "user_message_unavailable" && m.requestId === (origin ?? "draft")));
    }
    expect(r.fake.userMessages).toEqual([]);
    expect(h.received.some(m => m.type === "turn_started")).toBe(false);
  } finally { await h.session.shutdown(); h.close(); await r.close(); }
});

it.each(["fresh", "resume", "candidate"])("cleans private forward files on terminal failure and repeated disposal (%s)", async kind => {
  const dir = mkdtempSync(join(tmpdir(), "claude-terminal-")), paths: string[] = [];
  const fake = fakeSpawn();
  const options = { ...baseOptions(fake.spawnImpl), resolveMcpForward: forwardResolver(dir, paths) };
  const connected = kind === "resume" ? await resumeClaudeEngine({ ...options, externalSessionRef: "native-ref" })
    : kind === "candidate" ? await prepareSwitchRuntime({ engine: "claude", model: "model-a", options }) : await startClaudeEngine(options);
  try {
    expect(existsSync(paths[0]!)).toBe(true);
    fake.streams[0]!.emit("data", Buffer.from("malformed frame\n"));
    await vi.waitFor(() => expect(existsSync(paths[0]!)).toBe(false));
    await connected.engine.dispose("session-close");
    await connected.engine.dispose("session-close");
    expect(paths.every(path => !existsSync(path))).toBe(true);
  } finally { await connected.engine.dispose("session-close"); rmSync(dir, { recursive: true, force: true }); }
});

it.each(["constructor", "initialize", "configure"])("cleans candidate MCP before adoption on %s failure", async failure => {
  const dir = mkdtempSync(join(tmpdir(), "claude-candidate-")), paths: string[] = [];
  const fake = fakeSpawn(failure === "initialize" ? { tokenSource: "none" } : undefined);
  const cleanup = vi.fn();
  try {
    await expect(prepareSwitchRuntime({ engine: "claude", model: "model-a",
      options: { ...baseOptions(fake.spawnImpl), resolveMcpForward: forwardResolver(dir, paths),
        ...(failure === "constructor" ? { notificationHighWater: 1 } : {}) },
      configure: () => { throw new Error("candidate configure failed"); }, cleanup,
    })).rejects.toThrow();
    expect(paths).toHaveLength(1);
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([undefined, {}, { nativeBase: { version: 99 } }])("boots legacy recovery without requiring a comparable MCP digest: %j", async orchestrationRecovery => {
  const fake = fakeSpawn();
  const { engine } = await startClaudeEngine({ ...baseOptions(fake.spawnImpl), orchestrationRecovery,
    resolveMcpForward: async () => ({ claudeConfigPath: null, claudeJson: null, claudeNames: [], loaderProblems: ["invalid user config"], forwardProblems: [], notices: [], cleanupFile() {} }) });
  try { expect(engine.orchestrationState).toBe("off"); }
  finally { await engine.dispose("session-close"); }
});
