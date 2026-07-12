/**
 * Slash-command help/exit tests (design slice-4.1-cut.md §5.2 item 6):
 * COMMAND_HELP's final (non-placeholder) summary texts, the /help render, and
 * /quit + /exit calling deps.requestExit (the REPL's normal dispose/flush exit
 * seam — the full runCli-level proof that /quit actually terminates the REPL
 * lives in main.test.ts, owned by task 4.1.1; this file unit-tests the
 * dispatcher's OWN behaviour in isolation). Unknown-command listing the new
 * 11-command set (slice 4.2 adds /reasoning, slice 4.3 adds /mode, slice 4.4
 * adds /sessions) plus the /mode command behaviour (design slice-4.3-cut.md
 * §2.6) and the /sessions handler (design slice-4.4-cut.md §2.3) are covered
 * here too. Slice 4.6 (design slice-4.6-cut.md §2.3) adds `/model` (12-command

 * Slice 4.7 (design slice-4.7-cut.md §2.8) adds `/rewind` (13-command set)
 * and its makeDeps `rewind` stub (same hazard, added to the ONE factory).
 * Slice 5.5 wave C (design slice-5.5-cut.md §2/C3) adds `/tasks` (18-command
 * set) and its makeDeps `tasks` stub (same hazard, added to the ONE factory).
 * Slice 6.1 wave D (design slice-6.1-cut.md §2-D2) adds `/lsp` (19-command
 * set) and its makeDeps `lsp` stub (same hazard, added to the ONE factory).
 * Slice 6.2 wave D (design slice-6.2-cut.md §2-D3) adds `/image` (20-command
 * set) and its makeDeps `images` stub (same hazard, added to the ONE factory).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_HELP,
  KNOWN_SLASH_COMMANDS,
  handleSlashCommand,
  renderCommandHelp,
  type SlashCommandDeps,
} from "./commands.js";
import { SessionPermissionRules } from "../permissions/index.js";
import type { CommandHookDeclaration } from "../dispatch/index.js";
import type { AgentLoop, ContextBreakdown, ContextInfo } from "../loop/index.js";
import type { McpManager } from "../mcp/index.js";
import type { CheckpointMeta } from "../ports/checkpoints.js";
import type { GitStatusSummary } from "../ports/git.js";
import type { SessionMeta } from "../ports/persistence.js";
import type { SkillPort } from "../ports/skills.js";
import type { LspServerStatus } from "../ports/lsp.js";
import type { TelemetryStatus } from "../ports/telemetry.js";
import type { BackgroundTaskSnapshot } from "../ports/tasks.js";
import type { ImageMediaType } from "../types/images.js";
import { renderCommitSummary, renderGitStatus } from "./git.js";
import { formatContextBreakdown, formatContextInfo, renderHooksTable, renderLspTable, renderTasksTable, renderTelemetryStatus } from "./render.js";
import { renderCheckpointsTable } from "./rewind.js";
import { SESSIONS_LIST_LIMIT } from "./sessions.js";

function makeDeps(overrides?: Partial<SlashCommandDeps>): { deps: SlashCommandDeps; getText: () => string } {
  let text = "";
  const deps: SlashCommandDeps = {
    loop: {} as unknown as AgentLoop,
    rules: new SessionPermissionRules(),
    write: (chunk: string) => {
      text += chunk;
    },
    mcp: { status: () => [] } as unknown as McpManager,
    skills: { list: () => [], load: async () => undefined } as SkillPort,
    workflows: [],
    requestExit: vi.fn(),
    toggleReasoning: vi.fn(() => true),
    getReasoningEffort: () => "off",
    setReasoningEffort: vi.fn(() => null),
    getMode: () => "build",
    setMode: vi.fn(() => null),
    model: { get: () => "test-model", set: vi.fn(() => null), hints: [] },
    sessions: { list: vi.fn(async () => []), currentId: "s", workspace: "/w" },
    rewind: {
      enabled: true,
      list: vi.fn(async () => [] as CheckpointMeta[]),
      confirm: vi.fn(async () => true),
      restore: vi.fn(async () => ({
        ok: true as const,
        restoredPaths: 0,
        conversationRestored: false,
        safetyCheckpointId: "safetyid0000",
      })),
    },
    git: {
      enabled: true,
      status: vi.fn(async () => ({ ok: true as const, value: makeStatus() })),
      diff: vi.fn(async () => ({ ok: true as const, value: "" })),
      confirm: vi.fn(async () => true),
      commit: vi.fn(async () => ({ ok: true as const, value: { sha: "deadbeefcafef00d1234" } })),
    },
    hooks: { list: vi.fn(() => [] as readonly CommandHookDeclaration[]) },
    tasks: { list: vi.fn(() => [] as BackgroundTaskSnapshot[]), kill: vi.fn(() => false) },
    lsp: { status: vi.fn(() => [] as LspServerStatus[]) },
    telemetry: { status: vi.fn(() => null as TelemetryStatus | null) },
    images: {
      stage: vi.fn(async () => ({ ok: true as const, basename: "shot.png", mediaType: "image/png" as ImageMediaType, kb: 12, staged: 1 })),
      list: vi.fn(() => [] as Array<{ basename: string; mediaType: ImageMediaType; kb: number }>),
      clear: vi.fn(() => 0),
    },
    ...overrides,
  };
  return { deps, getText: () => text };
}

/** A clean-tree GitStatusSummary on `main`, overridable per test (slice 5.4). */
function makeStatus(overrides?: Partial<GitStatusSummary>): GitStatusSummary {
  return {
    head: { branch: "main", detached: false, sha: "abc1234def", ahead: null, behind: null },
    staged: [],
    unstaged: [],
    untracked: [],
    ...overrides,
  };
}

describe("COMMAND_HELP (design §2.4/§3.3) — final summary texts", () => {
  it("has exactly one entry per KNOWN_SLASH_COMMANDS, same order", () => {
    expect(COMMAND_HELP.map((entry) => entry.command)).toEqual([...KNOWN_SLASH_COMMANDS]);
  });

  it("every summary is a real, non-empty, non-placeholder line", () => {
    for (const entry of COMMAND_HELP) {
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.summary).not.toContain("summary set in task 4.1.4");
      expect(entry.summary).not.toBe("");
    }
  });

  it("/quit and /exit both have a defined, distinct-key summary describing the same exit behaviour", () => {
    const quit = COMMAND_HELP.find((entry) => entry.command === "/quit");
    const exit = COMMAND_HELP.find((entry) => entry.command === "/exit");
    expect(quit).toBeDefined();
    expect(exit).toBeDefined();
    // /exit is documented as an alias of /quit (design §2.4: both call
    // deps.requestExit identically) — its summary references /quit rather
    // than duplicating the full description.
    expect(exit?.summary.toLowerCase()).toContain("/quit");
  });
});

describe("renderCommandHelp — column alignment", () => {
  it("pads every command to the widest command's width, then two spaces, then the summary", () => {
    const rendered = renderCommandHelp(COMMAND_HELP);
    const width = Math.max(...COMMAND_HELP.map((entry) => entry.command.length));
    for (const entry of COMMAND_HELP) {
      expect(rendered).toContain(`${entry.command.padEnd(width)}  ${entry.summary}`.trimEnd());
    }
    expect(rendered.endsWith("\n")).toBe(true);
  });
});

