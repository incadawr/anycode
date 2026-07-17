import { describe, expect, it } from "vitest";
import type {
  BackgroundTaskSnapshot,
  CommandHookDeclaration,
  LspServerStatus,
  McpServerStatus,
  TelemetryStatus,
} from "@anycode/core";
import {
  gitCommandMessageSchema,
  lspStatusRequestSchema,
  taskKillRequestSchema,
  taskListRequestSchema,
  taskOutputRequestSchema,
  uiToHostMessageSchema,
} from "./protocol.js";
import type { GitCommandOutcome, HostToUiMessage, WireEnvStatus, WireGitStatus } from "./protocol.js";

describe("set_model protocol (slice P7.15 · F14)", () => {
  it("accepts a non-empty model id and fails closed on junk", () => {
    expect(uiToHostMessageSchema.safeParse({ type: "set_model", model: "glm-4.6" }).success).toBe(true);
    // empty / missing / wrong-type / over-length / extra keys all fail closed
    expect(uiToHostMessageSchema.safeParse({ type: "set_model", model: "" }).success).toBe(false);
    expect(uiToHostMessageSchema.safeParse({ type: "set_model" }).success).toBe(false);
    expect(uiToHostMessageSchema.safeParse({ type: "set_model", model: 42 }).success).toBe(false);
    expect(uiToHostMessageSchema.safeParse({ type: "set_model", model: "x".repeat(257) }).success).toBe(false);
    expect(uiToHostMessageSchema.safeParse({ type: "set_model", model: "glm-4.6", extra: 1 }).success).toBe(false);
  });

  it("model_changed is structured-clone-safe trusted data (host->ui, no zod)", () => {
    const changed = {
      type: "model_changed",
      model: "glm-5.2",
      reasoningEffort: "high",
      availableEffortLevels: ["off", "high", "max"],
    } satisfies HostToUiMessage;
    expect(structuredClone(changed)).toEqual(changed);
    // a non-reasoning switch omits availableEffortLevels and reports "off"
    const nonReasoning = {
      type: "model_changed",
      model: "glm-4.6",
      reasoningEffort: "off",
    } satisfies HostToUiMessage;
    expect(structuredClone(nonReasoning)).toEqual(nonReasoning);
  });

  // TASK.56 W2: `imageInput` is additive + optional on both hello and
  // model_changed. The two `satisfies` blocks ABOVE (and the host_ready ones
  // below) are the compile-time proof that pre-TASK.56 message snapshots
  // WITHOUT the field remain valid; this test covers the field-present shape.
  it("carries the additive TASK.56 imageInput model verdict as structured-clone-safe data", () => {
    const changed = {
      type: "model_changed",
      model: "glm-4.6",
      reasoningEffort: "off",
      imageInput: false,
    } satisfies HostToUiMessage;
    const ready = {
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "claude-sonnet",
      sessionId: "s1",
      imageInput: true,
    } satisfies HostToUiMessage;
    expect(structuredClone(changed)).toEqual(changed);
    expect(structuredClone(ready)).toEqual(ready);
  });
});

describe("set_reasoning_effort protocol", () => {
  it("accepts every core reasoning level and rejects unknown values", () => {
    for (const effort of ["off", "low", "medium", "high", "max"]) {
      expect(uiToHostMessageSchema.safeParse({ type: "set_reasoning_effort", effort }).success).toBe(true);
    }
    expect(uiToHostMessageSchema.safeParse({ type: "set_reasoning_effort", effort: "xhigh" }).success).toBe(false);
  });

  it("host_ready and change messages carry available effort levels as structured-clone-safe data", () => {
    const ready = {
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "glm-5.2",
      sessionId: "s1",
      reasoningEffort: "off",
      availableEffortLevels: ["off", "high", "max"],
    } satisfies HostToUiMessage;
    const changed = {
      type: "reasoning_effort_changed",
      effort: "max",
      availableEffortLevels: ["off", "high", "max"],
    } satisfies HostToUiMessage;

    expect(structuredClone(ready)).toEqual(ready);
    expect(structuredClone(changed)).toEqual(changed);
  });
});

