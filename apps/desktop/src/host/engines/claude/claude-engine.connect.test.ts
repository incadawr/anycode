/**
 * cut §1.5 D2: `resumeClaudeEngine` must spawn `--resume <ref>` (never
 * `--session-id`, which would start a brand-new native session under a
 * different id) and echo the persisted `externalSessionRef` back verbatim —
 * unlike `startClaudeEngine`, which always mints a fresh `randomUUID()`. Both
 * share the same `connectClaudeEngine` handshake; this file pins only the ONE
 * thing that differs between them, against a scripted fake child (no real
 * `claude` binary, mirrors claude-client.test.ts's framing-test fake spawn).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CLAUDE_NOT_SIGNED_IN, resumeClaudeEngine, startClaudeEngine } from "./claude-engine.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
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
 * TASK.226 срез S4 (probes.md P0): when the outbound `initialize` body
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
function fakeSpawn(account: Record<string, unknown> = { tokenSource: "oauth" }): {
  spawnImpl: (command: string, args: readonly string[]) => unknown;
  capturedArgs: () => string[] | undefined;
  controlSubtypes: () => string[];
  capturedSdkMcpServers: () => unknown;
  nestedMcpResponse: () => { subtype: string; response?: unknown; error?: string } | undefined;
} {
  let mainArgs: string[] | undefined;
  const controls: string[] = [];
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
    child.stdin = makeFakeStream();
    child.stdout = makeFakeStream();
    child.stderr = makeFakeStream();
    child.stdin.end = () => queueMicrotask(() => child.emit("close", 0, null));
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
          request?: { subtype: string; sdkMcpServers?: unknown };
          response?: { request_id: string; subtype: string; response?: unknown; error?: string };
        };
        if (message.type === "control_response") {
          // The host answering OUR nested (CLI -> host) mcp_message below.
          if (message.response?.request_id === NESTED_MCP_REQUEST_ID) {
            nestedResponse = message.response;
          }
          continue;
        }
        if (message.type !== "control_request" || message.request === undefined) continue;
        controls.push(message.request.subtype);
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
          child.stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: MODELS, account } },
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
    spawnImpl,
    capturedArgs: () => mainArgs,
    controlSubtypes: () => [...controls],
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
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      const args = capturedArgs();
      expect(args).toContain("--session-id");
      expect(args).not.toContain("--resume");
      expect(connected.sessionRef).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    } finally {
      await connected.engine.dispose("session-close");
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
 * TASK.75 — the initial `--effort` spawn flag. Unlike model/permissionMode
 * (suppressed on resume, see the hazard (б) describe block below), effort
 * rides EVERY spawn: `system/init` carries no effort field at all, so there
 * is no surviving native truth a resend could clobber.
 */
describe("connect: --effort rides the spawn (TASK.75)", () => {
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
 * TASK.226 срез S4 — the MCP bridge's own ordering requirement (probes.md
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
describe("TASK.226 срез S4 — the MCP bridge is wired BEFORE initialize is sent (probes.md P0)", () => {
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

  it("no mcpBridge option at all: initialize carries no sdkMcpServers, and the CLI never even attempts the nested handshake (switch, byte-identical to pre-TASK.226)", async () => {
    const { spawnImpl, nestedMcpResponse, capturedSdkMcpServers } = fakeSpawn();
    const connected = await startClaudeEngine(baseOptions(spawnImpl));
    try {
      expect(capturedSdkMcpServers()).toBeUndefined();
      expect(nestedMcpResponse()).toBeUndefined();
    } finally {
      await connected.engine.dispose("session-close");
    }
  });

  it("Taskana 4238: a REAL bridge's notification ack rides the full wire envelope written by ClaudeClient — response is an object, never absent", async () => {
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

// TASK.180: the PUBLIC wrappers (startClaudeEngine/resumeClaudeEngine) must
// not drop the child's turn budget — options.maxTurns has to reach the actual
// ClaudeClient spawn argv as --max-turns <n> on BOTH the fresh and the resume
// path (claude-engine.ts spreads ...options into ClaudeClient).
describe("startClaudeEngine/resumeClaudeEngine — maxTurns forwarding (TASK.180)", () => {
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
 * Taskana 4056 cross-review M2, wiring level: the delegation sentence
 * (`mcp__anycode__agent`) may appear on the spawn argv ONLY in a session
 * whose bridge is announced. `connectClaudeEngine` enforces the pairing even
 * against a confused caller (agentBridgePrompt without mcpBridge → plain
 * always-on block), and both a bridge-less boot and the pairing failure are
 * byte-identical to the pre-4056 argv.
 */
describe("agentBridgePrompt rides the argv only when the bridge is announced (Taskana 4056 M2)", () => {
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


// Taskana 4764 C8/C9/C10/C12/C14: end to end through the REAL
// ClaudeMcpBridge + REAL createEngineBrowserBridge — the door's browser
// tools/call drives the same approval and preview contract as a live tab;
// a recording fake broker stands in for the UI side of IpcPermissionBroker.
describe("Taskana 4764 — browser tools through the engine door (C8/C9/C10/C12/C14)", () => {
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