describe("handleSlashCommand — /help, /quit, /exit, unknown (design §2.4/§2.6-para.8)", () => {
  it("/help writes the renderCommandHelp(COMMAND_HELP) table", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toBe(renderCommandHelp(COMMAND_HELP));
  });

  it("/help lists /model (slice 4.6)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/model");
  });

  it("/help lists /rewind (slice 4.7)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/rewind");
  });

  it("/help lists /hooks (slice 5.6)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/hooks");
  });

  it("/help lists /tasks (slice 5.5)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/tasks");
  });

  it("/help lists /lsp (slice 6.1)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/lsp");
  });

  it("/help lists /image (slice 6.2)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/image");
  });

  it("/help lists /context (slice 6.4)", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/help", deps);
    expect(getText()).toContain("/context");
  });

  it("/quit calls requestExit exactly once and writes nothing", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/quit", deps);
    expect(deps.requestExit).toHaveBeenCalledTimes(1);
    expect(getText()).toBe("");
  });

  it("/exit calls requestExit exactly once and writes nothing", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/exit", deps);
    expect(deps.requestExit).toHaveBeenCalledTimes(1);
    expect(getText()).toBe("");
  });

  it("an unknown command lists the CURRENT 23-command set", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/bogus", deps);
    expect(getText()).toBe(
      "[unknown command: /bogus] known commands: /compact, /allow, /mcp, /skills, /workflows, /sessions, /rewind, /reasoning, /mode, /model, /status, /diff, /commit, /hooks, /tasks, /lsp, /image, /context, /telemetry, /repo-map, /help, /quit, /exit\n",
    );
  });

  it("/reasoning flips the reasoning-render state and reports the NEW value (design §2.6)", async () => {
    const toggleReasoning = vi.fn(() => false);
    const { deps, getText } = makeDeps({ toggleReasoning });
    await handleSlashCommand("/reasoning", deps);
    expect(toggleReasoning).toHaveBeenCalledTimes(1);
    expect(getText()).toBe("[reasoning] rendering is now off; model effort=off\n");
  });

  it("/reasoning reports 'on' when the toggle returns true", async () => {
    const { deps, getText } = makeDeps({ toggleReasoning: vi.fn(() => true) });
    await handleSlashCommand("/reasoning", deps);
    expect(getText()).toBe("[reasoning] rendering is now on; model effort=off\n");
  });

  it("/reasoning <level> sets model effort without toggling rendering", async () => {
    const setReasoningEffort = vi.fn(() => null);
    const toggleReasoning = vi.fn(() => true);
    const { deps, getText } = makeDeps({ setReasoningEffort, toggleReasoning });
    await handleSlashCommand("/reasoning high", deps);
    expect(setReasoningEffort).toHaveBeenCalledWith("high");
    expect(toggleReasoning).not.toHaveBeenCalled();
    expect(getText()).toBe("[reasoning] model effort is now high\n");
  });
});

describe("KNOWN_SLASH_COMMANDS (design §2.4, extended slice 4.2 §2.6, slice 4.3 §2.6, slice 4.4 §2.3, slice 4.6 §2.3, slice 4.7 §2.8, slice 5.4 §2.5, slice 5.6 wave C, slice 5.5 wave C, slice 6.1 wave D, slice 6.2 wave D, slice 6.4 wave C, slice 6.6 wave C)", () => {
  it("is the frozen 23-command set, including /repo-map after /telemetry", () => {
    expect(KNOWN_SLASH_COMMANDS).toEqual([
      "/compact",
      "/allow",
      "/mcp",
      "/skills",
      "/workflows",
      "/sessions",
      "/rewind",
      "/reasoning",
      "/mode",
      "/model",
      "/status",
      "/diff",
      "/commit",
      "/hooks",
      "/tasks",
      "/lsp",
      "/image",
      "/context",
      "/telemetry",
      "/repo-map",
      "/help",
      "/quit",
      "/exit",
    ]);
  });
});

describe("handleSlashCommand — /mode (design slice-4.3-cut.md §2.6)", () => {
  it("bare /mode shows the current mode plus the switchable list, and never calls setMode", async () => {
    const setMode = vi.fn(() => null);
    const { deps, getText } = makeDeps({ getMode: () => "plan", setMode });
    await handleSlashCommand("/mode", deps);
    expect(getText()).toBe(
      "[mode] plan — available: plan, build, edit, auto, yolo (switch: /mode <mode>)\n",
    );
    expect(setMode).not.toHaveBeenCalled();
  });

  it("/mode build switches via setMode and reports the new mode", async () => {
    const setMode = vi.fn(() => null);
    const { deps, getText } = makeDeps({ getMode: () => "plan", setMode });
    await handleSlashCommand("/mode build", deps);
    expect(setMode).toHaveBeenCalledWith("build");
    expect(getText()).toBe("[mode] now build\n");
  });

  it("/mode plan switches and prints the ExitPlanMode-flow hint", async () => {
    const setMode = vi.fn(() => null);
    const { deps, getText } = makeDeps({ getMode: () => "build", setMode });
    await handleSlashCommand("/mode plan", deps);
    expect(setMode).toHaveBeenCalledWith("plan");
    expect(getText()).toBe(
      "[mode] now plan\n[mode] research with read-only tools, then call ExitPlanMode with your plan to switch back\n",
    );
  });

  it("/mode yolo switches and warns that every action is auto-allowed", async () => {
    const setMode = vi.fn(() => null);
    const { deps, getText } = makeDeps({ getMode: () => "build", setMode });
    await handleSlashCommand("/mode yolo", deps);
    expect(setMode).toHaveBeenCalledWith("yolo");
    expect(getText()).toBe(
      "[mode] now yolo\n[mode] warning: every action is auto-allowed for this session\n",
    );
  });

  it("a refused switch prints the reason verbatim and reports no new mode", async () => {
    const setMode = vi.fn(() => "--yolo pins the permission broker for this session; restart without --yolo to switch modes");
    const { deps, getText } = makeDeps({ getMode: () => "yolo", setMode });
    await handleSlashCommand("/mode build", deps);
    expect(setMode).toHaveBeenCalledWith("build");
    expect(getText()).toBe(
      "[mode] --yolo pins the permission broker for this session; restart without --yolo to switch modes\n",
    );
  });

  it("an unknown mode word prints the usage line and never calls setMode", async () => {
    const setMode = vi.fn(() => null);
    const { deps, getText } = makeDeps({ setMode });
    await handleSlashCommand("/mode bogus", deps);
    expect(setMode).not.toHaveBeenCalled();
    expect(getText()).toBe("[mode] usage: /mode [plan|build|edit|auto|yolo]\n");
  });
});

