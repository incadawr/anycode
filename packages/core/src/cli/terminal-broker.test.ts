/**
 * Unit tests for the CLI terminal permission-broker (design slice-4.1-cut.md
 * §3.1, test matrix §5.2 items 1-2). Covers: y/n/a answer mapping, the "a" ->
 * rules.add seam, the re-prompt cap, the FIFO of concurrent asks (shown one at a
 * time in arrival order, first answer wins), the abort cascade (shown + queued),
 * pre-attach / signal-already-aborted fail-closed denies, the factory selection
 * (yolo -> AllowAll, non-interactive -> Deny, interactive -> Terminal), and the
 * real readline prompter over a PassThrough (answer resolution, abort ->
 * AbortError -> deny mapping with a `\n` cursor recovery and no hung promise).
 */

import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AllowAllPermissionBroker, DenyPermissionBroker, SessionPermissionRules } from "../permissions/index.js";
import type { PermissionMode, PermissionRequest } from "../types/permissions.js";
import type { RiskLevel } from "../types/tools.js";
import { createCliTheme } from "./theme.js";
import type { CliTheme } from "./theme.js";
import {
  CLI_ASK_INPUT_PREVIEW_MAX_CHARS,
  CLI_ASK_MAX_REPROMPTS,
  CLI_PLAN_PREVIEW_MAX_CHARS,
  createCliPermissionBroker,
  createReadlinePrompter,
  TerminalPermissionBroker,
  type TerminalPrompter,
} from "./terminal-broker.js";

/** A no-color theme (identity paint) so prompt assertions are plain text and stable across the theme lane. */
const theme: CliTheme = createCliTheme({ color: false });

/** Flushes microtasks + one macrotask so the broker's settle -> presentNext chain runs. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function makeRequest(
  overrides: {
    toolName?: string;
    input?: unknown;
    mode?: PermissionMode;
    riskLevel?: RiskLevel;
    destructive?: boolean;
  } = {},
): PermissionRequest {
  const toolName = overrides.toolName ?? "Write";
  return {
    toolName,
    input: overrides.input ?? { file_path: "/ws/a.ts", content: "hello" },
    mode: overrides.mode ?? "build",
    metadata: {
      name: toolName,
      description: "",
      readOnly: false,
      destructive: overrides.destructive ?? true,
      concurrentSafe: false,
      riskLevel: overrides.riskLevel ?? "medium",
      sideEffectScope: "filesystem",
      needsApproval: true,
      timeoutMs: 1000,
    },
  };
}

/** Auto-answering prompter: replies from a canned FIFO queue asynchronously; logs questions and peak concurrency. */
function makeScriptedPrompter(answers: string[]): {
  prompter: TerminalPrompter;
  questions: string[];
  maxActive: () => number;
} {
  const questions: string[] = [];
  let active = 0;
  let maxActive = 0;
  const prompter: TerminalPrompter = {
    async ask(question: string): Promise<string> {
      questions.push(question);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await Promise.resolve();
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error("scripted prompter exhausted");
        }
        return answer;
      } finally {
        active -= 1;
      }
    },
  };
  return { prompter, questions, maxActive: () => maxActive };
}

/** Manually-driven prompter: records each ask and lets the test resolve/reject it; also rejects on abort. */
function makeManualPrompter(): {
  prompter: TerminalPrompter;
  asks: Array<{ question: string; resolve: (answer: string) => void }>;
} {
  const asks: Array<{ question: string; resolve: (answer: string) => void }> = [];
  const prompter: TerminalPrompter = {
    ask(question: string, opts?: { signal?: AbortSignal }): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        asks.push({ question, resolve });
        const signal = opts?.signal;
        if (signal !== undefined) {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }
      });
    },
  };
  return { prompter, asks };
}

