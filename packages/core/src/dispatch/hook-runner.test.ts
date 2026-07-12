/**
 * InMemoryHookRunner: matcher filtering, deny > ask > allow merge, last
 * updatedInput wins, and fail-closed behavior (throwing hook => deny, hanging
 * hook => deny AND actually aborted, external abort propagates).
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryHookRunner } from "./hook-runner.js";
import type {
  HookRegistration,
  PostToolUseHook,
  PostToolUseHookInput,
  PreToolUseHook,
  PreToolUseHookInput,
  StopHook,
  StopHookInput,
  SubagentStopHook,
  SubagentStopHookInput,
  UserPromptSubmitHook,
  UserPromptSubmitHookInput,
} from "../types/hooks.js";
import type { ToolCallOutcome } from "../types/tools.js";

function input(toolName: string, value: unknown = {}): PreToolUseHookInput {
  return { toolCallId: "call-1", toolName, input: value };
}

function reg(matcher: RegExp | undefined, hook: PreToolUseHook): HookRegistration {
  return { event: "PreToolUse", matcher, hook };
}

function outcome(toolName: string): ToolCallOutcome {
  return { toolCallId: "call-1", toolName, status: "success", modelText: "ok", durationMs: 1 };
}

function postInput(toolName: string): PostToolUseHookInput {
  return { toolCallId: "call-1", toolName, input: {}, outcome: outcome(toolName) };
}

function stopInput(): StopHookInput {
  return { reason: "completed", turns: 1 };
}

function upsInput(prompt: string): UserPromptSubmitHookInput {
  return { prompt };
}

function upsReg(matcher: RegExp | undefined, hook: UserPromptSubmitHook): HookRegistration {
  return { event: "UserPromptSubmit", matcher, hook };
}

function postReg(
  event: "PostToolUse" | "PostToolUseFailure",
  matcher: RegExp | undefined,
  hook: PostToolUseHook,
): HookRegistration {
  return { event, matcher, hook };
}

function stopReg(hook: StopHook): HookRegistration {
  return { event: "Stop", hook };
}

function subagentStopInput(agentType: string): SubagentStopHookInput {
  return {
    agentType,
    description: "task",
    status: "completed",
    turns: 2,
    toolCalls: 3,
    durationMs: 42,
  };
}

function subagentStopReg(
  matcher: RegExp | undefined,
  hook: SubagentStopHook,
): HookRegistration {
  return { event: "SubagentStop", matcher, hook };
}

describe("InMemoryHookRunner — matcher", () => {
  it("runs a hook when its regex matches, skips when it does not", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(reg(/^Bash$/, async () => void calls.push("bash")));
    runner.register(reg(/^Read$/, async () => void calls.push("read")));
    await runner.runPreToolUse(input("Bash"));
    expect(calls).toEqual(["bash"]);
  });

  it("treats an undefined matcher as matching every tool", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(reg(undefined, async () => void calls.push("all")));
    await runner.runPreToolUse(input("Grep"));
    await runner.runPreToolUse(input("Write"));
    expect(calls).toEqual(["all", "all"]);
  });

  it("returns an empty aggregate when no hooks match", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(/^Bash$/, async () => ({ permissionDecision: "deny" })));
    const result = await runner.runPreToolUse(input("Read"));
    expect(result).toEqual({});
  });
});

describe("InMemoryHookRunner — merge", () => {
  it("merges permission decisions as deny > ask > allow", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(undefined, async () => ({ permissionDecision: "allow" })));
    runner.register(reg(undefined, async () => ({ permissionDecision: "ask", reason: "confirm" })));
    const asked = await runner.runPreToolUse(input("X"));
    expect(asked.permissionDecision).toBe("ask");
    expect(asked.reason).toContain("confirm");

    runner.register(reg(undefined, async () => ({ permissionDecision: "deny", reason: "blocked" })));
    const denied = await runner.runPreToolUse(input("X"));
    expect(denied.permissionDecision).toBe("deny");
    expect(denied.reason).toContain("blocked");
  });

  it("is order-independent (deny registered first still wins over later allow)", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(undefined, async () => ({ permissionDecision: "deny" })));
    runner.register(reg(undefined, async () => ({ permissionDecision: "allow" })));
    const result = await runner.runPreToolUse(input("X"));
    expect(result.permissionDecision).toBe("deny");
  });

  it("keeps the last non-undefined updatedInput", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(undefined, async () => ({ updatedInput: { v: 1 } })));
    runner.register(reg(undefined, async () => ({ updatedInput: { v: 2 } })));
    // A later hook with no updatedInput must not clobber the accumulated one.
    runner.register(reg(undefined, async () => ({ permissionDecision: "allow" })));
    const result = await runner.runPreToolUse(input("X"));
    expect(result.updatedInput).toEqual({ v: 2 });
    expect(result.permissionDecision).toBe("allow");
  });
});

describe("InMemoryHookRunner — fail-closed", () => {
  it("treats a throwing hook as deny", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(undefined, async () => {
      throw new Error("boom");
    }));
    const result = await runner.runPreToolUse(input("Bash"));
    expect(result.permissionDecision).toBe("deny");
    expect(result.reason).toMatch(/boom|hook/i);
  });

  it("treats a hanging hook as deny AND actually aborts it", async () => {
    const runner = new InMemoryHookRunner();
    let aborted = false;
    runner.register(
      reg(undefined, (_input, signal) =>
        new Promise((resolve) => {
          // Never resolves on its own; only the runner's timeout can end it.
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ permissionDecision: "allow" });
          });
        }),
      ),
    );
    const result = await runner.runPreToolUse(input("Bash"), { timeoutMs: 20 });
    expect(result.permissionDecision).toBe("deny");
    expect(aborted).toBe(true);
  });

  it("still denies overall when a later good hook allows after a bad one", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(reg(undefined, async () => {
      throw new Error("boom");
    }));
    runner.register(reg(undefined, async () => ({ permissionDecision: "allow" })));
    const result = await runner.runPreToolUse(input("Bash"));
    expect(result.permissionDecision).toBe("deny");
  });
});

describe("InMemoryHookRunner — abort propagation", () => {
  it("propagates an external abort and stops further hooks", async () => {
    const runner = new InMemoryHookRunner();
    const laterHook = vi.fn<PreToolUseHook>(async () => undefined);
    runner.register(
      reg(undefined, (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("hook aborted")));
        }),
      ),
    );
    runner.register(reg(undefined, laterHook));

    const controller = new AbortController();
    const pending = runner.runPreToolUse(input("Bash"), { signal: controller.signal });
    controller.abort(new Error("turn cancelled"));

    await expect(pending).rejects.toThrow("turn cancelled");
    expect(laterHook).not.toHaveBeenCalled();
  });

  it("throws immediately when the signal is already aborted, running no hooks", async () => {
    const runner = new InMemoryHookRunner();
    const hook = vi.fn<PreToolUseHook>(async () => undefined);
    runner.register(reg(undefined, hook));
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      runner.runPreToolUse(input("Bash"), { signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("InMemoryHookRunner — runUserPromptSubmit", () => {
  it("concatenates additionalContext from every matching hook", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(upsReg(undefined, async () => ({ additionalContext: "one" })));
    runner.register(upsReg(undefined, async () => ({ additionalContext: "two" })));
    runner.register(upsReg(undefined, async () => undefined));
    const result = await runner.runUserPromptSubmit(upsInput("hello"));
    expect(result).toEqual({ additionalContext: "one\ntwo" });
  });

  it("tests the matcher against the prompt text, not a tool name", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(upsReg(/deploy/, async () => ({ additionalContext: "deploy-ctx" })));
    runner.register(upsReg(/rollback/, async () => ({ additionalContext: "rollback-ctx" })));
    const result = await runner.runUserPromptSubmit(upsInput("please deploy now"));
    expect(result).toEqual({ additionalContext: "deploy-ctx" });
  });

  it("returns an empty object when no hooks match or none contribute context", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(upsReg(/never/, async () => ({ additionalContext: "x" })));
    runner.register(upsReg(undefined, async () => undefined));
    expect(await runner.runUserPromptSubmit(upsInput("hi"))).toEqual({});
  });

  it("is fail-open: a throwing hook is skipped and others still contribute", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(
      upsReg(undefined, async () => {
        throw new Error("boom");
      }),
    );
    runner.register(upsReg(undefined, async () => ({ additionalContext: "survived" })));
    const result = await runner.runUserPromptSubmit(upsInput("hi"));
    expect(result).toEqual({ additionalContext: "survived" });
  });

  it("is fail-open on timeout: a hanging hook is skipped AND actually aborted", async () => {
    const runner = new InMemoryHookRunner();
    let aborted = false;
    runner.register(
      upsReg(undefined, (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ additionalContext: "late" });
          });
        }),
      ),
    );
    runner.register(upsReg(undefined, async () => ({ additionalContext: "fast" })));
    const result = await runner.runUserPromptSubmit(upsInput("hi"), { timeoutMs: 20 });
    expect(result).toEqual({ additionalContext: "fast" });
    expect(aborted).toBe(true);
  });

  it("propagates an external abort and stops further hooks", async () => {
    const runner = new InMemoryHookRunner();
    const laterHook = vi.fn<UserPromptSubmitHook>(async () => undefined);
    runner.register(
      upsReg(undefined, (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("hook aborted")));
        }),
      ),
    );
    runner.register(upsReg(undefined, laterHook));

    const controller = new AbortController();
    const pending = runner.runUserPromptSubmit(upsInput("hi"), { signal: controller.signal });
    controller.abort(new Error("turn cancelled"));

    await expect(pending).rejects.toThrow("turn cancelled");
    expect(laterHook).not.toHaveBeenCalled();
  });

  it("throws immediately when the signal is already aborted", async () => {
    const runner = new InMemoryHookRunner();
    const hook = vi.fn<UserPromptSubmitHook>(async () => undefined);
    runner.register(upsReg(undefined, hook));
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      runner.runUserPromptSubmit(upsInput("hi"), { signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("InMemoryHookRunner — runObservers (PostToolUse / PostToolUseFailure)", () => {
  it("runs matching hooks filtered by the tool-name matcher", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(postReg("PostToolUse", /^Bash$/, async () => void calls.push("bash")));
    runner.register(postReg("PostToolUse", /^Read$/, async () => void calls.push("read")));
    await runner.runObservers("PostToolUse", postInput("Bash"));
    expect(calls).toEqual(["bash"]);
  });

  it("distinguishes PostToolUse from PostToolUseFailure registrations", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(postReg("PostToolUse", undefined, async () => void calls.push("success")));
    runner.register(postReg("PostToolUseFailure", undefined, async () => void calls.push("failure")));

    await runner.runObservers("PostToolUse", postInput("Bash"));
    expect(calls).toEqual(["success"]);

    await runner.runObservers("PostToolUseFailure", postInput("Bash"));
    expect(calls).toEqual(["success", "failure"]);
  });

  it("is fail-open: a throwing observer is skipped and later ones still run", async () => {
    const runner = new InMemoryHookRunner();
    const later = vi.fn<PostToolUseHook>(async () => undefined);
    runner.register(
      postReg("PostToolUse", undefined, async () => {
        throw new Error("observer boom");
      }),
    );
    runner.register(postReg("PostToolUse", undefined, later));
    await expect(runner.runObservers("PostToolUse", postInput("Bash"))).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledOnce();
  });

  it("is fail-open on timeout: a hanging observer is skipped AND aborted", async () => {
    const runner = new InMemoryHookRunner();
    let aborted = false;
    const later = vi.fn<PostToolUseHook>(async () => undefined);
    runner.register(
      postReg("PostToolUse", undefined, (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      ),
    );
    runner.register(postReg("PostToolUse", undefined, later));
    await expect(
      runner.runObservers("PostToolUse", postInput("Bash"), { timeoutMs: 20 }),
    ).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(later).toHaveBeenCalledOnce();
  });

  it("propagates an external abort and stops further observers", async () => {
    const runner = new InMemoryHookRunner();
    const later = vi.fn<PostToolUseHook>(async () => undefined);
    runner.register(
      postReg("PostToolUse", undefined, (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("hook aborted")));
        }),
      ),
    );
    runner.register(postReg("PostToolUse", undefined, later));

    const controller = new AbortController();
    const pending = runner.runObservers("PostToolUse", postInput("Bash"), {
      signal: controller.signal,
    });
    controller.abort(new Error("turn cancelled"));

    await expect(pending).rejects.toThrow("turn cancelled");
    expect(later).not.toHaveBeenCalled();
  });
});

describe("InMemoryHookRunner — runObservers (Stop)", () => {
  it("runs every Stop hook", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(stopReg(async () => void calls.push("a")));
    runner.register(stopReg(async () => void calls.push("b")));
    await runner.runObservers("Stop", stopInput());
    expect(calls).toEqual(["a", "b"]);
  });

  it("is fail-open: a throwing Stop hook does not block completion", async () => {
    const runner = new InMemoryHookRunner();
    const later = vi.fn<StopHook>(async () => undefined);
    runner.register(
      stopReg(async () => {
        throw new Error("stop boom");
      }),
    );
    runner.register(stopReg(later));
    await expect(runner.runObservers("Stop", stopInput())).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledOnce();
  });

  it("propagates an external abort", async () => {
    const runner = new InMemoryHookRunner();
    runner.register(
      stopReg((_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("hook aborted")));
        }),
      ),
    );
    const controller = new AbortController();
    const pending = runner.runObservers("Stop", stopInput(), { signal: controller.signal });
    controller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });
});

describe("InMemoryHookRunner — runObservers (SubagentStop)", () => {
  it("filters by a matcher tested against agentType", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(subagentStopReg(/explore/, async () => void calls.push("explore")));
    runner.register(subagentStopReg(/reviewer/, async () => void calls.push("reviewer")));
    await runner.runObservers("SubagentStop", subagentStopInput("explore"));
    expect(calls).toEqual(["explore"]);
  });

  it("treats an undefined matcher as matching every agentType", async () => {
    const runner = new InMemoryHookRunner();
    const seen: string[] = [];
    runner.register(subagentStopReg(undefined, async (input) => void seen.push(input.agentType)));
    await runner.runObservers("SubagentStop", subagentStopInput("explore"));
    await runner.runObservers("SubagentStop", subagentStopInput("general-purpose"));
    expect(seen).toEqual(["explore", "general-purpose"]);
  });

  it("does not confuse SubagentStop with Stop registrations", async () => {
    const runner = new InMemoryHookRunner();
    const calls: string[] = [];
    runner.register(stopReg(async () => void calls.push("stop")));
    runner.register(subagentStopReg(undefined, async () => void calls.push("subagent")));
    await runner.runObservers("SubagentStop", subagentStopInput("explore"));
    expect(calls).toEqual(["subagent"]);
  });

  it("is fail-open: a throwing observer is skipped and later ones still run", async () => {
    const runner = new InMemoryHookRunner();
    const later = vi.fn<SubagentStopHook>(async () => undefined);
    runner.register(
      subagentStopReg(undefined, async () => {
        throw new Error("subagent boom");
      }),
    );
    runner.register(subagentStopReg(undefined, later));
    await expect(
      runner.runObservers("SubagentStop", subagentStopInput("explore")),
    ).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledOnce();
  });

  it("is fail-open on timeout: a hanging observer is skipped AND aborted", async () => {
    const runner = new InMemoryHookRunner();
    let aborted = false;
    const later = vi.fn<SubagentStopHook>(async () => undefined);
    runner.register(
      subagentStopReg(undefined, (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      ),
    );
    runner.register(subagentStopReg(undefined, later));
    await expect(
      runner.runObservers("SubagentStop", subagentStopInput("explore"), { timeoutMs: 20 }),
    ).resolves.toBeUndefined();
    expect(aborted).toBe(true);
    expect(later).toHaveBeenCalledOnce();
  });

  it("propagates an external abort and stops further observers", async () => {
    const runner = new InMemoryHookRunner();
    const later = vi.fn<SubagentStopHook>(async () => undefined);
    runner.register(
      subagentStopReg(undefined, (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("hook aborted")));
        }),
      ),
    );
    runner.register(subagentStopReg(undefined, later));

    const controller = new AbortController();
    const pending = runner.runObservers("SubagentStop", subagentStopInput("explore"), {
      signal: controller.signal,
    });
    controller.abort(new Error("turn cancelled"));

    await expect(pending).rejects.toThrow("turn cancelled");
    expect(later).not.toHaveBeenCalled();
  });
});