describe("handleSlashCommand — /model (design slice-4.6-cut.md §2.3)", () => {
  it("bare /model with catalog hints shows the current id plus provider/models line, and never calls set", async () => {
    const set = vi.fn(() => null);
    const { deps, getText } = makeDeps({
      model: {
        get: () => "glm-4.5",
        set,
        hints: [
          { id: "glm-4.5", contextWindow: 128000 },
          { id: "glm-4.6", contextWindow: 128000 },
        ],
        providerName: "Z.AI (GLM)",
      },
    });
    await handleSlashCommand("/model", deps);
    expect(getText()).toBe(
      "[model] glm-4.5\n[model] provider: Z.AI (GLM) — models: glm-4.5, glm-4.6 (switch: /model <id>)\n",
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("bare /model with no catalog match (no providerName/hints) shows the any-id-accepted line", async () => {
    const { deps, getText } = makeDeps({
      model: { get: () => "custom-model", set: vi.fn(() => null), hints: [] },
    });
    await handleSlashCommand("/model", deps);
    expect(getText()).toBe(
      "[model] custom-model\n[model] switch: /model <model-id> (any model id accepted)\n",
    );
  });

  it("/model glm-4.5 switches via deps.model.set and reports the new id", async () => {
    const set = vi.fn(() => null);
    const { deps, getText } = makeDeps({ model: { get: () => "old-model", set, hints: [] } });
    await handleSlashCommand("/model glm-4.5", deps);
    expect(set).toHaveBeenCalledWith("glm-4.5");
    expect(getText()).toBe("[model] now glm-4.5\n");
  });

  it("a refused switch prints the reason verbatim and reports no new model", async () => {
    const set = vi.fn(() => "model switching is unavailable: this session runs on an injected model port");
    const { deps, getText } = makeDeps({ model: { get: () => "old-model", set, hints: [] } });
    await handleSlashCommand("/model glm-4.5", deps);
    expect(set).toHaveBeenCalledWith("glm-4.5");
    expect(getText()).toBe("[model] model switching is unavailable: this session runs on an injected model port\n");
  });

  it("/model a b (embedded space) prints the usage line and never calls set", async () => {
    const set = vi.fn(() => null);
    const { deps, getText } = makeDeps({ model: { get: () => "m", set, hints: [] } });
    await handleSlashCommand("/model a b", deps);
    expect(set).not.toHaveBeenCalled();
    expect(getText()).toBe("[model] usage: /model [model-id]\n");
  });
});

describe("handleSlashCommand — /sessions (design slice-4.4-cut.md §2.3)", () => {
  it("bare /sessions lists THIS workspace's sessions: list called with {workspace, limit}", async () => {
    const list = vi.fn(async () => [] as SessionMeta[]);
    const { deps, getText } = makeDeps({ sessions: { list, currentId: "s", workspace: "/w" } });
    await handleSlashCommand("/sessions", deps);
    expect(list).toHaveBeenCalledWith({ workspace: "/w", limit: SESSIONS_LIST_LIMIT });
    // Empty result renders the placeholder line (renderSessionsTable's [] branch).
    expect(getText()).toBe("[sessions] none found\n");
  });

  it("/sessions all drops the workspace filter and adds a workspace column, marking the current session", async () => {
    const metas: SessionMeta[] = [
      {
        id: "abcdef012345",
        workspace: "/proj/one",
        model: "m",
        mode: "build",
        createdAt: 0,
        updatedAt: 1000,
        title: "the current one",
      },
      {
        id: "0123456789ab",
        workspace: "/proj/two",
        model: "m",
        mode: "plan",
        createdAt: 0,
        updatedAt: 500,
        title: "another",
      },
    ];
    const list = vi.fn(async () => metas);
    const { deps, getText } = makeDeps({ sessions: { list, currentId: "abcdef012345", workspace: "/w" } });
    await handleSlashCommand("/sessions all", deps);
    // `all` drops the workspace filter — no workspace key at all in the call.
    expect(list).toHaveBeenCalledWith({ limit: SESSIONS_LIST_LIMIT });
    const text = getText();
    expect(text).toContain("workspace");
    expect(text).toContain("/proj/one");
    expect(text).toContain("/proj/two");
    // currentId gets a "*" suffix on its (8-char short) id cell.
    expect(text).toContain("abcdef01*");
  });

  it("/sessions with an unknown argument prints the usage line and never lists", async () => {
    const list = vi.fn(async () => [] as SessionMeta[]);
    const { deps, getText } = makeDeps({ sessions: { list, currentId: "s", workspace: "/w" } });
    await handleSlashCommand("/sessions junk", deps);
    expect(list).not.toHaveBeenCalled();
    expect(getText()).toBe("[sessions] usage: /sessions [all]\n");
  });
});

describe("handleSlashCommand — /rewind (design slice-4.7-cut.md §2.8)", () => {
  // Fixed "now" so formatRelativeTime's age string is deterministic across runs.
  const NOW = 1_700_000_000_000;
  const meta1: CheckpointMeta = {
    id: "abcdef0123456789",
    sessionId: "s",
    commitHash: "commithash0000",
    createdAt: NOW - 60_000,
    reason: "auto",
    label: "add the login form",
  };
  const meta2: CheckpointMeta = {
    id: "0123456789abcdef",
    sessionId: "s",
    commitHash: "commithash1111",
    createdAt: NOW - 3_600_000,
    reason: "auto",
    label: "fix the typo",
  };
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it("disabled: every form refuses up front, including an otherwise-valid restore ref, and never calls list/confirm/restore", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => true);
    const restore = vi.fn();
    const { deps, getText } = makeDeps({ rewind: { enabled: false, list, confirm, restore } });
    await handleSlashCommand("/rewind", deps);
    await handleSlashCommand("/rewind 1", deps);
    await handleSlashCommand("/rewind bogus-shape", deps);
    expect(getText()).toBe(
      "[rewind] checkpoints are disabled for this session\n".repeat(3),
    );
    expect(list).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("bare /rewind with zero checkpoints prints the empty notice", async () => {
    const list = vi.fn(async () => []);
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm: vi.fn(), restore: vi.fn() } });
    await handleSlashCommand("/rewind", deps);
    expect(list).toHaveBeenCalledWith({ limit: SESSIONS_LIST_LIMIT });
    expect(getText()).toBe("[rewind] no checkpoints yet in this session\n");
  });

  it("bare /rewind with checkpoints renders the table via renderCheckpointsTable (delegates the exact column layout to that helper — see cli/rewind.test.ts)", async () => {
    const list = vi.fn(async () => [meta1, meta2]);
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm: vi.fn(), restore: vi.fn() } });
    await handleSlashCommand("/rewind", deps);
    expect(getText()).toBe(renderCheckpointsTable([meta1, meta2], { now: NOW }));
  });

  it("an invalid argument shape prints the usage line and never lists", async () => {
    const list = vi.fn(async () => []);
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm: vi.fn(), restore: vi.fn() } });
    await handleSlashCommand("/rewind one two three", deps);
    expect(list).not.toHaveBeenCalled();
    expect(getText()).toBe("[rewind] usage: /rewind [<#|id> [files|conversation]]\n");
  });

  it("a ref that resolves to nothing prints the no-match notice", async () => {
    const list = vi.fn(async () => [meta1]);
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm: vi.fn(), restore: vi.fn() } });
    await handleSlashCommand("/rewind bogus1", deps);
    expect(getText()).toBe('[rewind] no checkpoint matches "bogus1"\n');
  });

  it("resolves a 1-based index ref and asks the frozen confirm question (scope both by default)", async () => {
    const list = vi.fn(async () => [meta1, meta2]);
    const confirm = vi.fn(async () => false);
    const { deps } = makeDeps({ rewind: { enabled: true, list, confirm, restore: vi.fn() } });
    await handleSlashCommand("/rewind 1", deps);
    expect(confirm).toHaveBeenCalledWith(
      "[rewind] restore files+conversation to checkpoint abcdef01 (add the login form, 1m ago)? [y/N] ",
    );
  });

  it("scope files -> confirm question says 'files'", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => false);
    const { deps } = makeDeps({ rewind: { enabled: true, list, confirm, restore: vi.fn() } });
    await handleSlashCommand("/rewind 1 files", deps);
    expect(confirm).toHaveBeenCalledWith(
      "[rewind] restore files to checkpoint abcdef01 (add the login form, 1m ago)? [y/N] ",
    );
  });

  it("scope conversation -> confirm question says 'conversation'", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => false);
    const { deps } = makeDeps({ rewind: { enabled: true, list, confirm, restore: vi.fn() } });
    await handleSlashCommand("/rewind 1 conversation", deps);
    expect(confirm).toHaveBeenCalledWith(
      "[rewind] restore conversation to checkpoint abcdef01 (add the login form, 1m ago)? [y/N] ",
    );
  });

  it("resolving by id prefix (>=6 chars, unique) works the same as by index", async () => {
    const list = vi.fn(async () => [meta1, meta2]);
    const confirm = vi.fn(async () => false);
    const restore = vi.fn();
    const { deps } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    // "abcdef" is a 6-char prefix of meta1.id only (meta2's id/commitHash don't share it).
    await handleSlashCommand("/rewind abcdef", deps);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("checkpoint abcdef01"));
    expect(restore).not.toHaveBeenCalled();
  });

  it("a refusal (confirm resolves false) cancels and never calls restore", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => false);
    const restore = vi.fn();
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    await handleSlashCommand("/rewind 1", deps);
    expect(restore).not.toHaveBeenCalled();
    expect(getText()).toBe("[rewind] cancelled\n");
  });

  it("restore failure ({ok:false}) prints the reason verbatim", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => true);
    const restore = vi.fn(async () => ({ ok: false as const, reason: "shadow-git is unavailable for this session" }));
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    await handleSlashCommand("/rewind 1", deps);
    expect(restore).toHaveBeenCalledWith(meta1.id, "both");
    expect(getText()).toBe("[rewind] shadow-git is unavailable for this session\n");
  });

  it("success (both scope, files restored and conversation rewound): files line, then conversation line, then the always-present safety line", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => true);
    const restore = vi.fn(async () => ({
      ok: true as const,
      restoredPaths: 3,
      conversationRestored: true,
      safetyCheckpointId: "safety1234567890",
    }));
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    await handleSlashCommand("/rewind 1", deps);
    expect(getText()).toBe(
      "[rewind] restored files: 3 paths\n" +
        "[rewind] conversation rewound to before that turn\n" +
        "[rewind] safety checkpoint safety12 captures the pre-rewind state\n",
    );
  });

  it("success (files-only scope): only the files line + the safety line, no conversation line", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => true);
    const restore = vi.fn(async () => ({
      ok: true as const,
      restoredPaths: 2,
      conversationRestored: false,
      safetyCheckpointId: "safety1234567890",
    }));
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    await handleSlashCommand("/rewind 1 files", deps);
    expect(restore).toHaveBeenCalledWith(meta1.id, "files");
    expect(getText()).toBe(
      "[rewind] restored files: 2 paths\n" +
        "[rewind] safety checkpoint safety12 captures the pre-rewind state\n",
    );
  });

  it("success (conversation-only scope): only the conversation line + the safety line, no files line", async () => {
    const list = vi.fn(async () => [meta1]);
    const confirm = vi.fn(async () => true);
    const restore = vi.fn(async () => ({
      ok: true as const,
      restoredPaths: null,
      conversationRestored: true,
      safetyCheckpointId: "safety1234567890",
    }));
    const { deps, getText } = makeDeps({ rewind: { enabled: true, list, confirm, restore } });
    await handleSlashCommand("/rewind 1 conversation", deps);
    expect(restore).toHaveBeenCalledWith(meta1.id, "conversation");
    expect(getText()).toBe(
      "[rewind] conversation rewound to before that turn\n" +
        "[rewind] safety checkpoint safety12 captures the pre-rewind state\n",
    );
  });
});

