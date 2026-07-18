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
import { resumeClaudeEngine, startClaudeEngine } from "./claude-engine.js";
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

/** A fake `claude` child: answers `--version`, then the `initialize` control-request over the NDJSON stdin/stdout pair. Captures the main spawn's argv. */
function fakeSpawn(): { spawnImpl: (command: string, args: readonly string[]) => unknown; capturedArgs: () => string[] | undefined } {
  let mainArgs: string[] | undefined;
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
        const response =
          message.request.subtype === "initialize"
            ? { commands: [], models: MODELS, account: { tokenSource: "oauth" } }
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
  return { spawnImpl, capturedArgs: () => mainArgs };
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