describe("createCliPermissionBroker (factory selection)", () => {
  it("yolo -> AllowAllPermissionBroker", () => {
    const broker = createCliPermissionBroker({ yolo: true, interactive: true, rules: new SessionPermissionRules(), theme });
    expect(broker).toBeInstanceOf(AllowAllPermissionBroker);
  });

  it("non-interactive (not yolo) -> DenyPermissionBroker", () => {
    const broker = createCliPermissionBroker({ yolo: false, interactive: false, rules: new SessionPermissionRules(), theme });
    expect(broker).toBeInstanceOf(DenyPermissionBroker);
  });

  it("interactive (not yolo) -> TerminalPermissionBroker", () => {
    const broker = createCliPermissionBroker({ yolo: false, interactive: true, rules: new SessionPermissionRules(), theme });
    expect(broker).toBeInstanceOf(TerminalPermissionBroker);
  });
});

describe("TerminalPermissionBroker answers", () => {
  it("y -> allow", async () => {
    const { prompter } = makeScriptedPrompter(["y"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(makeRequest())).resolves.toEqual({ behavior: "allow" });
  });

  it("yes (case/space-insensitive) -> allow", async () => {
    const { prompter } = makeScriptedPrompter(["  YES "]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(makeRequest())).resolves.toEqual({ behavior: "allow" });
  });

  it("n -> deny with reason", async () => {
    const { prompter } = makeScriptedPrompter(["n"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(makeRequest())).resolves.toEqual({
      behavior: "deny",
      reason: "denied by user",
    });
  });

  it("a -> rules.add({ toolName }) then allow", async () => {
    const { prompter } = makeScriptedPrompter(["a"]);
    const rules = new SessionPermissionRules();
    const addSpy = vi.spyOn(rules, "add");
    const broker = new TerminalPermissionBroker(rules, theme);
    broker.attachPrompter(prompter);
    const decision = await broker.requestPermission(makeRequest({ toolName: "Write" }));
    expect(decision).toEqual({ behavior: "allow" });
    expect(addSpy).toHaveBeenCalledWith({ toolName: "Write" });
    expect(rules.matches("Write", { file_path: "/anything" })).toBe(true);
  });

  it("empty/garbage re-prompts, then denies after CLI_ASK_MAX_REPROMPTS", async () => {
    const { prompter, questions } = makeScriptedPrompter(["", "??", "zzz"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const decision = await broker.requestPermission(makeRequest());
    expect(decision).toEqual({ behavior: "deny", reason: "unrecognized answers" });
    expect(questions).toHaveLength(CLI_ASK_MAX_REPROMPTS);
  });

  it("re-prompts then accepts a valid answer", async () => {
    const { prompter, questions } = makeScriptedPrompter(["", "y"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(makeRequest())).resolves.toEqual({ behavior: "allow" });
    expect(questions).toHaveLength(2);
  });
});

describe("TerminalPermissionBroker ask presentation", () => {
  it("renders the [permission] block with risk, destructive flag and hint", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(
      makeRequest({ toolName: "Write", riskLevel: "medium", destructive: true, input: { file_path: "/ws/a.ts" } }),
    );
    expect(asks).toHaveLength(1);
    const { question } = asks[0]!;
    expect(question).toContain('[permission] Write (risk: medium, destructive) — {"file_path":"/ws/a.ts"}');
    expect(question).toContain("y = allow once · n = deny · a = always allow Write this session (/allow Write <glob> for finer scope)");
    expect(question).toContain("answer [y/n/a]: ");
    asks[0]!.resolve("y");
    await pending;
  });

  it("omits the destructive marker for a non-destructive tool", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(makeRequest({ toolName: "Read", riskLevel: "low", destructive: false }));
    expect(asks[0]!.question).toContain("[permission] Read (risk: low) — ");
    expect(asks[0]!.question).not.toContain("destructive");
    asks[0]!.resolve("n");
    await pending;
  });

  it("caps the input preview at CLI_ASK_INPUT_PREVIEW_MAX_CHARS with an ellipsis", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(makeRequest({ input: { content: "x".repeat(1000) } }));
    const firstLine = asks[0]!.question.split("\n")[0]!;
    expect(firstLine.endsWith("…")).toBe(true);
    // header prefix ("[permission] Write (risk: medium, destructive) — ") + capped json + "…"
    expect(firstLine.length).toBeLessThan(CLI_ASK_INPUT_PREVIEW_MAX_CHARS + 100);
    asks[0]!.resolve("n");
    await pending;
  });
});

describe("TerminalPermissionBroker ExitPlanMode plan-approval ask (design §3.2)", () => {
  /** An ExitPlanMode approval request carrying a string plan (mirrors the real tool metadata). */
  const exitPlanRequest = (plan: string): PermissionRequest =>
    makeRequest({ toolName: "ExitPlanMode", input: { plan }, riskLevel: "low", destructive: false });

  /** The byte-exact generic ask block for a Write request — the fail-open fallback anchor. */
  const genericWriteAsk =
    '[permission] Write (risk: medium, destructive) — {"file_path":"/ws/a.ts","content":"hello"}\n' +
    "  y = allow once · n = deny · a = always allow Write this session (/allow Write <glob> for finer scope)\n" +
    "answer [y/n/a]: ";

  it("shows the plan verbatim in the special form (header, plan body, y/n hint, [y/n] prompt)", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const plan = "Step 1: read the file\nStep 2: change the line\nStep 3: verify";
    const pending = broker.requestPermission(exitPlanRequest(plan));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toBe(
      "[permission] ExitPlanMode — plan approval requested\n" +
        `${plan}\n` +
        "  y = approve plan (switch to build mode; writes still ask) · n = reject (keep planning)\n" +
        "answer [y/n]: ",
    );
    asks[0]!.resolve("y");
    await pending;
  });

  it("shows the whole plan — NOT clipped by the generic 400-char preview cap", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    // Well past the generic 400-char cap but under the 10k plan cap: shown in full.
    const plan = "L".repeat(CLI_ASK_INPUT_PREVIEW_MAX_CHARS + 500);
    const pending = broker.requestPermission(exitPlanRequest(plan));
    expect(asks[0]!.question).toContain(plan);
    expect(asks[0]!.question).not.toContain("… (+");
    asks[0]!.resolve("n");
    await pending;
  });

  it("caps the plan at CLI_PLAN_PREVIEW_MAX_CHARS with an honest (+K chars) tail", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const elided = 137;
    const plan = "P".repeat(CLI_PLAN_PREVIEW_MAX_CHARS + elided);
    const pending = broker.requestPermission(exitPlanRequest(plan));
    const question = asks[0]!.question;
    // The shown prefix is exactly the cap; the tail reports the exact number of elided chars.
    expect(question).toContain(`${plan.slice(0, CLI_PLAN_PREVIEW_MAX_CHARS)}… (+${elided} chars)`);
    expect(question).not.toContain(plan); // the full (over-cap) plan is never emitted whole
    asks[0]!.resolve("n");
    await pending;
  });

  it("emits zero SGR escapes in the plan body under a no-color theme", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(exitPlanRequest("plain plan\nsecond line"));
    // No ANSI SGR: assert the ESC (0x1b) control char is absent (the literal "[" of "[permission]" is fine).
    expect(asks[0]!.question).not.toContain(String.fromCharCode(27));
    asks[0]!.resolve("y");
    await pending;
  });

  it("y -> approve (allow)", async () => {
    const { prompter } = makeScriptedPrompter(["y"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(exitPlanRequest("the plan"))).resolves.toEqual({ behavior: "allow" });
  });

  it("n -> reject (deny) with the instructive keep-planning reason", async () => {
    const { prompter } = makeScriptedPrompter(["n"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(exitPlanRequest("the plan"))).resolves.toEqual({
      behavior: "deny",
      reason: "plan rejected by user — stay in plan mode and refine the plan",
    });
  });

  it("a is unrecognised here: re-prompts WITHOUT rules.add, then denies after the cap", async () => {
    const { prompter, questions } = makeScriptedPrompter(["a", "a", "a"]);
    const rules = new SessionPermissionRules();
    const addSpy = vi.spyOn(rules, "add");
    const broker = new TerminalPermissionBroker(rules, theme);
    broker.attachPrompter(prompter);
    const decision = await broker.requestPermission(exitPlanRequest("the plan"));
    expect(decision).toEqual({ behavior: "deny", reason: "unrecognized answers" });
    expect(questions).toHaveLength(CLI_ASK_MAX_REPROMPTS);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("a followed by a valid answer re-prompts and approves, still without rules.add", async () => {
    const { prompter, questions } = makeScriptedPrompter(["a", "y"]);
    const rules = new SessionPermissionRules();
    const addSpy = vi.spyOn(rules, "add");
    const broker = new TerminalPermissionBroker(rules, theme);
    broker.attachPrompter(prompter);
    await expect(broker.requestPermission(exitPlanRequest("the plan"))).resolves.toEqual({ behavior: "allow" });
    expect(questions).toHaveLength(2);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("a malformed ExitPlanMode ask (no string plan) falls back to the generic block byte-for-byte", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    // No `plan` key at all -> duck-gate fails -> today's generic ask, hint includes "a".
    const pending = broker.requestPermission(
      makeRequest({ toolName: "ExitPlanMode", input: { notplan: 1 }, riskLevel: "medium", destructive: true }),
    );
    expect(asks[0]!.question).toBe(
      '[permission] ExitPlanMode (risk: medium, destructive) — {"notplan":1}\n' +
        "  y = allow once · n = deny · a = always allow ExitPlanMode this session (/allow ExitPlanMode <glob> for finer scope)\n" +
        "answer [y/n/a]: ",
    );
    asks[0]!.resolve("n");
    await pending;
  });

  it("a non-string plan (plan: number) also falls back to the generic block", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(makeRequest({ toolName: "ExitPlanMode", input: { plan: 42 } }));
    expect(asks[0]!.question).toContain("answer [y/n/a]: "); // generic prompt, not [y/n]
    expect(asks[0]!.question).not.toContain("plan approval requested");
    asks[0]!.resolve("n");
    await pending;
  });

  it("generic asks of other tools stay byte-for-byte (snapshot anchor)", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const pending = broker.requestPermission(makeRequest({ toolName: "Write" }));
    expect(asks[0]!.question).toBe(genericWriteAsk);
    asks[0]!.resolve("y");
    await pending;
  });
});

describe("TerminalPermissionBroker FIFO of concurrent asks", () => {
  it("shows asks strictly one at a time in arrival order", async () => {
    const { prompter, asks } = makeManualPrompter();
    const rules = new SessionPermissionRules();
    const broker = new TerminalPermissionBroker(rules, theme);
    broker.attachPrompter(prompter);

    const p1 = broker.requestPermission(makeRequest({ toolName: "Write" }));
    const p2 = broker.requestPermission(makeRequest({ toolName: "Read" }));
    const p3 = broker.requestPermission(makeRequest({ toolName: "Bash" }));

    // Only the first is shown; the rest are parked.
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toContain("[permission] Write");

    asks[0]!.resolve("y");
    await flush();
    expect(asks).toHaveLength(2);
    expect(asks[1]!.question).toContain("[permission] Read");

    asks[1]!.resolve("n");
    await flush();
    expect(asks).toHaveLength(3);
    expect(asks[2]!.question).toContain("[permission] Bash");

    asks[2]!.resolve("a");

    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1).toEqual({ behavior: "allow" });
    expect(d2).toEqual({ behavior: "deny", reason: "denied by user" });
    expect(d3).toEqual({ behavior: "allow" });
    expect(rules.matches("Bash", { command: "echo" })).toBe(true);
  });

  it("scripted concurrency never shows two asks at once (maxActive == 1)", async () => {
    const { prompter, questions, maxActive } = makeScriptedPrompter(["y", "n", "a"]);
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const results = await Promise.all([
      broker.requestPermission(makeRequest({ toolName: "Write" })),
      broker.requestPermission(makeRequest({ toolName: "Read" })),
      broker.requestPermission(makeRequest({ toolName: "Bash" })),
    ]);
    expect(maxActive()).toBe(1);
    expect(questions[0]).toContain("[permission] Write");
    expect(questions[1]).toContain("[permission] Read");
    expect(questions[2]).toContain("[permission] Bash");
    expect(results.map((r) => r.behavior)).toEqual(["allow", "deny", "allow"]);
  });

  it("first answer wins: a settled allow is not overwritten by a later abort", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const ac = new AbortController();
    const p1 = broker.requestPermission(makeRequest({ toolName: "Write" }), { signal: ac.signal });
    const p2 = broker.requestPermission(makeRequest({ toolName: "Read" }), { signal: ac.signal });
    const p3 = broker.requestPermission(makeRequest({ toolName: "Bash" }), { signal: ac.signal });

    asks[0]!.resolve("y");
    await flush();
    expect(asks).toHaveLength(2); // #2 now shown

    ac.abort();
    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1).toEqual({ behavior: "allow" }); // first answer wins, untouched by abort
    expect(d2).toEqual({ behavior: "deny", reason: "turn cancelled" });
    expect(d3).toEqual({ behavior: "deny", reason: "turn cancelled" });
  });
});