describe("handleSlashCommand — /status, /diff, /commit (design slice-5.4-cut.md §2.5)", () => {
  describe("disabled (not a git repo): every command refuses up front with zero port calls", () => {
    it("/status refuses and never calls status", async () => {
      const status = vi.fn();
      const { deps, getText } = makeDeps({
        git: { enabled: false, status, diff: vi.fn(), confirm: vi.fn(), commit: vi.fn() },
      });
      await handleSlashCommand("/status", deps);
      expect(status).not.toHaveBeenCalled();
      expect(getText()).toBe("[status] not a git repository\n");
    });

    it("/diff refuses and never calls diff", async () => {
      const diff = vi.fn();
      const { deps, getText } = makeDeps({
        git: { enabled: false, status: vi.fn(), diff, confirm: vi.fn(), commit: vi.fn() },
      });
      await handleSlashCommand("/diff", deps);
      expect(diff).not.toHaveBeenCalled();
      expect(getText()).toBe("[diff] not a git repository\n");
    });

    it("/commit refuses and never calls status/confirm/commit", async () => {
      const status = vi.fn();
      const confirm = vi.fn();
      const commit = vi.fn();
      const { deps, getText } = makeDeps({
        git: { enabled: false, status, diff: vi.fn(), confirm, commit },
      });
      await handleSlashCommand("/commit fix things", deps);
      expect(status).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(getText()).toBe("[commit] not a git repository\n");
    });
  });

  describe("/status", () => {
    it("renders renderGitStatus(summary) on success", async () => {
      const summary = makeStatus({
        staged: [{ path: "a.ts", kind: "modified" }],
        untracked: ["new.ts"],
      });
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: summary })),
          diff: vi.fn(),
          confirm: vi.fn(),
          commit: vi.fn(),
        },
      });
      await handleSlashCommand("/status", deps);
      expect(getText()).toBe(renderGitStatus(summary));
    });

    it("prints the reason verbatim on failure (the port never throws, R8)", async () => {
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: false as const, reason: "git status failed: fatal: bad object" })),
          diff: vi.fn(),
          confirm: vi.fn(),
          commit: vi.fn(),
        },
      });
      await handleSlashCommand("/status", deps);
      expect(getText()).toBe("[status] git status failed: fatal: bad object\n");
    });
  });

  describe("/diff", () => {
    it("an empty diff prints the no-changes notice", async () => {
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(),
          diff: vi.fn(async () => ({ ok: true as const, value: "" })),
          confirm: vi.fn(),
          commit: vi.fn(),
        },
      });
      await handleSlashCommand("/diff", deps);
      expect(getText()).toBe("[diff] no changes vs HEAD\n");
    });

    it("bare /diff passes no path; /diff <path> forwards the parsed pathspec", async () => {
      const diff = vi.fn(async () => ({ ok: true as const, value: "" }));
      const { deps } = makeDeps({
        git: { enabled: true, status: vi.fn(), diff, confirm: vi.fn(), commit: vi.fn() },
      });
      await handleSlashCommand("/diff", deps);
      expect(diff).toHaveBeenLastCalledWith({});
      await handleSlashCommand("/diff src/app.ts", deps);
      expect(diff).toHaveBeenLastCalledWith({ path: "src/app.ts" });
    });

    it("a non-empty diff is passed through raw (no colorization, R10)", async () => {
      const raw = "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n";
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(),
          diff: vi.fn(async () => ({ ok: true as const, value: raw })),
          confirm: vi.fn(),
          commit: vi.fn(),
        },
      });
      await handleSlashCommand("/diff", deps);
      expect(getText()).toBe(raw);
    });

    it("prints the reason verbatim on failure", async () => {
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(),
          diff: vi.fn(async () => ({ ok: false as const, reason: "git diff failed: fatal: ambiguous argument" })),
          confirm: vi.fn(),
          commit: vi.fn(),
        },
      });
      await handleSlashCommand("/diff", deps);
      expect(getText()).toBe("[diff] git diff failed: fatal: ambiguous argument\n");
    });
  });

  describe("/commit", () => {
    it("an empty message prints the usage line and never touches the port", async () => {
      const status = vi.fn();
      const confirm = vi.fn();
      const commit = vi.fn();
      const { deps, getText } = makeDeps({
        git: { enabled: true, status, diff: vi.fn(), confirm, commit },
      });
      await handleSlashCommand("/commit", deps);
      expect(status).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(getText()).toBe("[commit] usage: /commit <message>\n");
    });

    it("a clean repo prints nothing-to-commit WITHOUT asking for confirmation or committing", async () => {
      const confirm = vi.fn(async () => true);
      const commit = vi.fn();
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: makeStatus() })),
          diff: vi.fn(),
          confirm,
          commit,
        },
      });
      await handleSlashCommand("/commit ship it", deps);
      expect(confirm).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(getText()).toBe("[commit] nothing to commit\n");
    });

    it("a refused confirmation cancels WITHOUT calling commit [hazard e]", async () => {
      const summary = makeStatus({ unstaged: [{ path: "a.ts", kind: "modified" }] });
      const confirm = vi.fn(async () => false);
      const commit = vi.fn();
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: summary })),
          diff: vi.fn(),
          confirm,
          commit,
        },
      });
      await handleSlashCommand("/commit fix a", deps);
      expect(confirm).toHaveBeenCalledWith(`${renderCommitSummary(summary)} [y/N] `);
      expect(commit).not.toHaveBeenCalled();
      expect(getText()).toBe("[commit] cancelled\n");
    });

    it("a confirmed commit reports the 8-char sha and the file count from the pre-commit snapshot", async () => {
      const summary = makeStatus({
        staged: [{ path: "a.ts", kind: "modified" }],
        unstaged: [{ path: "b.ts", kind: "modified" }],
        untracked: ["c.ts"],
      });
      const commit = vi.fn(async () => ({ ok: true as const, value: { sha: "0123456789abcdef" } }));
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: summary })),
          diff: vi.fn(),
          confirm: vi.fn(async () => true),
          commit,
        },
      });
      await handleSlashCommand("/commit add three", deps);
      expect(commit).toHaveBeenCalledWith("add three");
      // 3 files across staged+unstaged+untracked; sha truncated to 8 chars.
      expect(getText()).toBe("[commit] 01234567 (3 files)\n");
    });

    it("the file count is singular for a one-file commit", async () => {
      const summary = makeStatus({ unstaged: [{ path: "only.ts", kind: "modified" }] });
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: summary })),
          diff: vi.fn(),
          confirm: vi.fn(async () => true),
          commit: vi.fn(async () => ({ ok: true as const, value: { sha: "abcdef0123456789" } })),
        },
      });
      await handleSlashCommand("/commit one", deps);
      expect(getText()).toBe("[commit] abcdef01 (1 file)\n");
    });

    it("a failed commit prints the reason verbatim", async () => {
      const summary = makeStatus({ unstaged: [{ path: "a.ts", kind: "modified" }] });
      const { deps, getText } = makeDeps({
        git: {
          enabled: true,
          status: vi.fn(async () => ({ ok: true as const, value: summary })),
          diff: vi.fn(),
          confirm: vi.fn(async () => true),
          commit: vi.fn(async () => ({ ok: false as const, reason: "git commit failed: no user.email" })),
        },
      });
      await handleSlashCommand("/commit x", deps);
      expect(getText()).toBe("[commit] git commit failed: no user.email\n");
    });
  });
});