describe("external engine host_ready projection", () => {
  it("is structured-clone-safe and remains absent for the legacy core wire", () => {
    const core = {
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "m1",
      sessionId: "core-session",
    } satisfies HostToUiMessage;
    const codex = {
      ...core,
      engine: {
        id: "codex",
        capabilities: {
          supportsCorePermissions: false,
          supportsRewind: false,
          supportsWorkflow: false,
          supportsGitMutations: false,
          supportsContextUsage: true,
          supportsContextBreakdown: false,
          supportsInteractiveApprovals: true,
          costAccounting: false,
          supportsModelSelection: false,
          supportsReasoningEffort: false,
          supportsImages: false,
          supportsTasks: false,
          supportsFileSnapshots: false,
        },
      },
    } satisfies HostToUiMessage;

    expect("engine" in core).toBe(false);
    expect(structuredClone(codex)).toEqual(codex);
  });
});

// Slice 3.2 (design slice-3.2-cut.md §3.5): the additive `mcp_status`
// HostToUiMessage variant. This host->renderer direction is trusted and carries
// NO zod schema (only the untrusted UiToHostMessage direction is validated); the
// one protocol invariant is structured-clone safety (protocol.ts header). This
// task adds only the variant — sending/consuming is task 3.2.4.
describe("HostToUiMessage mcp_status", () => {
  it("is a structured-clone-safe additive variant carrying McpServerStatus[]", () => {
    const servers: McpServerStatus[] = [
      { name: "srv1", transport: "stdio", state: "connected", toolCount: 12, toolsTruncated: false },
      {
        name: "srv2",
        transport: "http",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: "connect timeout",
      },
    ];
    // `satisfies` is the compile-time proof the variant is part of the union.
    const message = { type: "mcp_status", servers } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("mcp_status");
    expect(cloned.servers.map((s) => s.name)).toEqual(["srv1", "srv2"]);
    expect(cloned.servers[1]?.error).toBe("connect timeout");
  });
});

describe("LSP status protocol", () => {
  it("accepts the exact lsp_status_request shape and rejects extras", () => {
    expect(lspStatusRequestSchema.safeParse({ type: "lsp_status_request" }).success).toBe(true);
    expect(uiToHostMessageSchema.safeParse({ type: "lsp_status_request" }).success).toBe(true);
    expect(lspStatusRequestSchema.safeParse({ type: "lsp_status_request", extra: true }).success).toBe(false);
  });

  it("lsp_status is structured-clone-safe with LspServerStatus[]", () => {
    const servers: LspServerStatus[] = [
      { name: "typescript", state: "ready", pid: 1234, extensions: [".ts", ".tsx"], stderrTail: "" },
      { name: "python", state: "crashed", extensions: [".py"], stderrTail: "traceback tail" },
    ];
    const message = { type: "lsp_status", servers } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("lsp_status");
    expect(cloned.servers[0]?.state).toBe("ready");
    expect(cloned.servers[1]?.stderrTail).toBe("traceback tail");
  });
});

describe("Hooks list protocol", () => {
  it("hooks_list is structured-clone-safe with CommandHookDeclaration[] and configError", () => {
    const hooks: CommandHookDeclaration[] = [
      { event: "PreToolUse", matcher: "Write|Edit", command: "./guard.sh", timeoutMs: 2500 },
      { event: "Stop", command: "./cleanup.sh" },
    ];
    const message = { type: "hooks_list", hooks, configError: "bad config" } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("hooks_list");
    expect(cloned.hooks[0]?.matcher).toBe("Write|Edit");
    expect(cloned.configError).toBe("bad config");
  });
});