describe("TerminalPermissionBroker cancellation", () => {
  it("abort denies the shown ask and every parked ask with 'turn cancelled'", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const ac = new AbortController();
    const p1 = broker.requestPermission(makeRequest({ toolName: "Write" }), { signal: ac.signal });
    const p2 = broker.requestPermission(makeRequest({ toolName: "Read" }), { signal: ac.signal });
    const p3 = broker.requestPermission(makeRequest({ toolName: "Bash" }), { signal: ac.signal });
    expect(asks).toHaveLength(1); // one shown, two queued

    ac.abort();
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([
      { behavior: "deny", reason: "turn cancelled" },
      { behavior: "deny", reason: "turn cancelled" },
      { behavior: "deny", reason: "turn cancelled" },
    ]);
  });

  it("a signal already aborted at request time denies immediately without showing", async () => {
    const { prompter, asks } = makeManualPrompter();
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(prompter);
    const ac = new AbortController();
    ac.abort();
    await expect(broker.requestPermission(makeRequest(), { signal: ac.signal })).resolves.toEqual({
      behavior: "deny",
      reason: "turn cancelled",
    });
    expect(asks).toHaveLength(0);
  });
});

describe("TerminalPermissionBroker fail-closed pre-attach", () => {
  it("denies every ask before attachPrompter is called", async () => {
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    const decision = await broker.requestPermission(makeRequest({ toolName: "Write" }));
    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
      expect(decision.reason).toContain("Write");
    }
  });
});