describe("handleSlashCommand — /hooks (design slice-5.6-cut.md wave C)", () => {
  it("an empty declaration list writes exactly the no-hooks notice", async () => {
    const { deps, getText } = makeDeps({ hooks: { list: () => [] } });
    await handleSlashCommand("/hooks", deps);
    expect(getText()).toBe("[hooks] no command hooks configured\n");
  });

  it("a non-empty declaration list renders every row via renderHooksTable, PreToolUse+SubagentStop both visible", async () => {
    const decls: CommandHookDeclaration[] = [
      { event: "PreToolUse", matcher: "Bash", command: "./guard.sh" },
      { event: "SubagentStop", command: "./notify.sh", timeoutMs: 5000 },
    ];
    const { deps, getText } = makeDeps({ hooks: { list: () => decls } });
    await handleSlashCommand("/hooks", deps);
    const text = getText();
    expect(text).toBe(renderHooksTable(decls));
    expect(text).toContain("PreToolUse");
    expect(text).toContain("Bash");
    expect(text).toContain("./guard.sh");
    expect(text).toContain("SubagentStop");
    expect(text).toContain("./notify.sh");
    expect(text).toContain("(timeout 5000ms)");
  });

  it("ignores any argument text (read-only, no subcommands)", async () => {
    const decls: CommandHookDeclaration[] = [{ event: "Stop", command: "./cleanup.sh" }];
    const list = vi.fn(() => decls);
    const { deps, getText } = makeDeps({ hooks: { list } });
    await handleSlashCommand("/hooks ignored-argument", deps);
    expect(list).toHaveBeenCalledTimes(1);
    expect(getText()).toBe(renderHooksTable(decls));
  });
});

