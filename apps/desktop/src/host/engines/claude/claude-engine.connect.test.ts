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
import type { ClaudeMcpBridge } from "./mcp-bridge.js";

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
});