describe("createReadlinePrompter (real readline over PassThrough)", () => {
  it("resolves with the typed line", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output });
    const prompter = createReadlinePrompter(rl);
    const pending = prompter.ask("answer [y/n/a]: ");
    input.write("y\n");
    await expect(pending).resolves.toBe("y");
    rl.close();
  });

  it("rejects with an AbortError, emits a newline, and leaves no hung promise on abort", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const rl = createInterface({ input, output });
    const prompter = createReadlinePrompter(rl);
    const ac = new AbortController();
    const pending = prompter.ask("answer [y/n/a]: ", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(out).toContain("\n");
    rl.close();
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const rl = createInterface({ input, output });
    const prompter = createReadlinePrompter(rl);
    const ac = new AbortController();
    ac.abort();
    await expect(prompter.ask("answer [y/n/a]: ", { signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(out).toContain("\n");
    rl.close();
  });
});

describe("TerminalPermissionBroker with a real readline prompter", () => {
  it("presents the ask block and resolves allow when the user types y", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const rl = createInterface({ input, output });
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(createReadlinePrompter(rl));

    const pending = broker.requestPermission(makeRequest({ toolName: "Write" }));
    await flush();
    expect(out).toContain("[permission] Write");
    expect(out).toContain("answer [y/n/a]:");

    input.write("y\n");
    await expect(pending).resolves.toEqual({ behavior: "allow" });
    rl.close();
  });

  it("maps a real prompter abort to a deny (turn cancelled) with a newline emitted", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const rl = createInterface({ input, output });
    const broker = new TerminalPermissionBroker(new SessionPermissionRules(), theme);
    broker.attachPrompter(createReadlinePrompter(rl));

    const ac = new AbortController();
    const pending = broker.requestPermission(makeRequest({ toolName: "Write" }), { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(pending).resolves.toEqual({ behavior: "deny", reason: "turn cancelled" });
    expect(out).toContain("\n");
    rl.close();
  });
});