describe("renderHooksTable (design slice-5.6-cut.md wave C)", () => {
  it("an empty list renders exactly the no-hooks notice", () => {
    expect(renderHooksTable([])).toBe("[hooks] no command hooks configured\n");
  });

  it("renders a fixed-width event/matcher/command table ending in a single newline", () => {
    const decls: CommandHookDeclaration[] = [
      { event: "PreToolUse", matcher: "Bash", command: "./guard.sh" },
      { event: "Stop", command: "./cleanup.sh" },
    ];
    const rendered = renderHooksTable(decls);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    const lines = rendered.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("event       matcher  command");
  });

  it("renders an absent or empty matcher as an em dash", () => {
    const decls: CommandHookDeclaration[] = [
      { event: "Stop", command: "./cleanup.sh" },
      { event: "UserPromptSubmit", matcher: "", command: "./scan.sh" },
    ];
    const rendered = renderHooksTable(decls);
    const bodyLines = rendered.trimEnd().split("\n").slice(1);
    expect(bodyLines[0]).toContain("—");
    expect(bodyLines[1]).toContain("—");
  });

  it("appends a (timeout Nms) suffix to the command cell only when timeoutMs is set", () => {
    const decls: CommandHookDeclaration[] = [
      { event: "PreToolUse", matcher: "Bash", command: "./guard.sh", timeoutMs: 2500 },
      { event: "Stop", command: "./cleanup.sh" },
    ];
    const rendered = renderHooksTable(decls);
    expect(rendered).toContain("./guard.sh  (timeout 2500ms)");
    expect(rendered).not.toContain("./cleanup.sh  (timeout");
  });

  it("recognizes a SubagentStop declaration (types/hooks.ts HookEvent parity, design slice-5.6)", () => {
    const decls: CommandHookDeclaration[] = [{ event: "SubagentStop", command: "./notify.sh" }];
    const rendered = renderHooksTable(decls);
    expect(rendered).toContain("SubagentStop");
    expect(rendered).toContain("./notify.sh");
  });
});

function makeSnapshot(overrides?: Partial<BackgroundTaskSnapshot>): BackgroundTaskSnapshot {
  return {
    taskId: "task-1",
    command: "pnpm test",
    status: "running",
    exitCode: null,
    startedAt: 0,
    outputBytes: 0,
    outputTruncated: false,
    ...overrides,
  };
}

