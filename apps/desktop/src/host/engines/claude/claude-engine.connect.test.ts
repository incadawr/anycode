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
 */
function fakeSpawn(account: Record<string, unknown> = { tokenSource: "oauth" }): {
  spawnImpl: (command: string, args: readonly string[]) => unknown;
  capturedArgs: () => string[] | undefined;
  controlSubtypes: () => string[];
} {
  let mainArgs: string[] | undefined;
  const controls: string[] = [];
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
        const message = JSON.parse(line) as { type: string; request_id: string; request: { subtype: string } };
        if (message.type !== "control_request") continue;
        controls.push(message.request.subtype);
        const response =
          message.request.subtype === "initialize"
            ? { commands: [], models: MODELS, account }
            : {};
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            Buffer.from(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })}\n`),
          );
        });
      }
      return true;
    };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  return { spawnImpl, capturedArgs: () => mainArgs, controlSubtypes: () => [...controls] };
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