describe("Background jobs protocol", () => {
  const snapshot: BackgroundTaskSnapshot = {
    taskId: "task-1",
    command: "pnpm test",
    status: "running",
    exitCode: null,
    startedAt: 1,
    outputBytes: 10,
    outputTruncated: false,
  };

  it("accepts task list/output requests and confirmed kill only", () => {
    expect(taskListRequestSchema.safeParse({ type: "task_list_request" }).success).toBe(true);
    expect(taskOutputRequestSchema.safeParse({ type: "task_output_request", taskId: "task-1" }).success).toBe(true);
    expect(
      taskKillRequestSchema.safeParse({
        type: "task_kill_request",
        requestId: "r1",
        taskId: "task-1",
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      uiToHostMessageSchema.safeParse({
        type: "task_kill_request",
        requestId: "r1",
        taskId: "task-1",
      }).success,
    ).toBe(false);
  });

  it("task host messages are structured-clone-safe", () => {
    const messages: HostToUiMessage[] = [
      { type: "task_list", tasks: [snapshot] },
      { type: "task_output", taskId: "task-1", snapshot, newOutput: "ok\n" },
      { type: "task_kill_result", requestId: "r1", ok: false, reason: "not running" },
    ];

    for (const message of messages) {
      expect(structuredClone(message)).toEqual(message);
    }
  });
});

describe("user_message images protocol", () => {
  const image = { mediaType: "image/png", data: "QUJD", sourcePath: "shot.png" };

  it("accepts optional ImageAttachment[] on user_message", () => {
    const message = { type: "user_message", requestId: "r1", text: "look", images: [image] };

    const parsed = uiToHostMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(structuredClone(message)).toEqual(message);
  });

  it("rejects unsupported media types, extra image keys, and more than 8 images", () => {
    expect(
      uiToHostMessageSchema.safeParse({
        type: "user_message",
        requestId: "r1",
        text: "look",
        images: [{ mediaType: "image/svg+xml", data: "PHN2Zy8+" }],
      }).success,
    ).toBe(false);
    expect(
      uiToHostMessageSchema.safeParse({
        type: "user_message",
        requestId: "r1",
        text: "look",
        images: [{ ...image, extra: true }],
      }).success,
    ).toBe(false);
    expect(
      uiToHostMessageSchema.safeParse({
        type: "user_message",
        requestId: "r1",
        text: "look",
        images: Array.from({ length: 9 }, () => image),
      }).success,
    ).toBe(false);
  });
});

// Phase 4 slice 4.4-T (design feature-session-titles.md §4): the additive
// `title_changed` HostToUiMessage variant. Same posture as `mcp_status`
// above — trusted host->renderer direction, no zod schema, the one protocol
// invariant is structured-clone safety.
describe("HostToUiMessage title_changed", () => {
  it("is a structured-clone-safe additive variant carrying a plain title string", () => {
    const message = { type: "title_changed", title: "Fix the flaky test" } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("title_changed");
    expect(cloned.title).toBe("Fix the flaky test");
  });
});

// Slice 5.7 (design slice-5.7-cut.md §2.1): the additive host->renderer git wire
// variants. Same posture as `mcp_status`/`title_changed` above — trusted
// direction, NO zod schema; the one protocol invariant is structured-clone
// safety (protocol.ts header). Consuming lands in slice 5.8; this task adds only
// the variants + their frozen shapes.
describe("HostToUiMessage git_status / git_result", () => {
  it("git_status survives structuredClone with a populated WireGitStatus", () => {
    const status: WireGitStatus = {
      head: { branch: "main", detached: false, sha: "abcdef0", ahead: 1, behind: null },
      staged: [{ path: "src/a.ts", kind: "modified" }],
      unstaged: [{ path: "src/b.ts", kind: "added" }, { path: "old.ts", kind: "renamed", renamedFrom: "older.ts" }],
      untracked: ["scratch.txt"],
      dirtyCount: 4,
      filesTruncated: false,
    };
    const message = { type: "git_status", status } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("git_status");
    expect(cloned.status?.head.branch).toBe("main");
    expect(cloned.status?.dirtyCount).toBe(4);
    expect(cloned.status?.unstaged[1]?.renamedFrom).toBe("older.ts");
  });

  it("git_status survives structuredClone with a null status (git unavailable)", () => {
    const message = { type: "git_status", status: null } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("git_status");
    expect(cloned.status).toBeNull();
  });

  it("git_result survives structuredClone for every GitCommandOutcome kind", () => {
    const outcomes: GitCommandOutcome[] = [
      { ok: false, reason: "git queue full; try again" },
      { ok: true, kind: "unit" },
      { ok: true, kind: "branches", branches: [{ name: "main", current: true, sha: "abcdef0" }] },
      { ok: true, kind: "log", commits: [{ sha: "abcdef0", authorName: "Ada", authorDate: 1_700_000_000_000, subject: "init" }] },
      { ok: true, kind: "diff", diff: "@@ -1 +1 @@\n-old\n+new", truncated: true },
      { ok: true, kind: "commit", sha: "deadbeefcafef00d" },
    ];

    for (const outcome of outcomes) {
      const message = { type: "git_result", requestId: "req-1", outcome } satisfies HostToUiMessage;
      const cloned = structuredClone(message);
      expect(cloned).toEqual(message);
      expect(cloned.type).toBe("git_result");
      expect(cloned.requestId).toBe("req-1");
      expect(cloned.outcome.ok).toBe(outcome.ok);
    }
  });
});

// Slice P7.8 (design slice-P7.8-cut.md §3.1): the additive `env_status`
// host->renderer composite. Same posture as `mcp_status`/`git_status` above —
// trusted direction, NO zod schema; the one protocol invariant is
// structured-clone safety. Both fields independently nullable (disabled).
describe("HostToUiMessage env_status", () => {
  it("survives structuredClone with both telemetry and repoMap populated", () => {
    const telemetry: TelemetryStatus = {
      filePath: "/home/user/.anycode/telemetry/s1.jsonl",
      written: 42,
      dropped: 1,
      lastWriteError: "ENOSPC",
    };
    const repoMap: WireEnvStatus["repoMap"] = {
      fileCount: 120,
      includedCount: 100,
      truncated: true,
      maxTokens: 4_000,
    };
    const message = { type: "env_status", status: { telemetry, repoMap } } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.type).toBe("env_status");
    expect(cloned.status.telemetry?.written).toBe(42);
    expect(cloned.status.telemetry?.lastWriteError).toBe("ENOSPC");
    expect(cloned.status.repoMap?.includedCount).toBe(100);
    expect(cloned.status.repoMap?.truncated).toBe(true);
  });

  it("survives structuredClone with both fields null (disabled)", () => {
    const message = { type: "env_status", status: { telemetry: null, repoMap: null } } satisfies HostToUiMessage;

    const cloned = structuredClone(message);
    expect(cloned).toEqual(message);
    expect(cloned.status.telemetry).toBeNull();
    expect(cloned.status.repoMap).toBeNull();
  });
});

// Slice 5.7 (design slice-5.7-cut.md §6#2): the untrusted UiToHostMessage git
// side is the security surface of this slice. Valid commands parse; garbage
// (nonexistent ops, cap violations, extra keys, wrong types) MUST fail closed so
// it never reaches the host git bridge.
describe("gitCommandMessageSchema accept/reject matrix", () => {
  const accepts: Array<{ name: string; msg: unknown }> = [
    { name: "refresh", msg: { type: "git_command", requestId: "r1", command: { op: "refresh" } } },
    { name: "branches", msg: { type: "git_command", requestId: "r1", command: { op: "branches" } } },
    { name: "log (no limit)", msg: { type: "git_command", requestId: "r1", command: { op: "log" } } },
    { name: "log (limit)", msg: { type: "git_command", requestId: "r1", command: { op: "log", limit: 50 } } },
    { name: "diff (bare)", msg: { type: "git_command", requestId: "r1", command: { op: "diff" } } },
    {
      name: "diff (target + path)",
      msg: { type: "git_command", requestId: "r1", command: { op: "diff", target: "staged", path: "src/x.ts" } },
    },
    {
      name: "switch_branch",
      msg: { type: "git_command", requestId: "r1", command: { op: "switch_branch", name: "feature/x" } },
    },
    {
      name: "create_branch (switch)",
      msg: { type: "git_command", requestId: "r1", command: { op: "create_branch", name: "feature/x", switch: true } },
    },
    {
      name: "stage",
      msg: { type: "git_command", requestId: "r1", command: { op: "stage", paths: ["a.ts", "b.ts"] } },
    },
    {
      name: "unstage",
      msg: { type: "git_command", requestId: "r1", command: { op: "unstage", paths: ["a.ts"] } },
    },
    { name: "stage_all", msg: { type: "git_command", requestId: "r1", command: { op: "stage_all" } } },
    {
      name: "commit",
      msg: { type: "git_command", requestId: "r1", command: { op: "commit", message: "chore: land the wire" } },
    },
  ];

  const rejects: Array<{ name: string; msg: unknown }> = [
    { name: "op:discard (nonexistent op)", msg: { type: "git_command", requestId: "r1", command: { op: "discard" } } },
    { name: "op:stash (nonexistent op)", msg: { type: "git_command", requestId: "r1", command: { op: "stash" } } },
    {
      name: "op:push (nonexistent op)",
      msg: { type: "git_command", requestId: "r1", command: { op: "push", remote: "origin" } },
    },
    {
      name: "extra key on command (.strict)",
      msg: { type: "git_command", requestId: "r1", command: { op: "refresh", force: true } },
    },
    {
      name: "extra key on envelope (.strict)",
      msg: { type: "git_command", requestId: "r1", command: { op: "refresh" }, extra: 1 },
    },
    {
      name: "switch_branch name of 513 chars",
      msg: { type: "git_command", requestId: "r1", command: { op: "switch_branch", name: "x".repeat(513) } },
    },
    {
      name: "commit message of 10_001 chars",
      msg: { type: "git_command", requestId: "r1", command: { op: "commit", message: "x".repeat(10_001) } },
    },
    { name: "stage paths []", msg: { type: "git_command", requestId: "r1", command: { op: "stage", paths: [] } } },
    {
      name: "stage paths of 1001 elements",
      msg: {
        type: "git_command",
        requestId: "r1",
        command: { op: "stage", paths: Array.from({ length: 1001 }, (_v, i) => `f${i}.ts`) },
      },
    },
    {
      name: "requestId wrong type (42)",
      msg: { type: "git_command", requestId: 42, command: { op: "refresh" } },
    },
  ];

  it.each(accepts)("accepts $name", ({ msg }) => {
    expect(gitCommandMessageSchema.safeParse(msg).success).toBe(true);
  });

  it.each(rejects)("rejects $name (fail-closed)", ({ msg }) => {
    expect(gitCommandMessageSchema.safeParse(msg).success).toBe(false);
  });
});

// Slice 5.8 (design slice-5.8-cut.md §2.3 / §6#5): the destructive tail. Every
// destructive op is INEXPRESSIBLE without `confirmed: z.literal(true)` — the zod
// boundary is where the confirm-gate is enforced (the host bridge re-checks nothing,

// or an out-of-enum reset mode all fail closed BEFORE any git spawn.
describe("gitCommandMessageSchema destructive confirmed-gate matrix (§6#5)", () => {
  const cmd = (command: unknown): unknown => ({ type: "git_command", requestId: "r1", command });

  const accepts: Array<{ name: string; msg: unknown }> = [
    { name: "discard (confirmed:true)", msg: cmd({ op: "discard", paths: ["a.ts"], confirmed: true }) },
    { name: "discard (many paths)", msg: cmd({ op: "discard", paths: ["a.ts", "b.ts"], confirmed: true }) },
    { name: "stash_push (bare, confirmed:true)", msg: cmd({ op: "stash_push", confirmed: true }) },
    {
      name: "stash_push (message + includeUntracked)",
      msg: cmd({ op: "stash_push", message: "wip", includeUntracked: true, confirmed: true }),
    },
    { name: "stash_pop (confirmed:true)", msg: cmd({ op: "stash_pop", confirmed: true }) },
    { name: "reset mixed (confirmed:true)", msg: cmd({ op: "reset", mode: "mixed", confirmed: true }) },
    { name: "reset hard (confirmed:true)", msg: cmd({ op: "reset", mode: "hard", confirmed: true }) },
  ];

  const rejects: Array<{ name: string; msg: unknown }> = [
    // The heart of §6#5: a destructive op WITHOUT an explicit confirmed:true.
    { name: "discard without confirmed", msg: cmd({ op: "discard", paths: ["a.ts"] }) },
    { name: "discard confirmed:false", msg: cmd({ op: "discard", paths: ["a.ts"], confirmed: false }) },
    { name: 'discard confirmed:"true" (string)', msg: cmd({ op: "discard", paths: ["a.ts"], confirmed: "true" }) },
    { name: "discard confirmed:1 (number)", msg: cmd({ op: "discard", paths: ["a.ts"], confirmed: 1 }) },
    {
      name: "discard extra key under .strict()",
      msg: cmd({ op: "discard", paths: ["a.ts"], confirmed: true, force: true }),
    },
    { name: "discard empty paths []", msg: cmd({ op: "discard", paths: [], confirmed: true }) },
    { name: "stash_push without confirmed", msg: cmd({ op: "stash_push" }) },
    {
      name: "stash_push message too long (10_001)",
      msg: cmd({ op: "stash_push", message: "x".repeat(10_001), confirmed: true }),
    },
    { name: "stash_pop without confirmed", msg: cmd({ op: "stash_pop" }) },
    { name: "stash_pop confirmed:false", msg: cmd({ op: "stash_pop", confirmed: false }) },
    { name: "reset without confirmed", msg: cmd({ op: "reset", mode: "hard" }) },
    { name: "reset without mode", msg: cmd({ op: "reset", confirmed: true }) },
    { name: 'reset mode:"soft" (not in enum)', msg: cmd({ op: "reset", mode: "soft", confirmed: true }) },
  ];

  it.each(accepts)("accepts $name", ({ msg }) => {
    expect(gitCommandMessageSchema.safeParse(msg).success).toBe(true);
  });

  it.each(rejects)("rejects $name (fail-closed)", ({ msg }) => {
    expect(gitCommandMessageSchema.safeParse(msg).success).toBe(false);
  });
});