describe("handleSlashCommand — /tasks (design slice-5.5-cut.md §2/C3)", () => {
  it("a bare /tasks with no background tasks writes exactly the no-tasks notice", async () => {
    const { deps, getText } = makeDeps({ tasks: { list: () => [], kill: () => false } });
    await handleSlashCommand("/tasks", deps);
    expect(getText()).toBe("[tasks] no background tasks in this session\n");
  });

  it("a bare /tasks with running/terminal tasks renders every row via renderTasksTable", async () => {
    const snapshots: BackgroundTaskSnapshot[] = [
      makeSnapshot({ taskId: "task-1", status: "running" }),
      makeSnapshot({ taskId: "task-2", command: "npm run build", status: "completed", exitCode: 0, endedAt: 1000 }),
    ];
    const { deps, getText } = makeDeps({ tasks: { list: () => snapshots, kill: () => false } });
    await handleSlashCommand("/tasks", deps);
    const text = getText();
    expect(text).toBe(renderTasksTable(snapshots));
    expect(text).toContain("task-1");
    expect(text).toContain("task-2");
    expect(text).toContain("npm run build");
  });

  it("/tasks kill <id> reports success verbatim when deps.tasks.kill returns true", async () => {
    const kill = vi.fn(() => true);
    const { deps, getText } = makeDeps({ tasks: { list: () => [], kill } });
    await handleSlashCommand("/tasks kill task-2", deps);
    expect(kill).toHaveBeenCalledWith("task-2");
    expect(getText()).toBe("[tasks] killed task-2\n");
  });

  it('/tasks kill <id> reports an honest failure when deps.tasks.kill returns false (unknown or already-terminal id)', async () => {
    const kill = vi.fn(() => false);
    const { deps, getText } = makeDeps({ tasks: { list: () => [], kill } });
    await handleSlashCommand("/tasks kill task-9", deps);
    expect(kill).toHaveBeenCalledWith("task-9");
    expect(getText()).toBe('[tasks] no running task "task-9"\n');
  });

  it("/tasks kill with no id, an extra token, or a typo'd subcommand all print the usage line and never call kill", async () => {
    const kill = vi.fn(() => true);
    for (const line of ["/tasks kill", "/tasks kill task-1 extra", "/tasks stop task-1"]) {
      const { deps, getText } = makeDeps({ tasks: { list: () => [], kill } });
      await handleSlashCommand(line, deps);
      expect(getText()).toBe("[tasks] usage: /tasks [kill <id>]\n");
    }
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("renderTasksTable (design slice-5.5-cut.md §2/C4)", () => {
  it("an empty list renders exactly the no-tasks notice", () => {
    expect(renderTasksTable([])).toBe("[tasks] no background tasks in this session\n");
  });

  it("renders a fixed-width id/status/time/exit/command table ending in a single newline", () => {
    const snapshots: BackgroundTaskSnapshot[] = [
      makeSnapshot({ taskId: "task-1", status: "running", startedAt: 0 }),
      makeSnapshot({ taskId: "task-2", command: "npm run build", status: "completed", exitCode: 0, startedAt: 0, endedAt: 5000 }),
    ];
    const rendered = renderTasksTable(snapshots, { now: 5000 });
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    const lines = rendered.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("id      status     time  exit  command");
  });

  it("shows uptime (now - startedAt) for a running task and final duration (endedAt - startedAt) for a terminal one", () => {
    const snapshots: BackgroundTaskSnapshot[] = [
      makeSnapshot({ taskId: "task-1", status: "running", startedAt: 0 }),
      makeSnapshot({ taskId: "task-2", status: "completed", exitCode: 0, startedAt: 0, endedAt: 3000 }),
    ];
    const rendered = renderTasksTable(snapshots, { now: 10_000 });
    const rows = rendered.trimEnd().split("\n").slice(1);
    expect(rows[0]).toContain("10s");
    expect(rows[1]).toContain("3s");
  });

  it("renders a null exit code as an em dash, and a real one as its number", () => {
    const snapshots: BackgroundTaskSnapshot[] = [
      makeSnapshot({ taskId: "task-1", status: "running", exitCode: null }),
      makeSnapshot({ taskId: "task-2", status: "failed", exitCode: 1, endedAt: 100 }),
    ];
    const rendered = renderTasksTable(snapshots, { now: 100 });
    const rows = rendered.trimEnd().split("\n").slice(1);
    expect(rows[0]).toContain("-");
    expect(rows[1]).toContain("1");
  });

  it("truncates a command longer than the table's cap and never breaks column alignment", () => {
    const longCommand = "pnpm run something-with-a-very-long-argument-list --flag=value ".repeat(3);
    const snapshots: BackgroundTaskSnapshot[] = [makeSnapshot({ command: longCommand })];
    const rendered = renderTasksTable(snapshots, { now: 0 });
    expect(rendered).toContain("…");
    expect(rendered).not.toContain(longCommand);
  });
});

function makeLspStatus(overrides?: Partial<LspServerStatus>): LspServerStatus {
  return {
    name: "typescript",
    state: "ready",
    extensions: [".ts", ".tsx"],
    stderrTail: "",
    ...overrides,
  };
}

describe("handleSlashCommand — /lsp (design slice-6.1-cut.md §2-D2)", () => {
  it("a bare /lsp with no configured servers writes exactly the no-servers notice", async () => {
    const { deps, getText } = makeDeps({ lsp: { status: () => [] } });
    await handleSlashCommand("/lsp", deps);
    expect(getText()).toBe("[lsp] no language servers configured\n");
  });

  it("/lsp renders every configured server's live status via renderLspTable", async () => {
    const statuses: LspServerStatus[] = [
      makeLspStatus({ name: "typescript", state: "ready", pid: 4242 }),
      makeLspStatus({ name: "python", state: "not_started", extensions: [".py"] }),
    ];
    const { deps, getText } = makeDeps({ lsp: { status: () => statuses } });
    await handleSlashCommand("/lsp", deps);
    const text = getText();
    expect(text).toBe(renderLspTable(statuses));
    expect(text).toContain("typescript");
    expect(text).toContain("python");
    expect(text).toContain("4242");
  });

  it("/lsp surfaces a crashed server's stderr tail", async () => {
    const statuses: LspServerStatus[] = [
      makeLspStatus({ name: "typescript", state: "crashed", stderrTail: "fatal: out of memory" }),
    ];
    const { deps, getText } = makeDeps({ lsp: { status: () => statuses } });
    await handleSlashCommand("/lsp", deps);
    expect(getText()).toContain("out of memory");
  });

  it("re-reads live status on every call rather than caching a boot snapshot", async () => {
    let call = 0;
    const status = vi.fn(() =>
      call++ === 0 ? [makeLspStatus({ state: "initializing" })] : [makeLspStatus({ state: "ready", pid: 99 })],
    );
    const { deps, getText: getText1 } = makeDeps({ lsp: { status } });
    await handleSlashCommand("/lsp", deps);
    expect(getText1()).toContain("initializing");
    const { deps: deps2, getText: getText2 } = makeDeps({ lsp: { status } });
    await handleSlashCommand("/lsp", deps2);
    expect(getText2()).toContain("ready");
    expect(status).toHaveBeenCalledTimes(2);
  });
});

describe("renderLspTable (design slice-6.1-cut.md §2-D3)", () => {
  it("an empty list renders exactly the no-servers notice", () => {
    expect(renderLspTable([])).toBe("[lsp] no language servers configured\n");
  });

  it("renders a fixed-width name/state/pid/extensions table ending in a single newline", () => {
    const statuses: LspServerStatus[] = [
      makeLspStatus({ name: "typescript", state: "ready", pid: 100, extensions: [".ts", ".tsx"] }),
      makeLspStatus({ name: "python", state: "not_started", extensions: [".py"] }),
    ];
    const rendered = renderLspTable(statuses);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    const lines = rendered.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("name        state        pid  extensions");
  });

  it("renders a missing pid as an em dash, and a real one as its number", () => {
    const statuses: LspServerStatus[] = [
      makeLspStatus({ name: "a", state: "not_started" }),
      makeLspStatus({ name: "b", state: "ready", pid: 777 }),
    ];
    const rendered = renderLspTable(statuses);
    const rows = rendered.trimEnd().split("\n").slice(1);
    expect(rows[0]).toContain("-");
    expect(rows[1]).toContain("777");
  });

  it("joins multiple extensions with a comma in the extensions cell", () => {
    const statuses: LspServerStatus[] = [makeLspStatus({ extensions: [".ts", ".tsx", ".mts"] })];
    const rendered = renderLspTable(statuses);
    expect(rendered).toContain(".ts,.tsx,.mts");
  });

  it("appends a (stderr: …) suffix ONLY for a crashed server with a non-empty stderrTail", () => {
    const statuses: LspServerStatus[] = [
      makeLspStatus({ name: "crashed-with-tail", state: "crashed", stderrTail: "boom" }),
      makeLspStatus({ name: "crashed-no-tail", state: "crashed", stderrTail: "" }),
      makeLspStatus({ name: "ready-fine", state: "ready" }),
    ];
    const rendered = renderLspTable(statuses);
    expect(rendered).toContain("(stderr: boom)");
    expect(rendered).not.toContain("crashed-no-tail  (stderr:");
    expect(rendered).not.toContain("ready-fine  (stderr:");
  });

  it("truncates a stderr tail longer than the table's cap and never breaks column alignment", () => {
    const longTail = "x".repeat(400);
    const statuses: LspServerStatus[] = [makeLspStatus({ state: "crashed", stderrTail: longTail })];
    const rendered = renderLspTable(statuses);
    expect(rendered).toContain("…");
    expect(rendered).not.toContain(longTail);
  });
});

describe("handleSlashCommand — /image (design slice-6.2-cut.md §2-D3/R15)", () => {
  it("/image <path> stages successfully and reports basename/mediaType/size/running count", async () => {
    const stage = vi.fn(async () => ({
      ok: true as const,
      basename: "bug.png",
      mediaType: "image/png" as ImageMediaType,
      kb: 42,
      staged: 2,
    }));
    const { deps, getText } = makeDeps({ images: { stage, list: vi.fn(() => []), clear: vi.fn(() => 0) } });
    await handleSlashCommand("/image /tmp/bug.png", deps);
    expect(stage).toHaveBeenCalledWith("/tmp/bug.png");
    expect(getText()).toBe("[image] staged bug.png (image/png, 42 KB) — 2 staged\n");
  });

  it("/image <path> prints the failure reason verbatim and never touches the stage on a rejected attach", async () => {
    const stage = vi.fn(async () => ({ ok: false as const, reason: "not a supported image (png/jpeg/gif/webp)" }));
    const { deps, getText } = makeDeps({ images: { stage, list: vi.fn(() => []), clear: vi.fn(() => 0) } });
    await handleSlashCommand("/image /tmp/notes.txt", deps);
    expect(getText()).toBe("[image] not a supported image (png/jpeg/gif/webp)\n");
  });

  it("a bare /image with nothing staged writes exactly the no-images notice", async () => {
    const { deps, getText } = makeDeps({ images: { stage: vi.fn(), list: () => [], clear: vi.fn(() => 0) } });
    await handleSlashCommand("/image", deps);
    expect(getText()).toBe("[image] no images staged\n");
  });

  it("a bare /image with a populated stage lists every staged entry", async () => {
    const list = vi.fn(() => [
      { basename: "one.png", mediaType: "image/png" as ImageMediaType, kb: 10 },
      { basename: "two.jpg", mediaType: "image/jpeg" as ImageMediaType, kb: 20 },
    ]);
    const { deps, getText } = makeDeps({ images: { stage: vi.fn(), list, clear: vi.fn(() => 0) } });
    await handleSlashCommand("/image", deps);
    expect(getText()).toBe(
      "[image] staged one.png (image/png, 10 KB)\n[image] staged two.jpg (image/jpeg, 20 KB)\n",
    );
  });

  it("/image clear empties the stage and reports the dropped count, singular vs plural", async () => {
    const clearOne = vi.fn(() => 1);
    const { deps, getText } = makeDeps({ images: { stage: vi.fn(), list: () => [], clear: clearOne } });
    await handleSlashCommand("/image clear", deps);
    expect(clearOne).toHaveBeenCalledTimes(1);
    expect(getText()).toBe("[image] cleared 1 staged image\n");

    const clearMany = vi.fn(() => 3);
    const { deps: deps2, getText: getText2 } = makeDeps({ images: { stage: vi.fn(), list: () => [], clear: clearMany } });
    await handleSlashCommand("/image clear", deps2);
    expect(getText2()).toBe("[image] cleared 3 staged images\n");

    const clearZero = vi.fn(() => 0);
    const { deps: deps3, getText: getText3 } = makeDeps({ images: { stage: vi.fn(), list: () => [], clear: clearZero } });
    await handleSlashCommand("/image clear", deps3);
    expect(getText3()).toBe("[image] cleared 0 staged images\n");
  });
});

/** A ready-to-render ContextInfo fixture, overridable per test (slice 6.4). */
function makeContextInfo(overrides?: Partial<ContextInfo>): ContextInfo {
  return {
    estimatedTokens: 10_000,
    source: "estimate",
    contextWindowTokens: 200_000,
    outputReserveTokens: 24_000,
    effectiveWindowTokens: 176_000,
    compactThresholdTokens: 161_920,
    breakerTripped: false,
    ...overrides,
  };
}

/** A ready-to-render ContextBreakdown fixture, overridable per test (slice P7.17 W1). */
function makeContextBreakdown(overrides?: Partial<ContextBreakdown>): ContextBreakdown {
  return {
    messagesTokens: 6_000,
    systemToolsTokens: 2_000,
    mcpToolsTokens: 500,
    skillsTokens: 300,
    systemPromptTokens: 1_000,
    metaTokens: 200,
    totalEstimatedTokens: 10_000,
    ...overrides,
  };
}

describe("handleSlashCommand — /context (design slice-6.4-cut.md §2-C2, breakdown appendix per slice-P7.17-cut.md §2.1)", () => {
  it("a bare /context renders formatContextInfo + formatContextBreakdown verbatim, read-only (no event/mutation)", async () => {
    const info = makeContextInfo({ estimatedTokens: 12_345, source: "provider" });
    const breakdown = makeContextBreakdown();
    const contextInfo = vi.fn(() => info);
    const contextBreakdown = vi.fn(() => breakdown);
    const { deps, getText } = makeDeps({ loop: { contextInfo, contextBreakdown } as unknown as AgentLoop });
    await handleSlashCommand("/context", deps);
    expect(contextInfo).toHaveBeenCalledTimes(1);
    expect(contextBreakdown).toHaveBeenCalledTimes(1);
    expect(getText()).toBe(formatContextInfo(info) + formatContextBreakdown(breakdown));
  });

  it("/context with any argument prints the usage line and never calls contextInfo or contextBreakdown", async () => {
    const contextInfo = vi.fn(() => makeContextInfo());
    const contextBreakdown = vi.fn(() => makeContextBreakdown());
    const { deps, getText } = makeDeps({ loop: { contextInfo, contextBreakdown } as unknown as AgentLoop });
    await handleSlashCommand("/context extra-arg", deps);
    expect(getText()).toBe("[context] usage: /context\n");
    expect(contextInfo).not.toHaveBeenCalled();
    expect(contextBreakdown).not.toHaveBeenCalled();
  });

  it("renders the tripped-breaker line when contextInfo reports breakerTripped", async () => {
    const info = makeContextInfo({ breakerTripped: true });
    const breakdown = makeContextBreakdown();
    const { deps, getText } = makeDeps({
      loop: { contextInfo: () => info, contextBreakdown: () => breakdown } as unknown as AgentLoop,
    });
    await handleSlashCommand("/context", deps);
    expect(getText()).toContain("auto-compaction: disabled (circuit breaker tripped; /compact still works)");
  });

  it("appends the breakdown's category rows after the contextInfo snapshot lines", async () => {
    const info = makeContextInfo();
    const breakdown = makeContextBreakdown({ mcpToolsTokens: 0, skillsTokens: 0 });
    const { deps, getText } = makeDeps({
      loop: { contextInfo: () => info, contextBreakdown: () => breakdown } as unknown as AgentLoop,
    });
    await handleSlashCommand("/context", deps);
    const text = getText();
    expect(text).toContain("[context] breakdown (estimated, total ~10000 tokens):");
    expect(text).toContain("Messages: 6000 tokens (60%)");
    expect(text).not.toContain("MCP tools");
    expect(text).not.toContain("Skills:");
  });
});


describe("handleSlashCommand — /telemetry (design slice-6.6-cut.md §2-C2)", () => {
  it("a bare /telemetry renders renderTelemetryStatus(deps.telemetry.status()) verbatim, read-only (no event/mutation)", async () => {
    const status = vi.fn(() => null as TelemetryStatus | null);
    const { deps, getText } = makeDeps({ telemetry: { status } });
    await handleSlashCommand("/telemetry", deps);
    expect(status).toHaveBeenCalledTimes(1);
    expect(getText()).toBe(renderTelemetryStatus(null));
  });

  it("a bare /telemetry with an enabled sink renders the enabled status verbatim", async () => {
    const enabled: TelemetryStatus = { filePath: "/tmp/tel/s.jsonl", written: 3, dropped: 0 };
    const { deps, getText } = makeDeps({ telemetry: { status: () => enabled } });
    await handleSlashCommand("/telemetry", deps);
    expect(getText()).toBe(renderTelemetryStatus(enabled));
  });

  it("/telemetry with any argument prints the usage line and never calls status", async () => {
    const status = vi.fn(() => null as TelemetryStatus | null);
    const { deps, getText } = makeDeps({ telemetry: { status } });
    await handleSlashCommand("/telemetry extra-arg", deps);
    expect(getText()).toBe("[telemetry] usage: /telemetry\n");
    expect(status).not.toHaveBeenCalled();
  });
});

describe("handleSlashCommand — /repo-map", () => {
  it("explains how to enable the disabled opt-in feature", async () => {
    const { deps, getText } = makeDeps();
    await handleSlashCommand("/repo-map", deps);
    expect(getText()).toContain("ANYCODE_REPO_MAP=1");
    expect(getText()).toContain(".anycode/config.json");
  });

  it("prints the current rendering without touching the loop", async () => {
    const render = vi.fn(() => "<repo-map>\n- a.ts\n</repo-map>");
    const { deps, getText } = makeDeps({ repoMap: { render } });
    await handleSlashCommand("/repo-map", deps);
    expect(getText()).toBe("<repo-map>\n- a.ts\n</repo-map>\n");
    expect(render).toHaveBeenCalledOnce();
  });

  it("rejects arguments without rendering", async () => {
    const render = vi.fn(() => "map");
    const { deps, getText } = makeDeps({ repoMap: { render } });
    await handleSlashCommand("/repo-map now", deps);
    expect(getText()).toBe("[repo-map] usage: /repo-map\n");
    expect(render).not.toHaveBeenCalled();
  });
});
