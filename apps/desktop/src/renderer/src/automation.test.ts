/**
 * automation.ts tests (design/build/design/phase-2-smoke-channel.md §3.2,
 * task S2 criterion). Same isolation discipline as tab-registry.test.ts: a
 * fresh `createTabsStore()`/`createTabRegistry()` pair per test, fake
 * MessagePorts to drive tabs to `ready`, and a stub `AnycodeBridge` in place
 * of `window.anycode` — `createAutomationFacade` takes all three as
 * parameters, so none of this needs a DOM/jsdom or a real Electron preload.
 *
 * Covers: snapshot is an exact JSON-projection of the live stores (all
 * `TabStateSnapshot` fields, tail cap); sendPrompt's busy/not-ready guards and
 * its ready-path appendUserText+send with one shared requestId;
 * respondPermission's no-pending/wrong-requestId fail-closed paths (zero
 * sends); setMode's guards + invalid-mode rejection; stop/selectTab's
 * unknown-tab guards; resumeSession/closeTab/listSessions passthrough to the
 * `AnycodeBridge`, including closeTab's dispose-on-success mirroring of
 * App.tsx's handleCloseTab. Every message the facade actually sends is also

 * a facade guard may drift, but it can never produce a message the host's
 * own fail-closed validation would reject).
 */
import { describe, expect, it, vi } from "vitest";
import type { GitBranchInfo, GitCommitInfo } from "@anycode/core";
import {
  createAutomationFacade,
  derivePendingForGitCommand,
  type AnycodeBridge,
  type TranscriptDom,
  type TodoPanelDom,
  type StartScreenDom,
  type ModelPillDom,
  type SettingsDom,
  type CtxPopoverDom,
  type AgentCardDom,
  type McpPaneDom,
  type SkillsPaneDom,
  type SkillsPaneImportCandidateState,
  type SkillsPaneRowState,
  type SubagentsPaneDom,
  type SubagentsPaneRowState,
  type LspPanelDom,
  type HooksPanelDom,
  type CheckpointPanelDom,
  type TranscriptBlockDom,
  type TryAgainButtonDom,
} from "./automation.js";
import type { SkillScope } from "../../shared/skills-config.js";
import { ruleRemoveAriaLabel } from "./components/PermissionsEditor.js";
import type { GitDestructiveIntent, RetryOffer } from "./store.js";
import { createTabRegistry, type TabRegistry } from "./tab-registry.js";
import { createTabsStore, type TabsStoreApi } from "./tabs-store.js";
import { createSettingsStore } from "./settings-store.js";
import type { GitCommand, HostToUiMessage, WireCheckpointMeta, WireEnvStatus, WireGitStatus } from "../../shared/protocol.js";
import { uiToHostMessageSchema } from "../../shared/protocol.js";
import type { CreateTabResult, CloseTabResult, SessionSummary } from "../../shared/tabs.js";
import type { AlwaysAllowRule, SettingsSnapshot } from "../../shared/settings.js";

/** Minimal MessagePort double (same shape as tab-registry.test.ts's). */
class FakeMessagePort {
  onmessage: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
  sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  emit(message: HostToUiMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<HostToUiMessage>);
  }
}

function asPort(fake: FakeMessagePort): MessagePort {
  return fake as unknown as MessagePort;
}

/** Same helper as tab-registry.test.ts: mode is always "build" — tests that need a different starting mode set it via `set_mode` afterward. */
const HOST_READY = (workspace: string, sessionId: string): HostToUiMessage => ({
  type: "host_ready",
  workspace,
  mode: "build",
  model: "m1",
  sessionId,
});

function stubBridge(overrides: Partial<AnycodeBridge> = {}): AnycodeBridge {
  return {
    createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "resumed-tab", workspace: "/ws" })),
    closeTab: vi.fn(async (): Promise<CloseTabResult> => ({ ok: true })),
    listSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
    ...overrides,
  };
}

/** Builds a fresh registry/tabsStore pair and registers+readies one tab. Returns everything a test needs to drive it further. */
function setupReadyTab(tabId = "tab-a", workspace = "/ws/a", sessionId = "sess-a") {
  const tabsStore: TabsStoreApi = createTabsStore();
  const registry: TabRegistry = createTabRegistry(tabsStore);
  const port = new FakeMessagePort();
  registry.registerPort(tabId, workspace, asPort(port));
  port.emit(HOST_READY(workspace, sessionId));
  return { tabsStore, registry, port, tabId };
}

/** A minimal live-repo WireGitStatus so the pill renders and the git surface is reachable. */
function gitStatus(overrides: Partial<WireGitStatus> = {}): WireGitStatus {
  return {
    head: { branch: "main", detached: false, sha: "abc1234", ahead: null, behind: null },
    staged: [],
    unstaged: [{ path: "a.txt", kind: "modified" }],
    untracked: ["u.txt"],
    dirtyCount: 2,
    filesTruncated: false,
    ...overrides,
  };
}

/**
 * setupReadyTab + a first `git_status` (status null => "not a repo"), so the
 * pill is live and the git surface is reachable — exactly the render gate the
 * facade's `git_unavailable` guard mirrors (GitPill `:60-62`).
 */
function setupGitReadyTab(status: WireGitStatus | null = gitStatus()) {
  const fixture = setupReadyTab();
  fixture.port.emit({ type: "git_status", status });
  return fixture;
}

/** Everything the facade posts to the host EXCEPT the `ui_ready` handshake. */
function gitSends(port: FakeMessagePort): unknown[] {
  return port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
}

/** Recursively asserts no value in `git` is a function (JSON-safety, design §6#3). */
function assertNoFunctions(value: unknown, path = "git"): void {
  expect(typeof value, `${path} must not be a function`).not.toBe("function");
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertNoFunctions(child, `${path}.${key}`);
    }
  }
}

describe("automation facade — snapshot", () => {
  it("projects tabs/activeTabId + an exact field-for-field TabStateSnapshot per tab", () => {
    const { tabsStore, registry, tabId } = setupReadyTab();
    const bridge = stubBridge();
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    const snap = facade.snapshot();

    expect(snap.tabs).toEqual(tabsStore.getState().tabs);
    expect(snap.activeTabId).toBe(tabsStore.getState().activeTabId);
    expect(snap.hiddenWorkspaces).toEqual(tabsStore.getState().hiddenWorkspaces);
    const state = registry.getStore(tabId)!.getState();
    expect(snap.states[tabId]).toEqual({
      connection: state.connection,
      workspace: state.workspace,
      model: state.model,
      mode: state.mode,
      turn: state.turn,
      transcript: state.transcript,
      permission: state.permission,
      notice: state.notice,
      contextUsage: state.contextUsage,
      lastFatal: state.lastFatal,
      git: state.git,
      envStatus: state.envStatus,
      promptQueue: state.promptQueue.map((item) => ({ id: item.id, text: item.text, imageCount: item.images.length })),
      queuePaused: state.queuePaused,
      retryOffer: null,
    });
  });

  it("engine is undefined for a core session (host_ready carries no engine field)", () => {
    const { tabsStore, registry, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.snapshot().states[tabId]?.engine).toBeUndefined();
  });

  it("projects engine metadata (id/model/activePresetId) for a non-core session (codex-fixes TASK.42, cut §3.7)", () => {
    const { tabsStore, registry, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    port.emit({
      type: "host_ready",
      workspace: "/ws/a",
      mode: "build",
      model: "m1",
      sessionId: "sess-a",
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
        model: { current: "gpt-5.2-codex", available: [{ id: "gpt-5.2-codex" }] },
        permissions: { presets: [{ id: "ask", label: "Ask", description: "" }], activePresetId: "ask" },
      },
    });

    expect(facade.snapshot().states[tabId]?.engine).toEqual({ id: "codex", model: "gpt-5.2-codex", activePresetId: "ask" });
  });

  it("reflects a live env_status push with no mirrored/stale copy", () => {
    const { tabsStore, registry, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.snapshot().states[tabId]?.envStatus).toBeNull();

    const status: WireEnvStatus = {
      telemetry: { filePath: "/tmp/sess.jsonl", written: 3, dropped: 0 },
      repoMap: { fileCount: 10, includedCount: 8, truncated: false, maxTokens: 2000 },
    };
    port.emit({ type: "env_status", status });

    expect(facade.snapshot().states[tabId]?.envStatus).toEqual(status);
  });

  it("projects a live retry offer as {loopEndBlockId, text, imageCount} — same attachment-stripping discipline as promptQueue (TASK.33 W8)", () => {
    const { tabsStore, registry, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const image = { name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png" as const, data: "AA==" } };
    const offer: RetryOffer = { loopEndBlockId: "loop_end:t1", text: "hello", images: [image] };

    registry.getStore(tabId)!.setState({ retry: offer });

    expect(facade.snapshot().states[tabId]?.retryOffer).toEqual({
      loopEndBlockId: "loop_end:t1",
      text: "hello",
      imageCount: 1,
    });
  });

  it("reflects live transcript content (agent_event tool_call) with no mirrored/stale copy", () => {
    const { tabsStore, registry, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });
    port.emit({
      type: "agent_event",
      turnId: "t1",
      event: { type: "tool_call", toolCall: { id: "tc1", name: "Bash", input: { command: "ls" } } },
    });

    const snap = facade.snapshot();
    expect(snap.states[tabId]?.transcript).toEqual([
      {
        kind: "tool_call",
        id: "tc1",
        toolCallId: "tc1",
        toolName: "Bash",
        input: { command: "ls" },
        status: "proposed",
        modelText: null,
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
    ]);
  });

  it("caps transcript to the last N blocks when transcriptTail is given", () => {
    const { tabsStore, registry, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    port.emit({ type: "turn_started", requestId: "r1", turnId: "t1" });
    for (let i = 0; i < 5; i += 1) {
      port.emit({
        type: "agent_event",
        turnId: "t1",
        event: { type: "tool_call", toolCall: { id: `tc${i}`, name: "Bash", input: {} } },
      });
    }

    const full = facade.snapshot();
    expect(full.states[tabId]?.transcript).toHaveLength(5);

    const tailed = facade.snapshot(2);
    const tail = tailed.states[tabId]?.transcript ?? [];
    expect(tail).toHaveLength(2);
    expect(tail.map((b) => (b.kind === "tool_call" ? b.toolCallId : null))).toEqual(["tc3", "tc4"]);
  });
});

describe("automation facade — sendPrompt", () => {
  it("rejects with not_ready when the tab's connection isn't ready, sending nothing", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port)); // never emits host_ready -> stays awaiting_host_ready
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.sendPrompt("tab-a", "hello");

    expect(result).toEqual({ ok: false, reason: "not_ready" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]); // only the handshake, no user_message
  });

  it("rejects with busy while a turn is running, sending nothing", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.sendPrompt(tabId, "hello");

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("rejects with unknown_tab for a tabId the registry has never seen", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.sendPrompt("ghost", "hi")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("on ready+idle: appends the user_text block AND sends user_message with the SAME requestId, valid against uiToHostMessageSchema", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.sendPrompt(tabId, "hello there");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const transcript = registry.getStore(tabId)!.getState().transcript;
    expect(transcript).toEqual([{ kind: "user_text", id: result.requestId, text: "hello there" }]);

    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([{ type: "user_message", requestId: result.requestId, text: "hello there" }]);
    for (const message of sentMessages) {
      expect(uiToHostMessageSchema.safeParse(message).success).toBe(true);
    }
  });
});

describe("automation facade — respondPermission", () => {
  function withPendingPermission() {
    const fixture = setupReadyTab();
    fixture.port.emit({
      type: "permission_request",
      requestId: "req-1",
      toolName: "Write",
      input: { file_path: "/tmp/hello.txt" },
      mode: "build",
      metadata: {
        name: "Write",
        description: "",
        readOnly: false,
        destructive: false,
        riskLevel: "medium",
        sideEffectScope: "filesystem",
      },
    });
    return fixture;
  }

  it("no pending request -> {ok:false}, zero sends", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.respondPermission(tabId, "allow");

    expect(result).toEqual({ ok: false, reason: "no_pending_request" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("a requestId that doesn't match the pending ask -> {ok:false}, zero sends (fail-closed)", () => {
    const { registry, tabsStore, port, tabId } = withPendingPermission();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.respondPermission(tabId, "allow", "wrong-id");

    expect(result).toEqual({ ok: false, reason: "requestId_mismatch" });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([]);
  });

  it("unknown tab -> {ok:false}, zero sends", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.respondPermission("ghost", "deny")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("omitted requestId defaults to the current pending ask and sends permission_response, valid against uiToHostMessageSchema", () => {
    const { registry, tabsStore, port, tabId } = withPendingPermission();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.respondPermission(tabId, "allow");

    expect(result).toEqual({ ok: true });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([{ type: "permission_response", requestId: "req-1", behavior: "allow" }]);
    expect(uiToHostMessageSchema.safeParse(sentMessages[0]).success).toBe(true);
  });

  it("an explicit requestId matching the pending ask sends deny", () => {
    const { registry, tabsStore, port, tabId } = withPendingPermission();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.respondPermission(tabId, "deny", "req-1");

    expect(result).toEqual({ ok: true });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([{ type: "permission_response", requestId: "req-1", behavior: "deny" }]);
  });
});

describe("automation facade — setMode", () => {
  it("rejects an invalid mode string without sending", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.setMode(tabId, "not-a-real-mode");

    expect(result).toEqual({ ok: false, reason: "invalid_mode" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("rejects while a turn is running (mode unchanged), sending nothing", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.setMode(tabId, "plan");

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
    expect(registry.getStore(tabId)!.getState().mode).toBe("build");
  });

  it("sends set_mode when ready+idle+valid, valid against uiToHostMessageSchema", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.setMode(tabId, "plan");

    expect(result).toEqual({ ok: true });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([{ type: "set_mode", mode: "plan" }]);
    expect(uiToHostMessageSchema.safeParse(sentMessages[0]).success).toBe(true);
  });
});

describe("automation facade — stop / selectTab", () => {
  it("stop sends cancel_turn for a known tab, valid against uiToHostMessageSchema", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.stop(tabId);

    expect(result).toEqual({ ok: true });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toEqual([{ type: "cancel_turn" }]);
    expect(uiToHostMessageSchema.safeParse(sentMessages[0]).success).toBe(true);
  });

  it("stop on an unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.stop("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("selectTab flips activeTabId for a known tab", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(tabsStore.getState().activeTabId).toBe("tab-a"); // first tab auto-activates
    const result = facade.selectTab("tab-b");

    expect(result).toEqual({ ok: true });
    expect(tabsStore.getState().activeTabId).toBe("tab-b");
  });

  it("selectTab on an unknown tab -> {ok:false}, activeTabId unchanged", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.selectTab("ghost");

    expect(result).toEqual({ ok: false, reason: "unknown_tab" });
    expect(tabsStore.getState().activeTabId).toBe("tab-a");
  });
});

describe("automation facade — tryAgain (design TASK.33 W8)", () => {
  it("unknown tab -> {ok:false, reason:'unknown_tab'}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.tryAgain("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("nothing armed -> {ok:false, reason:'no_retry_offer'}, sending nothing", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.tryAgain(tabId)).toEqual({ ok: false, reason: "no_retry_offer" });
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("an armed offer -> {ok:true}, drives the SAME dispatchTryAgain path App.tsx's button uses (user_message on the wire, offer consumed)", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const offer: RetryOffer = { loopEndBlockId: "loop_end:t1", text: "hello again", images: [] };
    registry.getStore(tabId)!.setState({ retry: offer });

    const result = facade.tryAgain(tabId);

    expect(result).toEqual({ ok: true });
    const sentMessages = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ type: "user_message", text: "hello again" });
    expect(uiToHostMessageSchema.safeParse(sentMessages[0]).success).toBe(true);
    expect(registry.getStore(tabId)!.getState().retry).toBeNull();
  });

  it("one-shot: a second call right after the first finds nothing armed and sends nothing further", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    registry.getStore(tabId)!.setState({ retry: { loopEndBlockId: "loop_end:t1", text: "hello", images: [] } });

    facade.tryAgain(tabId);
    const second = facade.tryAgain(tabId);

    expect(second).toEqual({ ok: false, reason: "no_retry_offer" });
    expect(port.sent.filter((m) => (m as { type: string }).type !== "ui_ready")).toHaveLength(1);
  });

  // W8-FIX #1 (App.tsx's dispatchTryAgain) bails without consuming the offer
  // when `connection !== "ready"`, so a click made while disconnected leaves
  // it armed for when the connection returns. The facade route used to skip
  // that gate entirely: it only checked "does an offer exist" and then
  // unconditionally returned {ok:true}, lying about a send that never
  // happened — a smoke driving this route through a disconnected tab would
  // see false success and mask a real regression.
  it("an offer is armed but connection isn't ready -> {ok:false, reason:'not_ready'}, sending nothing and leaving the offer armed (mirrors dispatchTryAgain's own readiness gate)", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const offer: RetryOffer = { loopEndBlockId: "loop_end:t1", text: "hello again", images: [] };
    registry.getStore(tabId)!.setState({ retry: offer, connection: "host_exited" });

    const result = facade.tryAgain(tabId);

    expect(result).toEqual({ ok: false, reason: "not_ready" });
    expect(port.sent.filter((m) => (m as { type: string }).type !== "ui_ready")).toHaveLength(0);
    expect(registry.getStore(tabId)!.getState().retry).toEqual(offer);
  });

  it("still succeeds when the offer is armed and the tab IS ready — the not_ready gate doesn't regress the happy path", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const offer: RetryOffer = { loopEndBlockId: "loop_end:t1", text: "hello again", images: [] };
    registry.getStore(tabId)!.setState({ retry: offer, connection: "ready" });

    const result = facade.tryAgain(tabId);

    expect(result).toEqual({ ok: true });
    expect(port.sent.filter((m) => (m as { type: string }).type !== "ui_ready")).toHaveLength(1);
  });
});

describe("automation facade — tab-lifecycle passthrough (window.anycode bridge)", () => {
  it("resumeSession calls bridge.createTab({kind:'resume', sessionId}) and returns its result verbatim", async () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const bridge = stubBridge({
      createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "t9", workspace: "/ws/resumed" })),
    });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    const result = await facade.resumeSession("sess-9");

    expect(bridge.createTab).toHaveBeenCalledWith({ kind: "resume", sessionId: "sess-9" });
    expect(result).toEqual({ ok: true, tabId: "t9", workspace: "/ws/resumed" });
  });

  it("closeTab disposes the tab locally on ok:true (mirrors App.tsx's handleCloseTab)", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    const bridge = stubBridge({ closeTab: vi.fn(async (): Promise<CloseTabResult> => ({ ok: true })) });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    expect(registry.getStore(tabId)).toBeDefined();
    const result = await facade.closeTab(tabId);

    expect(bridge.closeTab).toHaveBeenCalledWith(tabId);
    expect(result).toEqual({ ok: true });
    expect(registry.getStore(tabId)).toBeUndefined();
    expect(tabsStore.getState().tabs).toHaveLength(0);
  });

  it("closeTab leaves the tab intact when main refuses (ok:false)", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    const bridge = stubBridge({
      closeTab: vi.fn(async (): Promise<CloseTabResult> => ({ ok: false, reason: "last_tab" })),
    });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    const result = await facade.closeTab(tabId);

    expect(result).toEqual({ ok: false, reason: "last_tab" });
    expect(registry.getStore(tabId)).toBeDefined();
  });

  it("listSessions passes through the bridge's result", async () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const sessions: SessionSummary[] = [
      { id: "s1", workspace: "/ws", model: "m1", mode: "build", createdAt: 0, updatedAt: 0 },
    ];
    const bridge = stubBridge({ listSessions: vi.fn(async () => sessions) });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    await expect(facade.listSessions()).resolves.toEqual(sessions);
  });
});

describe("automation facade — projectNewSession / projectHide (design/slice-GUI-P1-cut.md §2F.5)", () => {
  it("projectNewSession calls bridge.createTab({kind:'new', workspace}) and returns its result verbatim", async () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const bridge = stubBridge({
      createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "t-new", workspace: "/ws/b" })),
    });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    const result = await facade.projectNewSession("/ws/b");

    expect(bridge.createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/b" });
    expect(result).toEqual({ ok: true, tabId: "t-new", workspace: "/ws/b" });
  });

  it("projectNewSession surfaces a bridge refusal verbatim (no local guard re-implemented)", async () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const bridge = stubBridge({
      createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: false, reason: "max_tabs" })),
    });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    await expect(facade.projectNewSession("/ws/b")).resolves.toEqual({ ok: false, reason: "max_tabs" });
  });

  it("projectHide refuses (R1: the REAL hideWorkspace action decides) while the project has an open tab", () => {
    const { registry, tabsStore } = setupReadyTab("tab-a", "/ws/a");
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.projectHide("/ws/a");

    expect(result).toEqual({ ok: false, reason: "project_has_open_tabs" });
    expect(tabsStore.getState().hiddenWorkspaces).toEqual([]);
  });

  it("projectHide succeeds for a workspace with no open tab, updating hiddenWorkspaces", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.projectHide("/ws/session-only");

    expect(result).toEqual({ ok: true });
    expect(tabsStore.getState().hiddenWorkspaces).toContain("/ws/session-only");
  });

  it("projectHide is idempotent — hiding an already-hidden workspace still returns ok:true", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.projectHide("/ws/twice")).toEqual({ ok: true });
    expect(facade.projectHide("/ws/twice")).toEqual({ ok: true });
    expect(tabsStore.getState().hiddenWorkspaces.filter((w) => w === "/ws/twice")).toHaveLength(1);
  });
});

describe("derivePendingForGitCommand", () => {
  it("maps every non-destructive op to GitPanel's inline pending pair verbatim", () => {
    expect(derivePendingForGitCommand({ op: "refresh" })).toEqual({ kind: "refresh", label: "refresh" });
    expect(derivePendingForGitCommand({ op: "branches" })).toEqual({ kind: "branches", label: "branches" });
    expect(derivePendingForGitCommand({ op: "log" })).toEqual({ kind: "log", label: "history" });
    expect(derivePendingForGitCommand({ op: "stage", paths: ["a"] })).toEqual({ kind: "mutation", label: "stage" });
    expect(derivePendingForGitCommand({ op: "unstage", paths: ["a"] })).toEqual({ kind: "mutation", label: "unstage" });
    expect(derivePendingForGitCommand({ op: "stage_all" })).toEqual({ kind: "mutation", label: "stage all" });
    expect(derivePendingForGitCommand({ op: "commit", message: "m" })).toEqual({ kind: "mutation", label: "commit" });
    expect(derivePendingForGitCommand({ op: "switch_branch", name: "b" })).toEqual({ kind: "mutation", label: "switch branch" });
    expect(derivePendingForGitCommand({ op: "create_branch", name: "b" })).toEqual({ kind: "mutation", label: "create branch" });
  });

  it("maps a concrete diff to buildDiffRequest's pending (path+target stamped for stale-drop)", () => {
    expect(derivePendingForGitCommand({ op: "diff", target: "worktree", path: "big.txt" })).toEqual({
      kind: "diff",
      diff: { path: "big.txt", target: "worktree" },
      label: "diff",
    });
  });

  it("returns null for a bare diff (no path AND/OR no target) — the UI never dispatches one", () => {
    expect(derivePendingForGitCommand({ op: "diff" })).toBeNull();
    expect(derivePendingForGitCommand({ op: "diff", path: "a.txt" })).toBeNull();
    expect(derivePendingForGitCommand({ op: "diff", target: "worktree" })).toBeNull();
  });

  it("returns null for every destructive op (dispatch refusal — confirm flow only, ruling R2)", () => {
    expect(derivePendingForGitCommand({ op: "discard", paths: ["a"], confirmed: true })).toBeNull();
    expect(derivePendingForGitCommand({ op: "stash_push", confirmed: true })).toBeNull();
    expect(derivePendingForGitCommand({ op: "stash_pop", confirmed: true })).toBeNull();
    expect(derivePendingForGitCommand({ op: "reset", mode: "hard", confirmed: true })).toBeNull();
  });
});

describe("automation facade — snapshot git projection (JSON-safety, §6#3)", () => {
  it("carries the whole git slice and survives a JSON round-trip with no functions", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    // Drive the facade + host results to fill EVERY git field
    // (status/statusKnown/panelOpen/view/branches/log/diff/confirm/pending/lastError).
    expect(facade.gitSetPanelOpen(tabId, true)).toEqual({ ok: true });
    expect(facade.gitSetView(tabId, "history")).toEqual({ ok: true });

    const branchesReq = facade.gitCommand(tabId, { op: "branches" });
    if (!branchesReq.ok) throw new Error("unreachable");
    const branches: GitBranchInfo[] = [
      { name: "main", current: true, sha: "abc1234" },
      { name: "dev", current: false, sha: "def5678" },
    ];
    port.emit({ type: "git_result", requestId: branchesReq.requestId, outcome: { ok: true, kind: "branches", branches } });

    const logReq = facade.gitCommand(tabId, { op: "log" });
    if (!logReq.ok) throw new Error("unreachable");
    const commits: GitCommitInfo[] = [{ sha: "abc1234", authorName: "Ada", authorDate: 1_700_000_000_000, subject: "smoke: R8" }];
    port.emit({ type: "git_result", requestId: logReq.requestId, outcome: { ok: true, kind: "log", commits } });

    const diffReq = facade.gitCommand(tabId, { op: "diff", target: "worktree", path: "big.txt" });
    if (!diffReq.ok) throw new Error("unreachable");
    port.emit({ type: "git_result", requestId: diffReq.requestId, outcome: { ok: true, kind: "diff", diff: "@@ big @@", truncated: true } });

    // A failed result stamps lastError; nothing after it clears the line (the
    // trailing refresh below is left unresolved).
    const failReq = facade.gitCommand(tabId, { op: "stage", paths: ["x"] });
    if (!failReq.ok) throw new Error("unreachable");
    port.emit({ type: "git_result", requestId: failReq.requestId, outcome: { ok: false, reason: "boom" } });

    expect(facade.gitStageConfirm(tabId, { op: "discard", paths: ["a.txt"] })).toEqual({ ok: true });
    // Leave one pending entry unresolved so `pending` is non-empty in the snapshot.
    const lingering = facade.gitCommand(tabId, { op: "refresh" });
    if (!lingering.ok) throw new Error("unreachable");

    const snap = facade.snapshot();
    const git = snap.states[tabId]?.git;
    // Sanity: every field is actually populated (a hollow slice would trivially round-trip).
    expect(git?.status).not.toBeNull();
    expect(git?.statusKnown).toBe(true);
    expect(git?.panelOpen).toBe(true);
    expect(git?.view).toBe("history");
    expect(git?.branches).toEqual(branches);
    expect(git?.log).toEqual(commits);
    expect(git?.diff).toEqual({ path: "big.txt", target: "worktree", text: "@@ big @@", truncated: true });
    expect(git?.confirm).toEqual({ op: "discard", paths: ["a.txt"] });
    expect(git?.pending[lingering.requestId]).toEqual({ kind: "refresh", label: "refresh" });
    expect(git?.lastError).toEqual({ label: "stage", reason: "boom" });

    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    assertNoFunctions(git);

    // GUI-P1 §2F.5: hiddenWorkspaces rides the same JSON round-trip as a
    // top-level (shell-level, not per-tab) field — populate it via the real
    // store action so the round-trip covers a non-empty array too.
    expect(facade.projectHide("/ws/unrelated")).toEqual({ ok: true });
    const snap2 = facade.snapshot();
    expect(snap2.hiddenWorkspaces).toContain("/ws/unrelated");
    expect(JSON.parse(JSON.stringify(snap2))).toEqual(snap2);
    assertNoFunctions(snap2.hiddenWorkspaces);
  });
});

describe("automation facade — gitCommand", () => {
  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand("ghost", { op: "refresh" })).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("not_ready before host_ready, sending nothing", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port)); // never emits host_ready
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand("tab-a", { op: "refresh" })).toEqual({ ok: false, reason: "not_ready" });
    expect(gitSends(port)).toEqual([]);
  });

  it("git_unavailable while status is still unknown (pill not yet live)", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab(); // ready, but no git_status yet
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand(tabId, { op: "refresh" })).toEqual({ ok: false, reason: "git_unavailable" });
    expect(gitSends(port)).toEqual([]);
  });

  it("git_unavailable when git_status is null (not a repo)", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab(null);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand(tabId, { op: "refresh" })).toEqual({ ok: false, reason: "git_unavailable" });
    expect(gitSends(port)).toEqual([]);
  });

  it("a schema-valid destructive command dispatched directly -> destructive_requires_confirm, nothing sent (R7 bypass)", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand(tabId, { op: "reset", mode: "hard", confirmed: true })).toEqual({
      ok: false,
      reason: "destructive_requires_confirm",
    });
    expect(gitSends(port)).toEqual([]);
    expect(registry.getStore(tabId)!.getState().git.pending).toEqual({});
  });

  it("a bare diff (no path/target) -> invalid_command, nothing sent", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCommand(tabId, { op: "diff" })).toEqual({ ok: false, reason: "invalid_command" });
    expect(gitSends(port)).toEqual([]);
  });

  it("ready+live: registers pending and sends git_command with the same requestId, valid against uiToHostMessageSchema", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const command: GitCommand = { op: "stage", paths: ["a.txt"] };

    const result = facade.gitCommand(tabId, command);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(registry.getStore(tabId)!.getState().git.pending[result.requestId]).toEqual({ kind: "mutation", label: "stage" });
    const sent = gitSends(port);
    expect(sent).toEqual([{ type: "git_command", requestId: result.requestId, command }]);
    expect(uiToHostMessageSchema.safeParse(sent[0]).success).toBe(true);
  });

  it("a concrete diff stamps git.diff and is schema-valid", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.gitCommand(tabId, { op: "diff", target: "worktree", path: "big.txt" });

    expect(result.ok).toBe(true);
    expect(registry.getStore(tabId)!.getState().git.diff).toEqual({ path: "big.txt", target: "worktree", text: "", truncated: false });
    expect(uiToHostMessageSchema.safeParse(gitSends(port)[0]).success).toBe(true);
  });
});

describe("automation facade — gitStageConfirm", () => {
  const discardIntent: GitDestructiveIntent = { op: "discard", paths: ["a.txt"] };

  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitStageConfirm("ghost", discardIntent)).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("not_ready before host_ready", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws/a", asPort(port));
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitStageConfirm("tab-a", discardIntent)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("git_unavailable when status is null", () => {
    const { registry, tabsStore, tabId } = setupGitReadyTab(null);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitStageConfirm(tabId, discardIntent)).toEqual({ ok: false, reason: "git_unavailable" });
  });

  it("stages the confirm intent on a ready+live tab (mounts the real dialog), zero sends", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.gitStageConfirm(tabId, discardIntent)).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().git.confirm).toEqual(discardIntent);
    expect(gitSends(port)).toEqual([]);
  });

  it("R10: refuses while a turn is running (confirm stays null, zero sends); passes once the turn ends", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });

    expect(facade.gitStageConfirm(tabId, discardIntent)).toEqual({ ok: false, reason: "turn_running" });
    expect(registry.getStore(tabId)!.getState().git.confirm).toBeNull();
    expect(gitSends(port)).toEqual([]);

    // loop_end returns the turn to idle (store.ts :1080) — the same intent now stages.
    port.emit({ type: "agent_event", turnId: "t0", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(facade.gitStageConfirm(tabId, discardIntent)).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().git.confirm).toEqual(discardIntent);
  });
});

describe("automation facade — gitConfirm", () => {
  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitConfirm("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("R2/§6#1: no staged confirm -> no_staged_confirm, ZERO sends (no confirmed command ever built)", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.gitConfirm(tabId)).toEqual({ ok: false, reason: "no_staged_confirm" });
    expect(gitSends(port)).toEqual([]);
  });

  it("stages then confirms: sends the destructive git_command (built ONLY via buildConfirmedGitCommand), clears confirm, schema-valid", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitStageConfirm(tabId, { op: "reset", mode: "hard" })).toEqual({ ok: true });

    const result = facade.gitConfirm(tabId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Confirm cleared; a mutation pending registered with the dialog's own label.
    expect(registry.getStore(tabId)!.getState().git.confirm).toBeNull();
    expect(registry.getStore(tabId)!.getState().git.pending[result.requestId]).toEqual({ kind: "mutation", label: "reset --hard" });
    const sent = gitSends(port);
    expect(sent).toEqual([{ type: "git_command", requestId: result.requestId, command: { op: "reset", mode: "hard", confirmed: true } }]);
    expect(uiToHostMessageSchema.safeParse(sent[0]).success).toBe(true);
  });
});

describe("automation facade — gitCancelConfirm", () => {
  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitCancelConfirm("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("clears a staged confirm unconditionally (fail-safe), zero sends", () => {
    const { registry, tabsStore, port, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitStageConfirm(tabId, { op: "stash_pop" })).toEqual({ ok: true });

    expect(facade.gitCancelConfirm(tabId)).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().git.confirm).toBeNull();
    expect(gitSends(port)).toEqual([]);
  });
});

describe("automation facade — gitSetPanelOpen", () => {
  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen("ghost", true)).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("opening guards on not_ready", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen("tab-a", true)).toEqual({ ok: false, reason: "not_ready" });
  });

  it("opening guards on git_unavailable (no live status)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen(tabId, true)).toEqual({ ok: false, reason: "git_unavailable" });
  });

  it("opens on a ready+live tab", () => {
    const { registry, tabsStore, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen(tabId, true)).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().git.panelOpen).toBe(true);
  });

  it("closing is unconditional (fail-safe) — succeeds even on a not-ready tab", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort()));
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen("tab-a", false)).toEqual({ ok: true });
    expect(registry.getStore("tab-a")!.getState().git.panelOpen).toBe(false);
  });
});

describe("automation facade — gitSetView", () => {
  it("unknown tab -> {ok:false}", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetView("ghost", "changes")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("invalid_view is checked before panel_closed (an out-of-set string is rejected even with the panel shut)", () => {
    const { registry, tabsStore, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetView(tabId, "pixels")).toEqual({ ok: false, reason: "invalid_view" });
  });

  it("panel_closed for a valid view while the panel is shut", () => {
    const { registry, tabsStore, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetView(tabId, "history")).toEqual({ ok: false, reason: "panel_closed" });
  });

  it("switches the view once the panel is open", () => {
    const { registry, tabsStore, tabId } = setupGitReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    expect(facade.gitSetPanelOpen(tabId, true)).toEqual({ ok: true });

    expect(facade.gitSetView(tabId, "history")).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().git.view).toBe("history");
  });
});

/** A fake `.message-list` scroll container: a plain mutable record, no DOM/jsdom needed. */
function fakeScrollContainer(overrides: Partial<{ scrollTop: number; scrollHeight: number; clientHeight: number }> = {}) {
  return {
    scrollTop: overrides.scrollTop ?? 0,
    scrollHeight: overrides.scrollHeight ?? 900,
    clientHeight: overrides.clientHeight ?? 400,
  };
}

describe("automation facade — transcriptScrollState / transcriptScrollTo (design/slice-P7.3-cut.md §3.3)", () => {
  it("transcriptScrollState refuses a tabId that isn't the active tab (tab_not_active)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    tabsStore.getState().setActiveTab("tab-b");
    const dom: TranscriptDom = { container: () => fakeScrollContainer(), jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
  });

  it("transcriptScrollState refuses when no transcript element is mounted (no_transcript)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const dom: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollState(tabId)).toEqual({ ok: false, reason: "no_transcript" });
  });

  it("transcriptScrollState queries dom.container with the EXACT tabId requested, not just any mounted node (codex P7.3-F2 finding 2)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const seen: string[] = [];
    const dom: TranscriptDom = {
      container: (t) => {
        seen.push(t);
        return fakeScrollContainer();
      },
      jumpButtonVisible: () => false,
    };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    facade.transcriptScrollState(tabId);
    expect(seen).toEqual([tabId]);
  });

  it("transcriptScrollState reports no_transcript when the store's activeTabId already flipped but the requested tab's own DOM node isn't mounted yet (the store-update-to-React-commit race the data-tab-id match guards against)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    // Simulates realTranscriptDom(): only a DIFFERENT tab's `.message-list`
    // (still mid-unmount) is actually in the DOM, so a tabId-scoped lookup
    // for THIS tab correctly finds nothing yet — unlike the old unscoped
    // `document.querySelector(".message-list")`, which would have silently
    // returned that stale node.
    const dom: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollState(tabId)).toEqual({ ok: false, reason: "no_transcript" });
  });

  it("transcriptScrollState reads geometry + computes atBottom via the SAME isAtBottom predicate the product uses", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    // Exactly at bottom: scrollHeight - scrollTop - clientHeight === 0.
    const container = fakeScrollContainer({ scrollTop: 500, scrollHeight: 900, clientHeight: 400 });
    const dom: TranscriptDom = { container: () => container, jumpButtonVisible: () => true };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollState(tabId)).toEqual({
      ok: true,
      scrollTop: 500,
      scrollHeight: 900,
      clientHeight: 400,
      atBottom: true,
      jumpVisible: true,
    });
  });

  it("transcriptScrollState reports atBottom:false + jumpVisible when scrolled away from the tail", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const container = fakeScrollContainer({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 });
    const dom: TranscriptDom = { container: () => container, jumpButtonVisible: () => true };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollState(tabId)).toEqual({
      ok: true,
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 400,
      atBottom: false,
      jumpVisible: true,
    });
  });

  it("transcriptScrollTo refuses a tabId that isn't the active tab (tab_not_active)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    tabsStore.getState().setActiveTab("tab-b");
    const container = fakeScrollContainer();
    const dom: TranscriptDom = { container: () => container, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollTo(tabId, "top")).toEqual({ ok: false, reason: "tab_not_active" });
    expect(container.scrollTop).toBe(0);
  });

  it("transcriptScrollTo refuses when no transcript element is mounted (no_transcript)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const dom: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollTo(tabId, "bottom")).toEqual({ ok: false, reason: "no_transcript" });
  });

  it('transcriptScrollTo("top") assigns scrollTop = 0 on the real container object (a genuine property write, not a re-implementation)', () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const container = fakeScrollContainer({ scrollTop: 500, scrollHeight: 900, clientHeight: 400 });
    const dom: TranscriptDom = { container: () => container, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollTo(tabId, "top")).toEqual({ ok: true });
    expect(container.scrollTop).toBe(0);
  });

  it('transcriptScrollTo("bottom") assigns scrollTop = scrollHeight on the real container object', () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const container = fakeScrollContainer({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 });
    const dom: TranscriptDom = { container: () => container, jumpButtonVisible: () => false };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom);
    expect(facade.transcriptScrollTo(tabId, "bottom")).toEqual({ ok: true });
    expect(container.scrollTop).toBe(900);
  });
});

describe("automation facade — todoPanelState (design/slice-P7.11-cut.md §3 W2)", () => {
  /** A dom stub reporting the transcript container as mounted (so tests below can isolate todoPanelDom behavior). */
  const mountedDom: TranscriptDom = { container: () => fakeScrollContainer(), jumpButtonVisible: () => false };

  it("todoPanelState refuses a tabId that isn't the active tab (tab_not_active)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    tabsStore.getState().setActiveTab("tab-b");
    const todoPanelDom: TodoPanelDom = { panel: () => null };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), mountedDom, todoPanelDom);
    expect(facade.todoPanelState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
  });

  it("todoPanelState refuses when no transcript element is mounted (no_transcript)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const dom: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
    const todoPanelDom: TodoPanelDom = { panel: () => null };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), dom, todoPanelDom);
    expect(facade.todoPanelState(tabId)).toEqual({ ok: false, reason: "no_transcript" });
  });

  it("todoPanelState reports visible:false with default fields when the panel card isn't mounted (no completed TodoWrite yet)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const todoPanelDom: TodoPanelDom = { panel: () => null };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), mountedDom, todoPanelDom);
    expect(facade.todoPanelState(tabId)).toEqual({
      ok: true,
      visible: false,
      header: null,
      panelCollapsed: false,
      completedRow: null,
      items: [],
    });
  });

  it("todoPanelState queries todoPanelDom.panel with the EXACT tabId requested", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const seen: string[] = [];
    const todoPanelDom: TodoPanelDom = {
      panel: (t) => {
        seen.push(t);
        return null;
      },
    };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), mountedDom, todoPanelDom);
    facade.todoPanelState(tabId);
    expect(seen).toEqual([tabId]);
  });

  it("todoPanelState reports visible:true + spreads the panel's header/collapsed/completedRow/items when mounted", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const todoPanelDom: TodoPanelDom = {
      panel: () => ({
        header: "Progress 1/3",
        panelCollapsed: false,
        completedRow: null,
        items: [
          { glyph: "active", content: "item two" },
          { glyph: "pending", content: "item three" },
        ],
      }),
    };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), mountedDom, todoPanelDom);
    expect(facade.todoPanelState(tabId)).toEqual({
      ok: true,
      visible: true,
      header: "Progress 1/3",
      panelCollapsed: false,
      completedRow: null,
      items: [
        { glyph: "active", content: "item two" },
        { glyph: "pending", content: "item three" },
      ],
    });
  });

  it("todoPanelState reports panelCollapsed:true + completedRow when the panel card carries them", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const todoPanelDom: TodoPanelDom = {
      panel: () => ({
        header: "Progress 3/3",
        panelCollapsed: true,
        completedRow: "↑ 3 completed",
        items: [],
      }),
    };
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), mountedDom, todoPanelDom);
    expect(facade.todoPanelState(tabId)).toEqual({
      ok: true,
      visible: true,
      header: "Progress 3/3",
      panelCollapsed: true,
      completedRow: "↑ 3 completed",
      items: [],
    });
  });
});

describe("automation facade — snapshot byte-lock with a draft present (design/slice-P7.12-cut.md §5 W2, R-1)", () => {
  it("snapshot() output for an existing fixture is BYTE-UNCHANGED even while a New Session draft is parked in the store", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const before = facade.snapshot();
    const beforeJson = JSON.stringify(before);

    tabsStore.getState().openDraft("/tmp/some-draft-workspace");
    tabsStore.getState().setDraftPrompt("hello from a parked draft");

    const after = facade.snapshot();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(beforeJson);
  });
});

/** Minimal `StartScreenDom` fake — every automation.test.ts call site pins projectMenuOpen closed unless a test says otherwise (slice-F5-1b-cut.md §2-D4). */
function fakeStartScreenDom(overrides: Partial<StartScreenDom> = {}): StartScreenDom {
  return {
    rendered: () => false,
    recentCount: () => 0,
    projectMenuOpen: () => false,
    clickProjectChip: () => {},
    ...overrides,
  };
}

describe("automation facade — startScreenState (design/slice-P7.12-cut.md §5 W2, extended by slice-F5-1b-cut.md §2-D4)", () => {
  it("reports active:false / workspace:null / prompt:'' / model:null / mode:null / sendEnabled:false / projectMenuOpen:false when no draft is open", () => {
    const { tabsStore, registry } = setupReadyTab();
    const startScreenDom = fakeStartScreenDom();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    expect(facade.startScreenState()).toEqual({
      ok: true,
      active: false,
      rendered: false,
      workspace: null,
      prompt: "",
      model: null,
      mode: null,
      sendEnabled: false,
      recentCount: 0,
      projectMenuOpen: false,
      // Codex-fixes TASK.42 (cut §3.7, B5-auto): `engine` is undefined until a
      // draft exists (mirrors workspace/prompt/model's draft-scoped reads);
      // `availableEngines` is the compiled-in catalog regardless of draft state.
      engine: undefined,
      availableEngines: ["core", "codex"],
    });
  });

  it("reports active/rendered/workspace/prompt/model off the live draft + recentCount/projectMenuOpen off the DOM probe", () => {
    const { tabsStore, registry } = setupReadyTab();
    tabsStore.getState().openDraft();
    tabsStore.getState().setDraftPrompt("hi");
    tabsStore.getState().setDraftModel("gpt-5.2");
    const startScreenDom = fakeStartScreenDom({ rendered: () => true, recentCount: () => 3, projectMenuOpen: () => true });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    expect(facade.startScreenState()).toEqual({
      ok: true,
      active: true,
      rendered: true,
      workspace: null,
      prompt: "hi",
      model: "gpt-5.2",
      mode: "build",
      sendEnabled: false, // §3-D3: no workspace yet -> still disabled
      recentCount: 3,
      projectMenuOpen: true,
      // Codex-fixes TASK.42 (cut §3.7, B5-auto): openDraft() defaults the
      // draft's engine to "core" (tabs-store.ts) — the catalog is unchanged.
      engine: "core",
      availableEngines: ["core", "codex"],
    });
  });

  it("sendEnabled is true only once BOTH a workspace is chosen AND the prompt is non-blank (byte-parity with computeSendDisabledReason)", () => {
    const { tabsStore, registry } = setupReadyTab();
    const startScreenDom = fakeStartScreenDom({ rendered: () => true });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    tabsStore.getState().openDraft("/ws/chosen");
    expect(facade.startScreenState().sendEnabled).toBe(false); // prompt still blank

    tabsStore.getState().setDraftPrompt("   ");
    expect(facade.startScreenState().sendEnabled).toBe(false); // whitespace-only prompt

    tabsStore.getState().setDraftPrompt("go");
    expect(facade.startScreenState().sendEnabled).toBe(true);
  });

  it("model defaults to null (provider default) until an explicit pick is made", () => {
    const { tabsStore, registry } = setupReadyTab();
    const startScreenDom = fakeStartScreenDom();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    tabsStore.getState().openDraft("/ws/chosen");
    expect(facade.startScreenState().model).toBeNull();

    tabsStore.getState().setDraftModel("claude-opus-4");
    expect(facade.startScreenState().model).toBe("claude-opus-4");
  });
});

describe("automation facade — startScreenOpen / startScreenSetWorkspace / startScreenSetPrompt (design/slice-P7.12-cut.md §5 W2)", () => {
  it("startScreenOpen creates a draft (create-or-focus, mirrors the real New Session entry points)", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.startScreenOpen()).toEqual({ ok: true });
    expect(tabsStore.getState().draft).toEqual({ workspace: null, prompt: "", model: null, mode: "build", engine: "core" });
    expect(tabsStore.getState().draftActive).toBe(true);
  });

  it("startScreenOpen with a workspace argument seeds/overwrites the draft's workspace", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.startScreenOpen("/ws/preset")).toEqual({ ok: true });
    expect(tabsStore.getState().draft).toEqual({ workspace: "/ws/preset", prompt: "", model: null, mode: "build", engine: "core" });
  });

  it("startScreenSetWorkspace refuses with no_draft when no draft is open, and touches nothing", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.startScreenSetWorkspace("/ws/x")).toEqual({ ok: false, reason: "no_draft" });
    expect(tabsStore.getState().draft).toBeNull();
  });

  it("startScreenSetWorkspace writes through the same setDraftWorkspace store action a real folder pick uses", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft();

    expect(facade.startScreenSetWorkspace("/ws/y")).toEqual({ ok: true });
    expect(tabsStore.getState().draft?.workspace).toBe("/ws/y");
  });

  it("startScreenSetPrompt refuses with no_draft when no draft is open, and touches nothing", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.startScreenSetPrompt("hello")).toEqual({ ok: false, reason: "no_draft" });
    expect(tabsStore.getState().draft).toBeNull();
  });

  it("startScreenSetPrompt writes through the same setDraftPrompt store action the textarea uses", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft("/ws/z");

    expect(facade.startScreenSetPrompt("hello")).toEqual({ ok: true });
    expect(tabsStore.getState().draft?.prompt).toBe("hello");
  });
});

describe("automation facade — startScreenSetModel (design/slice-F5-1b-cut.md §2-D4)", () => {
  it("refuses with no_draft when no draft is open, and touches nothing", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.startScreenSetModel("gpt-5.2")).toEqual({ ok: false, reason: "no_draft" });
    expect(tabsStore.getState().draft).toBeNull();
  });

  it("writes through the same setDraftModel store action the model chip uses", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft("/ws/z");

    expect(facade.startScreenSetModel("gpt-5.2")).toEqual({ ok: true });
    expect(tabsStore.getState().draft?.model).toBe("gpt-5.2");
  });

  it("accepts null to clear back to the provider default", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft("/ws/z");
    tabsStore.getState().setDraftModel("gpt-5.2");

    expect(facade.startScreenSetModel(null)).toEqual({ ok: true });
    expect(tabsStore.getState().draft?.model).toBeNull();
  });
});

describe("automation facade — startScreenSetEngine (codex-fixes TASK.42, cut §3.7)", () => {
  it("refuses with no_draft when no draft is open, and touches nothing", async () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    await expect(facade.startScreenSetEngine?.("codex")).resolves.toEqual({ ok: false, reason: "no_draft" });
    expect(tabsStore.getState().draft).toBeNull();
  });

  it("refuses with invalid_engine for an engine id outside the compiled-in catalog, and touches nothing", async () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft("/ws/z");

    await expect(facade.startScreenSetEngine?.("not-a-real-engine")).resolves.toEqual({ ok: false, reason: "invalid_engine" });
    expect(tabsStore.getState().draft?.engine).toBe("core");
  });

  it("writes through the SAME setDraftEngine store action a real engine picker would call", async () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, fakeStartScreenDom());
    tabsStore.getState().openDraft("/ws/z");
    expect(tabsStore.getState().draft?.engine).toBe("core"); // default before any pick

    await expect(facade.startScreenSetEngine?.("codex")).resolves.toEqual({ ok: true });
    expect(tabsStore.getState().draft?.engine).toBe("codex");
    expect(facade.startScreenState().engine).toBe("codex");
  });
});

describe("automation facade — startScreenSetMode", () => {
  it("uses the same draft mode setter as the start-screen menu", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, fakeStartScreenDom());
    tabsStore.getState().openDraft("/ws/z");

    expect(facade.startScreenSetMode("plan")).toEqual({ ok: true });
    expect(tabsStore.getState().draft?.mode).toBe("plan");
    expect(facade.startScreenState().mode).toBe("plan");
  });

  it("rejects an invalid mode without mutating the draft", () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    tabsStore.getState().openDraft("/ws/z");

    expect(facade.startScreenSetMode("unsafe")).toEqual({ ok: false, reason: "invalid_mode" });
    expect(tabsStore.getState().draft?.mode).toBe("build");
  });
});

describe("automation facade — startScreenToggleProjectMenu (design/slice-F5-1b-cut.md §2-D4)", () => {
  it("refuses with no_draft when no draft is open, and never clicks the chip", async () => {
    const { tabsStore, registry } = setupReadyTab();
    const clickProjectChip = vi.fn();
    const startScreenDom = fakeStartScreenDom({ clickProjectChip });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    await expect(facade.startScreenToggleProjectMenu(true)).resolves.toEqual({ ok: false, reason: "no_draft" });
    expect(clickProjectChip).not.toHaveBeenCalled();
  });

  it("is a no-op (no click) when the popover is already in the requested state", async () => {
    const { tabsStore, registry } = setupReadyTab();
    tabsStore.getState().openDraft("/ws/z");
    const clickProjectChip = vi.fn();
    const startScreenDom = fakeStartScreenDom({ projectMenuOpen: () => false, clickProjectChip });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    await expect(facade.startScreenToggleProjectMenu(false)).resolves.toEqual({ ok: true });
    expect(clickProjectChip).not.toHaveBeenCalled();
  });

  it("clicks the chip and awaits the commit when opening", async () => {
    const { tabsStore, registry } = setupReadyTab();
    tabsStore.getState().openDraft("/ws/z");
    let open = false;
    const startScreenDom = fakeStartScreenDom({
      projectMenuOpen: () => open,
      clickProjectChip: () => {
        open = true;
      },
    });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    await expect(facade.startScreenToggleProjectMenu(true)).resolves.toEqual({ ok: true });
  });

  it("clicks the chip and awaits the commit when closing", async () => {
    const { tabsStore, registry } = setupReadyTab();
    tabsStore.getState().openDraft("/ws/z");
    let open = true;
    const startScreenDom = fakeStartScreenDom({
      projectMenuOpen: () => open,
      clickProjectChip: () => {
        open = false;
      },
    });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    await expect(facade.startScreenToggleProjectMenu(false)).resolves.toEqual({ ok: true });
  });

  it("reports did_not_open when a real click no-ops (button disabled/absent)", async () => {
    const { tabsStore, registry } = setupReadyTab();
    tabsStore.getState().openDraft("/ws/z");
    const startScreenDom = fakeStartScreenDom({ projectMenuOpen: () => false, clickProjectChip: () => {} });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge(), undefined, undefined, startScreenDom);

    await expect(facade.startScreenToggleProjectMenu(true)).resolves.toEqual({ ok: false, reason: "did_not_open" });
  });
});

describe("automation facade — startScreenSubmit (design/slice-P7.12-cut.md §5 W2)", () => {
  it("delegates to submitStartDraft's own guards: no draft -> refusal, nothing sent", async () => {
    const { tabsStore, registry } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    await expect(facade.startScreenSubmit()).resolves.toEqual({ ok: false, message: "No draft to submit." });
  });

  it("creates the tab via the facade's OWN injected bridge, discards the draft, focuses the new tab, and queues the prompt for host_ready dispatch", async () => {
    const tabsStore: TabsStoreApi = createTabsStore();
    const registry: TabRegistry = createTabRegistry(tabsStore);
    const bridge = stubBridge({
      createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "new-tab", workspace: "/ws/new" })),
    });
    const facade = createAutomationFacade(registry, tabsStore, bridge);

    tabsStore.getState().openDraft("/ws/new");
    tabsStore.getState().setDraftPrompt("hello from the facade");

    const result = await facade.startScreenSubmit();

    expect(result).toEqual({ ok: true, tabId: "new-tab" });
    expect(bridge.createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/new" });
    expect(tabsStore.getState().draft).toBeNull();
    expect(tabsStore.getState().draftActive).toBe(false);
    expect(tabsStore.getState().activeTabId).toBe("new-tab");

    // §4.2: the queued prompt dispatches (appendUserText + user_message) the
    // moment the new tab's connection goes ready — same Composer-echo
    // discipline every other send path in this file asserts byte-for-byte.
    const port = new FakeMessagePort();
    registry.registerPort("new-tab", "/ws/new", asPort(port));
    port.emit(HOST_READY("/ws/new", "sess-new"));
    const sends = port.sent.filter((m) => (m as { type: string }).type !== "ui_ready");
    expect(sends).toEqual([{ type: "user_message", requestId: expect.any(String), text: "hello from the facade" }]);
    for (const message of sends) {
      expect(() => uiToHostMessageSchema.parse(message)).not.toThrow();
    }
  });
});

describe("automation facade — prompt queue (design/slice-P7.14-cut.md §5 W3)", () => {
  it("queuePrompt rejects with unknown_tab for a tabId the registry has never seen", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.queuePrompt("ghost", "hi")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("queuePrompt rejects with not_ready when the tab's connection isn't ready", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    registry.registerPort("tab-a", "/ws/a", asPort(new FakeMessagePort())); // never emits host_ready
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    expect(facade.queuePrompt("tab-a", "hi")).toEqual({ ok: false, reason: "not_ready" });
  });

  it("queuePrompt succeeds WHILE a turn is running (busy is deliberately not a rejection), appending to the tail and returning its minted id", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const first = facade.queuePrompt(tabId, "first");
    const second = facade.queuePrompt(tabId, "second");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.id).not.toBe(second.id);

    const queue = registry.getStore(tabId)!.getState().promptQueue;
    expect(queue.map((p) => ({ id: p.id, text: p.text }))).toEqual([
      { id: first.id, text: "first" },
      { id: second.id, text: "second" },
    ]);
    // Never touches the wire (design §1 — a pure renderer-side reducer mutation).
    expect(port.sent).toEqual([{ type: "ui_ready" }]);
  });

  it("queuePrompt at TRULY IDLE returns the correct minted id even though the drainer immediately pops the item into queueInFlight (no tail-read crash)", () => {
    // setupReadyTab leaves the tab idle+unpaused with the drainer wired, so the
    // enqueue fires the drainer synchronously and the just-added item is popped
    // off the tail into queueInFlight BEFORE any tail read. The old
    // `queue[queue.length - 1]!.id` read crashed here (undefined tail); the fix
    // returns the id straight from enqueuePrompt.
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());

    const result = facade.queuePrompt(tabId, "hello");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const store = registry.getStore(tabId)!.getState();
    // The item was drained (dispatched on the wire, held in flight) — the queue
    // is empty, yet the returned id matches the in-flight item.
    expect(store.promptQueue).toEqual([]);
    expect(store.queueInFlight?.item.id).toBe(result.id);
    expect(store.queueInFlight?.item.text).toBe("hello");
    // The drain went out on the wire (turn was idle → immediate dispatch).
    const drains = port.sent.filter((m) => (m as { type: string }).type === "user_message");
    expect(drains).toHaveLength(1);
  });

  it("queueEdit rejects with unknown_tab / unknown_prompt, and rewrites the text on a known id", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" }); // keep the item queued, not auto-drained
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const queued = facade.queuePrompt(tabId, "original");
    if (!queued.ok) throw new Error("unreachable");

    expect(facade.queueEdit("ghost", queued.id, "x")).toEqual({ ok: false, reason: "unknown_tab" });
    expect(facade.queueEdit(tabId, "not-an-id", "x")).toEqual({ ok: false, reason: "unknown_prompt" });

    const result = facade.queueEdit(tabId, queued.id, "edited");

    expect(result).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().promptQueue).toEqual([{ id: queued.id, text: "edited", images: [] }]);
  });

  it("queueDelete rejects with unknown_tab / unknown_prompt, and removes a known id", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" }); // keep the item queued, not auto-drained
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const queued = facade.queuePrompt(tabId, "to-delete");
    if (!queued.ok) throw new Error("unreachable");

    expect(facade.queueDelete("ghost", queued.id)).toEqual({ ok: false, reason: "unknown_tab" });
    expect(facade.queueDelete(tabId, "not-an-id")).toEqual({ ok: false, reason: "unknown_prompt" });

    const result = facade.queueDelete(tabId, queued.id);

    expect(result).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().promptQueue).toEqual([]);
  });

  it("queueResume rejects with unknown_tab, and clears queuePaused via the real resumeQueue action", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    registry.getStore(tabId)!.setState({ queuePaused: true });

    expect(facade.queueResume("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
    expect(registry.getStore(tabId)!.getState().queuePaused).toBe(true);

    expect(facade.queueResume(tabId)).toEqual({ ok: true });
    expect(registry.getStore(tabId)!.getState().queuePaused).toBe(false);
  });

  it("queueClear rejects with unknown_tab, and empties the queue + un-pauses via the real clearQueue action", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" }); // keep items queued, not auto-drained
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    facade.queuePrompt(tabId, "a");
    facade.queuePrompt(tabId, "b");
    registry.getStore(tabId)!.setState({ queuePaused: true });

    expect(facade.queueClear("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
    expect(registry.getStore(tabId)!.getState().promptQueue).toHaveLength(2);

    expect(facade.queueClear(tabId)).toEqual({ ok: true });
    const state = registry.getStore(tabId)!.getState();
    expect(state.promptQueue).toEqual([]);
    expect(state.queuePaused).toBe(false);
  });

  it("snapshot projects promptQueue with attachments stripped to imageCount and no base64", () => {
    const { registry, tabsStore, port, tabId } = setupReadyTab();
    port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" }); // keep the item queued, not auto-drained
    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    registry.getStore(tabId)!.getState().enqueuePrompt({
      text: "with image",
      images: [{ name: "a.png", sizeBytes: 10, attachment: { mediaType: "image/png", data: "QQ==" } }],
    });

    const snap = facade.snapshot();

    expect(snap.states[tabId]?.promptQueue).toEqual([{ id: expect.any(String), text: "with image", imageCount: 1 }]);
    expect(snap.states[tabId]?.queuePaused).toBe(false);
    assertNoFunctions(snap.states[tabId]?.promptQueue, "promptQueue");
  });
});

describe("automation facade — modelPillState / modelPillPick (design/slice-P7.15-cut.md §2.6 W4)", () => {
  const noTranscriptDom: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom: TodoPanelDom = { panel: () => null };
  const noStartScreenDom: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };

  function settingsSnapshotWithCatalog(providerId: string, models: { id: string; name?: string }[]): SettingsSnapshot {
    return {
      settings: {
        version: 1,
        provider: { id: providerId },
        tools: {},
        permissions: { alwaysAllow: [] },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      secrets: [],
      providerReady: true,
      envOverrides: [],
      readOnly: false,
      catalog: [{ id: providerId, name: providerId, authKind: "api_key", models }],
    };
  }

  /** A bare zustand settings store carrying exactly the given snapshot — never the app singleton, same isolation discipline as setupReadyTab's fresh tabsStore/registry. */
  function settingsStoreWith(snapshot: SettingsSnapshot | null) {
    const store = createSettingsStore();
    store.setState({ snapshot });
    return store;
  }

  /** A fully-controllable fake `ModelPillDom` (design §2.6 W4): `mounted`/`popoverOpen`/`page`/`manageDisabled` are frozen at construction (read-only probes); `clickChip`/`clickRootRow`/`clickItemAt` are spies so a test can assert exactly which real click the facade would have fired. */
  function pillDom(
    overrides: Partial<{ mounted: boolean; popoverOpen: boolean; page: "root" | "model" | "effort"; manageDisabled: boolean }> = {},
  ): ModelPillDom {
    return {
      mounted: () => overrides.mounted ?? true,
      popoverOpen: () => overrides.popoverOpen ?? false,
      currentPage: () => overrides.page ?? "root",
      manageDisabled: () => overrides.manageDisabled ?? true,
      clickChip: vi.fn<() => void>(),
      clickRootRow: vi.fn<(row: "model" | "effort") => void>(),
      clickItemAt: vi.fn<(index: number) => void>(),
    };
  }

  describe("modelPillState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom(),
        settingsStoreWith(null),
      );
      expect(facade.modelPillState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("reports present:false with conservative defaults when the pill isn't mounted (no active tab's chat UI yet)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom({ mounted: false }),
        settingsStoreWith(null),
      );
      expect(facade.modelPillState(tabId)).toEqual({
        ok: true,
        present: false,
        label: null,
        menuOpen: false,
        page: "root",
        effortRowVisible: false,
        modelItems: [],
        effortItems: [],
        currentModel: null,
        currentEffort: null,
        modelPickDisabled: true,
        manageModelsDisabled: true,
      });
    });

    it("reports label/modelItems/effortItems computed with the SAME pillLabel/modelDisplayName/modelMenuItems helpers ModelPill.tsx renders with", () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-5.2", reasoningEffort: "high", availableEffortLevels: ["off", "high", "max"] });
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom(),
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-5.2", name: "GLM-5.2" }])),
      );
      expect(facade.modelPillState(tabId)).toEqual({
        ok: true,
        present: true,
        label: "GLM-5.2 · High",
        menuOpen: false,
        page: "root",
        effortRowVisible: true,
        modelItems: [{ id: "glm-5.2", name: "GLM-5.2" }],
        effortItems: ["off", "high", "max"],
        currentModel: "glm-5.2",
        currentEffort: "high",
        modelPickDisabled: false,
        manageModelsDisabled: true,
      });
    });

    it("reports menuOpen/page straight off the DOM accessor — the popover's open/page state is local component useState, not store-observable", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom({ popoverOpen: true, page: "effort" }),
        settingsStoreWith(null),
      );
      const state = facade.modelPillState(tabId);
      expect(state.ok).toBe(true);
      if (!state.ok) throw new Error("unreachable");
      expect(state.menuOpen).toBe(true);
      expect(state.page).toBe("effort");
    });

    it("reports effortRowVisible:false + empty effortItems for a non-reasoning model (availableEffortLevels undefined) — the same capability gate that hides the row", () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-4.6", reasoningEffort: "off", availableEffortLevels: undefined });
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom(),
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-4.6" }])),
      );
      const state = facade.modelPillState(tabId);
      expect(state.ok).toBe(true);
      if (!state.ok) throw new Error("unreachable");
      expect(state.effortRowVisible).toBe(false);
      expect(state.effortItems).toEqual([]);
      expect(state.label).toBe("glm-4.6");
    });

    it("reports modelPickDisabled:true WHILE a turn is running — the exact between-turns guard modelPillPick also enforces", () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom(),
        settingsStoreWith(null),
      );
      const state = facade.modelPillState(tabId);
      expect(state.ok).toBe(true);
      if (!state.ok) throw new Error("unreachable");
      expect(state.modelPickDisabled).toBe(true);
    });
  });

  describe("modelPillPick", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active), touching no DOM", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const dom = pillDom();
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(null),
      );
      await expect(facade.modelPillPick(tabId, { kind: "open" })).resolves.toEqual({ ok: false, reason: "tab_not_active" });
      expect(dom.clickChip).not.toHaveBeenCalled();
    });

    it("rejects an unknown tabId (unknown_tab) — defensive-only: activeTabId forced past normal setActiveTab validation, mirroring snapshot()'s own defensive registry-miss comment", async () => {
      const tabsStore = createTabsStore();
      const registry = createTabRegistry(tabsStore);
      // Bypasses the guarded setActiveTab action (which validates the tab
      // exists) to reach the defensive branch — same technique other tests in
      // this file use to poke at a store's raw setState.
      tabsStore.setState({ activeTabId: "ghost" });
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom(),
        settingsStoreWith(null),
      );
      await expect(facade.modelPillPick("ghost", { kind: "open" })).resolves.toEqual({ ok: false, reason: "unknown_tab" });
    });

    it("refuses with not_present when the pill isn't mounted", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom({ mounted: false }),
        settingsStoreWith(null),
      );
      await expect(facade.modelPillPick(tabId, { kind: "open" })).resolves.toEqual({ ok: false, reason: "not_present" });
    });

    it("refuses EVERY pick kind with pick_disabled WHILE a turn is running (the live between-turns-guard negative) — and never touches the DOM", async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "turn_started", requestId: "r0", turnId: "t0" });
      const dom = pillDom();
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-4.6" }])),
      );
      // pick_disabled is checked BEFORE any click — a real disabled button
      // no-ops a real click too, so this stays synchronous in the facade and
      // resolves immediately here (no commit to await).
      await expect(facade.modelPillPick(tabId, { kind: "open" })).resolves.toEqual({ ok: false, reason: "pick_disabled" });
      await expect(facade.modelPillPick(tabId, { kind: "model", value: "glm-4.6" })).resolves.toEqual({ ok: false, reason: "pick_disabled" });
      expect(dom.clickChip).not.toHaveBeenCalled();
      expect(dom.clickItemAt).not.toHaveBeenCalled();
    });

    it('kind:"open" clicks the chip and succeeds when the popover reports open only after a tick (the React-commit race a live smoke caught — previously a false did_not_open)', async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      let open = false;
      // Models a REAL React commit: the click schedules the state flip onto
      // the NEXT tick rather than applying it synchronously, exactly like
      // `setOpen(true)` not being committed by the very next line.
      const clickChip = vi.fn(() => {
        setTimeout(() => {
          open = true;
        }, 0);
      });
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => open,
        currentPage: () => "root",
        manageDisabled: () => true,
        clickChip,
        clickRootRow: vi.fn(),
        clickItemAt: vi.fn(),
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(null),
      );
      await expect(facade.modelPillPick(tabId, { kind: "open" })).resolves.toEqual({ ok: true });
      expect(clickChip).toHaveBeenCalledTimes(1);
    });

    it('kind:"open" refuses with did_not_open when the popover never opens (a genuine no-open, e.g. a disabled chip DOM node / guard drift) — fails fast, bounded by the commit-poll deadline rather than hanging', async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        pillDom({ popoverOpen: false }),
        settingsStoreWith(null),
      );
      const start = Date.now();
      await expect(facade.modelPillPick(tabId, { kind: "open" })).resolves.toEqual({ ok: false, reason: "did_not_open" });
      const elapsed = Date.now() - start;
      // Bounded by the commit-poll deadline (~500ms), not open-ended: proves
      // this is a poll-with-deadline, not a fixed sleep or an infinite wait.
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });

    it('kind:"model" opens the popover, navigates to the Model page, and clicks the item at the SAME index modelMenuItems/the component\'s own .map() renders — both the chip-click and the row-click commit on a LATER tick, exercising the fix twice in one call', async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-5.2", reasoningEffort: "high", availableEffortLevels: ["off", "high", "max"] });
      let open = false;
      let page: "root" | "model" | "effort" = "root";
      const clickChip = vi.fn(() => {
        setTimeout(() => {
          open = true;
        }, 0);
      });
      const clickRootRow = vi.fn((row: "model" | "effort") => {
        setTimeout(() => {
          page = row;
        }, 0);
      });
      const clickItemAt = vi.fn();
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => open,
        currentPage: () => page,
        manageDisabled: () => true,
        clickChip,
        clickRootRow,
        clickItemAt,
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-5.2", name: "GLM-5.2" }, { id: "glm-4.6", name: "GLM-4.6" }])),
      );
      await expect(facade.modelPillPick(tabId, { kind: "model", value: "glm-4.6" })).resolves.toEqual({ ok: true });
      expect(clickChip).toHaveBeenCalledTimes(1);
      expect(clickRootRow).toHaveBeenCalledWith("model");
      // glm-4.6 is index 1 in the catalog-ordered modelItems list.
      expect(clickItemAt).toHaveBeenCalledWith(1);
    });

    it('kind:"model" with an already-open popover on the right page skips the chip/row clicks and clicks straight through', async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", availableEffortLevels: undefined });
      const clickChip = vi.fn();
      const clickRootRow = vi.fn();
      const clickItemAt = vi.fn();
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => true,
        currentPage: () => "model",
        manageDisabled: () => true,
        clickChip,
        clickRootRow,
        clickItemAt,
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-5.2" }])),
      );
      await expect(facade.modelPillPick(tabId, { kind: "model", value: "glm-5.2" })).resolves.toEqual({ ok: true });
      expect(clickChip).not.toHaveBeenCalled();
      expect(clickRootRow).not.toHaveBeenCalled();
      expect(clickItemAt).toHaveBeenCalledWith(0);
    });

    it('kind:"model" refuses with unknown_value for a model id not in the (catalog + current) list, without clicking any item', async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", availableEffortLevels: ["off", "high"] });
      const clickItemAt = vi.fn();
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => true,
        currentPage: () => "model",
        manageDisabled: () => true,
        clickChip: vi.fn(),
        clickRootRow: vi.fn(),
        clickItemAt,
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(settingsSnapshotWithCatalog("z-ai", [{ id: "glm-5.2" }])),
      );
      await expect(facade.modelPillPick(tabId, { kind: "model", value: "not-a-real-model" })).resolves.toEqual({ ok: false, reason: "unknown_value" });
      expect(clickItemAt).not.toHaveBeenCalled();
    });

    it('kind:"effort" refuses with effort_row_hidden for a non-reasoning model (no Effort row to navigate to) — the predicate never gets satisfied, so this too fails fast bounded by the commit-poll deadline rather than hanging', async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-4.6", reasoningEffort: "off", availableEffortLevels: undefined });
      // A real DOM never lands on "effort" here — clickRootRow("effort") is a
      // no-op because the row isn't rendered (design §2.2), so `currentPage`
      // stays "root" no matter how many times it's clicked.
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => true,
        currentPage: () => "root",
        manageDisabled: () => true,
        clickChip: vi.fn(),
        clickRootRow: vi.fn(),
        clickItemAt: vi.fn(),
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(null),
      );
      const start = Date.now();
      await expect(facade.modelPillPick(tabId, { kind: "effort", value: "high" })).resolves.toEqual({ ok: false, reason: "effort_row_hidden" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
      expect(dom.clickItemAt).not.toHaveBeenCalled();
    });

    it('kind:"effort" navigates to the Effort page and clicks the item at the matching index — chip-click and row-click both commit on a LATER tick', async () => {
      const { registry, tabsStore, port, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "model_changed", model: "glm-5.2", reasoningEffort: "off", availableEffortLevels: ["off", "high", "max"] });
      let open = false;
      let page: "root" | "model" | "effort" = "root";
      const clickChip = vi.fn(() => {
        setTimeout(() => {
          open = true;
        }, 0);
      });
      const clickRootRow = vi.fn((row: "model" | "effort") => {
        setTimeout(() => {
          page = row;
        }, 0);
      });
      const clickItemAt = vi.fn();
      const dom: ModelPillDom = {
        mounted: () => true,
        popoverOpen: () => open,
        currentPage: () => page,
        manageDisabled: () => true,
        clickChip,
        clickRootRow,
        clickItemAt,
      };
      const facade = createAutomationFacade(
        registry,
        tabsStore,
        stubBridge(),
        noTranscriptDom,
        noTodoPanelDom,
        noStartScreenDom,
        dom,
        settingsStoreWith(null),
      );
      await expect(facade.modelPillPick(tabId, { kind: "effort", value: "max" })).resolves.toEqual({ ok: true });
      expect(clickRootRow).toHaveBeenCalledWith("effort");
      expect(clickItemAt).toHaveBeenCalledWith(2);
    });
  });
});

describe("automation facade — ctxPopoverState / ctxPopoverOpen (design/slice-P7.17-cut.md F12 W4)", () => {
  const noTranscriptDom3: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom3: TodoPanelDom = { panel: () => null };
  const noStartScreenDom3: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom3: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };
  const inertSettingsDom3: SettingsDom = {
    mounted: () => false,
    activePane: () => null,
    panesVisible: () => [],
    searchQuery: () => "",
    clickSidebarSettings: vi.fn(),
    clickBackToApp: vi.fn(),
    clickPaneTab: vi.fn(() => false),
    fillPermissionTool: vi.fn(() => false),
    fillPermissionPattern: vi.fn(),
    permissionToolInputValue: () => "",
    canSubmitPermissionAdd: () => false,
    clickPermissionAdd: vi.fn(),
    clickPermissionRemove: vi.fn(() => false),
    permissionRemoveRowExists: () => false,
  };

  /** A bare zustand settings store with no snapshot — the ctx-popover facade methods never read it, but `createAutomationFacade`'s signature requires one. */
  function emptySettingsStore3() {
    const store = createSettingsStore();
    store.setState({ snapshot: null });
    return store;
  }

  /** A fully-controllable fake `CtxPopoverDom` (same discipline as modelPillState's `pillDom`): read probes are frozen at construction via `overrides`; `clickTrigger` is a spy so a test can assert exactly which real click the facade would have fired. */
  function fakeCtxPopoverDom(
    overrides: Partial<{
      mounted: boolean;
      open: boolean;
      percentText: string | null;
      headline: string | null;
      rows: { label: string; percent: number }[];
      sessionLineVisible: boolean;
    }> = {},
  ): CtxPopoverDom {
    return {
      mounted: () => overrides.mounted ?? true,
      open: () => overrides.open ?? false,
      clickTrigger: vi.fn<() => void>(),
      percentText: () => overrides.percentText ?? "42% ctx",
      headline: () => overrides.headline ?? "1.2K/10K (12%)",
      rows: () => overrides.rows ?? [],
      sessionLineVisible: () => overrides.sessionLineVisible ?? false,
    };
  }

  /** Builds a facade wired ONLY for the ctx-popover methods — the settings plumbing is present (required by `createAutomationFacade`'s signature) but never exercised by these tests. */
  function buildFacade(registry: TabRegistry, tabsStore: TabsStoreApi, dom: CtxPopoverDom) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom3,
      noTodoPanelDom3,
      noStartScreenDom3,
      noModelPillDom3,
      emptySettingsStore3(),
      inertSettingsDom3,
      dom,
    );
  }

  describe("ctxPopoverState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const facade = buildFacade(registry, tabsStore, fakeCtxPopoverDom());
      expect(facade.ctxPopoverState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("rejects an unknown tabId (unknown_tab) — defensive-only: activeTabId forced past normal setActiveTab validation, mirroring modelPillState's own defensive-branch test", () => {
      const tabsStore = createTabsStore();
      const registry = createTabRegistry(tabsStore);
      tabsStore.setState({ activeTabId: "ghost" });
      const facade = buildFacade(registry, tabsStore, fakeCtxPopoverDom());
      expect(facade.ctxPopoverState("ghost")).toEqual({ ok: false, reason: "unknown_tab" });
    });

    it("reports the closed/empty shape (not an error) when the ctx meter isn't mounted yet — pre-context_usage, Composer's own ctxPercent!==null mount gate", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = buildFacade(registry, tabsStore, fakeCtxPopoverDom({ mounted: false }));
      expect(facade.ctxPopoverState(tabId)).toEqual({
        ok: true,
        open: false,
        headline: null,
        percentText: null,
        rows: [],
        sessionTokens: null,
      });
    });

    it("reports percentText even while the panel is closed (the trigger chip's own always-visible text) but leaves headline/rows/sessionTokens at their closed defaults", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const dom = fakeCtxPopoverDom({ mounted: true, open: false, percentText: "7% ctx" });
      const facade = buildFacade(registry, tabsStore, dom);
      expect(facade.ctxPopoverState(tabId)).toEqual({
        ok: true,
        open: false,
        percentText: "7% ctx",
        headline: null,
        rows: [],
        sessionTokens: null,
      });
    });

    it("returns a full reading (percentText/headline/rows/sessionTokens) when the meter is mounted and the panel is open — sessionTokens copied straight off the live store, not re-parsed from rendered text", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      registry.getStore(tabId)?.setState({
        sessionTokens: { input: 100, output: 50, total: 150, latestCacheRead: 75, latestCacheInput: 100 },
      });
      const dom = fakeCtxPopoverDom({
        mounted: true,
        open: true,
        percentText: "42% ctx",
        headline: "1.2K/10K (12%)",
        rows: [
          { label: "Messages", percent: 60 },
          { label: "System prompt", percent: 40 },
        ],
        sessionLineVisible: true,
      });
      const facade = buildFacade(registry, tabsStore, dom);
      expect(facade.ctxPopoverState(tabId)).toEqual({
        ok: true,
        open: true,
        percentText: "42% ctx",
        headline: "1.2K/10K (12%)",
        rows: [
          { label: "Messages", percent: 60 },
          { label: "System prompt", percent: 40 },
        ],
        sessionTokens: { input: 100, output: 50, total: 150, latestCacheRead: 75, latestCacheInput: 100 },
      });
    });

    it("reports sessionTokens:null while open if the session line isn't rendered yet (no finish landed this session), even though the store already carries a stale value from a prior tab lifecycle", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      registry.getStore(tabId)?.setState({ sessionTokens: { input: 1, output: 1, total: 2 } });
      const dom = fakeCtxPopoverDom({ mounted: true, open: true, sessionLineVisible: false });
      const facade = buildFacade(registry, tabsStore, dom);
      const state = facade.ctxPopoverState(tabId);
      expect(state.ok).toBe(true);
      if (!state.ok) throw new Error("unreachable");
      expect(state.sessionTokens).toBeNull();
    });
  });

  describe("ctxPopoverOpen", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active), touching no DOM", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const dom = fakeCtxPopoverDom();
      const facade = buildFacade(registry, tabsStore, dom);
      await expect(facade.ctxPopoverOpen(tabId, true)).resolves.toEqual({ ok: false, reason: "tab_not_active" });
      expect(dom.clickTrigger).not.toHaveBeenCalled();
    });

    it("rejects an unknown tabId (unknown_tab)", async () => {
      const tabsStore = createTabsStore();
      const registry = createTabRegistry(tabsStore);
      tabsStore.setState({ activeTabId: "ghost" });
      const facade = buildFacade(registry, tabsStore, fakeCtxPopoverDom());
      await expect(facade.ctxPopoverOpen("ghost", true)).resolves.toEqual({ ok: false, reason: "unknown_tab" });
    });

    it("refuses with not_present when the ctx meter isn't mounted", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const dom = fakeCtxPopoverDom({ mounted: false });
      const facade = buildFacade(registry, tabsStore, dom);
      await expect(facade.ctxPopoverOpen(tabId, true)).resolves.toEqual({ ok: false, reason: "not_present" });
      expect(dom.clickTrigger).not.toHaveBeenCalled();
    });

    it("no-ops (ok:true, no click) when the panel already reports the requested open state", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const dom = fakeCtxPopoverDom({ mounted: true, open: true });
      const facade = buildFacade(registry, tabsStore, dom);
      await expect(facade.ctxPopoverOpen(tabId, true)).resolves.toEqual({ ok: true });
      expect(dom.clickTrigger).not.toHaveBeenCalled();
    });

    it("clicks the trigger and succeeds when the panel reports open only after a tick (the same React-commit race modelPillPick fixes)", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      let open = false;
      // Models a REAL React commit: the click schedules the state flip onto
      // the NEXT tick rather than applying it synchronously.
      const clickTrigger = vi.fn(() => {
        setTimeout(() => {
          open = true;
        }, 0);
      });
      const dom: CtxPopoverDom = {
        mounted: () => true,
        open: () => open,
        clickTrigger,
        percentText: () => "1% ctx",
        headline: () => null,
        rows: () => [],
        sessionLineVisible: () => false,
      };
      const facade = buildFacade(registry, tabsStore, dom);
      await expect(facade.ctxPopoverOpen(tabId, true)).resolves.toEqual({ ok: true });
      expect(clickTrigger).toHaveBeenCalledTimes(1);
    });

    it("refuses with did_not_open when the click never opens the panel (a genuine no-op click) — fails fast, bounded by the commit-poll deadline rather than hanging", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const dom = fakeCtxPopoverDom({ mounted: true, open: false });
      const facade = buildFacade(registry, tabsStore, dom);
      const start = Date.now();
      await expect(facade.ctxPopoverOpen(tabId, true)).resolves.toEqual({ ok: false, reason: "did_not_open" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
      expect(dom.clickTrigger).toHaveBeenCalledTimes(1);
    });

    it("refuses with did_not_close when the click never closes the panel, bounded by the same commit-poll deadline", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const dom = fakeCtxPopoverDom({ mounted: true, open: true });
      const facade = buildFacade(registry, tabsStore, dom);
      await expect(facade.ctxPopoverOpen(tabId, false)).resolves.toEqual({ ok: false, reason: "did_not_close" });
      expect(dom.clickTrigger).toHaveBeenCalledTimes(1);
    });
  });
});

describe("automation facade — settings probe/driver (design/slice-P7.16-cut.md §5 W4)", () => {
  const noTranscriptDom2: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom2: TodoPanelDom = { panel: () => null };
  const noStartScreenDom2: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };

  function baseSnapshot(alwaysAllow: AlwaysAllowRule[]): SettingsSnapshot {
    return {
      settings: {
        version: 1,
        provider: { id: "z-ai" },
        tools: {},
        permissions: { alwaysAllow },
        ui: { theme: "system" },
        security: { allowWeakSecretStorage: false },
      },
      secrets: [],
      providerReady: true,
      envOverrides: [],
      readOnly: false,
      catalog: [],
    };
  }

  /** A bare zustand settings store carrying `alwaysAllow`, same isolation discipline as modelPillState's `settingsStoreWith`. */
  function settingsStoreWithRules(alwaysAllow: AlwaysAllowRule[]) {
    const store = createSettingsStore();
    store.setState({ snapshot: baseSnapshot(alwaysAllow) });
    return store;
  }

  /** Builds a facade wired ONLY for the settings methods — the tab/registry plumbing is present (required by `createAutomationFacade`'s signature) but never exercised by these tests. */
  function buildFacade(settingsStore: ReturnType<typeof createSettingsStore>, dom: SettingsDom) {
    const tabsStore: TabsStoreApi = createTabsStore();
    const registry: TabRegistry = createTabRegistry(tabsStore);
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom2,
      noTodoPanelDom2,
      noStartScreenDom2,
      noModelPillDom,
      settingsStore,
      dom,
    );
  }

  /** A fully-controllable fake `SettingsDom` (same discipline as modelPillState's `pillDom`): read probes are frozen at construction via `overrides`; every drive method is a spy so a test can assert exactly which real DOM action the facade would have fired. */
  function fakeSettingsDom(
    overrides: Partial<{
      mounted: boolean;
      activePane: string | null;
      panesVisible: string[];
      searchQuery: string;
      clickPaneTabResult: boolean;
      fillToolResult: boolean;
      canSubmit: boolean;
      clickRemoveResult: boolean;
      toolInputValue: string;
      removeRowExists: boolean;
    }> = {},
  ): SettingsDom {
    return {
      mounted: () => overrides.mounted ?? true,
      activePane: () => overrides.activePane ?? "provider",
      panesVisible: () => overrides.panesVisible ?? ["provider", "permissions"],
      searchQuery: () => overrides.searchQuery ?? "",
      clickSidebarSettings: vi.fn<() => void>(),
      clickBackToApp: vi.fn<() => void>(),
      clickPaneTab: vi.fn<(paneId: string) => boolean>(() => overrides.clickPaneTabResult ?? true),
      fillPermissionTool: vi.fn<(value: string) => boolean>(() => overrides.fillToolResult ?? true),
      fillPermissionPattern: vi.fn<(value: string) => void>(),
      permissionToolInputValue: () => overrides.toolInputValue ?? "",
      canSubmitPermissionAdd: () => overrides.canSubmit ?? true,
      clickPermissionAdd: vi.fn<() => void>(),
      clickPermissionRemove: vi.fn<(ariaLabel: string) => boolean>(() => overrides.clickRemoveResult ?? true),
      permissionRemoveRowExists: () => overrides.removeRowExists ?? false,
    };
  }

  describe("settingsState", () => {
    it("reports the closed shape (empty defaults) when the dialog isn't mounted — never reads the DOM probes or the store snapshot", () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([{ toolName: "Bash", pattern: "git *" }]), dom);
      expect(facade.settingsState()).toEqual({
        open: false,
        activePane: null,
        panesVisible: [],
        searchQuery: "",
        permissions: { groups: [] },
      });
    });

    it("groups permissions from the settings-store snapshot via the SAME groupAlwaysAllowRules/ruleHasPattern/ruleDisplayPattern helpers PermissionsEditor.tsx renders with — a pattern-less rule reports pattern:null, display:'all uses'", () => {
      const dom = fakeSettingsDom({ mounted: true, activePane: "permissions", panesVisible: ["provider", "permissions"], searchQuery: "" });
      const rules: AlwaysAllowRule[] = [
        { toolName: "Bash", pattern: "git *" },
        { toolName: "Bash", pattern: "node *" },
        { toolName: "Edit" },
      ];
      const facade = buildFacade(settingsStoreWithRules(rules), dom);
      expect(facade.settingsState()).toEqual({
        open: true,
        activePane: "permissions",
        panesVisible: ["provider", "permissions"],
        searchQuery: "",
        permissions: {
          groups: [
            { toolName: "Bash", rules: [{ pattern: "git *", display: "git *" }, { pattern: "node *", display: "node *" }] },
            { toolName: "Edit", rules: [{ pattern: null, display: "all uses" }] },
          ],
        },
      });
    });

    it("reads open/activePane/panesVisible/searchQuery straight off the DOM accessor — local component useState, not store-observable", () => {
      const dom = fakeSettingsDom({ mounted: true, activePane: "tools", panesVisible: ["provider", "tools"], searchQuery: "concurrency" });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const state = facade.settingsState();
      expect(state.activePane).toBe("tools");
      expect(state.panesVisible).toEqual(["provider", "tools"]);
      expect(state.searchQuery).toBe("concurrency");
    });
  });

  describe("settingsOpen", () => {
    it("no-ops (ok:true) without touching the DOM when the dialog is already mounted", async () => {
      const dom = fakeSettingsDom({ mounted: true });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsOpen()).resolves.toEqual({ ok: true });
      expect(dom.clickSidebarSettings).not.toHaveBeenCalled();
    });

    it("clicks the sidebar gear trigger and succeeds when mounted() reports true only after a tick (the same React-commit race modelPillPick fixes)", async () => {
      let mounted = false;
      const clickSidebarSettings = vi.fn(() => {
        setTimeout(() => {
          mounted = true;
        }, 0);
      });
      const dom: SettingsDom = {
        ...fakeSettingsDom({ mounted: false }),
        mounted: () => mounted,
        clickSidebarSettings,
      };
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsOpen()).resolves.toEqual({ ok: true });
      expect(clickSidebarSettings).toHaveBeenCalledTimes(1);
    });

    it("refuses with did_not_open when the dialog never mounts, bounded by the commit-poll deadline rather than hanging", async () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const start = Date.now();
      await expect(facade.settingsOpen()).resolves.toEqual({ ok: false, reason: "did_not_open" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("settingsClose", () => {
    it("no-ops (ok:true) without touching the DOM when the dialog is already closed", async () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsClose()).resolves.toEqual({ ok: true });
      expect(dom.clickBackToApp).not.toHaveBeenCalled();
    });

    it("clicks the Back-to-app row and succeeds when mounted() flips to false only after a tick", async () => {
      let mounted = true;
      const clickBackToApp = vi.fn(() => {
        setTimeout(() => {
          mounted = false;
        }, 0);
      });
      const dom: SettingsDom = {
        ...fakeSettingsDom({ mounted: true }),
        mounted: () => mounted,
        clickBackToApp,
      };
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsClose()).resolves.toEqual({ ok: true });
      expect(clickBackToApp).toHaveBeenCalledTimes(1);
    });

    it("refuses with did_not_close when the dialog never unmounts, bounded by the commit-poll deadline", async () => {
      const dom = fakeSettingsDom({ mounted: true });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const start = Date.now();
      await expect(facade.settingsClose()).resolves.toEqual({ ok: false, reason: "did_not_close" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("settingsSelectPane", () => {
    it("refuses with not_open when the dialog isn't mounted, without clicking any tab", async () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsSelectPane("permissions")).resolves.toEqual({ ok: false, reason: "not_open" });
      expect(dom.clickPaneTab).not.toHaveBeenCalled();
    });

    it("refuses with pane_not_visible when the tab isn't currently rendered (filtered out by search)", async () => {
      const dom = fakeSettingsDom({ mounted: true, clickPaneTabResult: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsSelectPane("about")).resolves.toEqual({ ok: false, reason: "pane_not_visible" });
    });

    it("clicks the rail tab and succeeds once activePane() reports the target only after a tick", async () => {
      let activePane = "provider";
      const clickPaneTab = vi.fn((paneId: string) => {
        setTimeout(() => {
          activePane = paneId;
        }, 0);
        return true;
      });
      const dom: SettingsDom = {
        ...fakeSettingsDom({ mounted: true }),
        activePane: () => activePane,
        clickPaneTab,
      };
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsSelectPane("permissions")).resolves.toEqual({ ok: true });
      expect(clickPaneTab).toHaveBeenCalledWith("permissions");
    });

    it("refuses with pane_switch_failed when activePane never matches, bounded by the commit-poll deadline", async () => {
      const dom = fakeSettingsDom({ mounted: true, activePane: "provider", clickPaneTabResult: true });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const start = Date.now();
      await expect(facade.settingsSelectPane("permissions")).resolves.toEqual({ ok: false, reason: "pane_switch_failed" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("settingsPermissionAdd", () => {
    it("refuses with not_open when the dialog isn't mounted, touching no form field", async () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionAdd({ toolName: "Bash" })).resolves.toEqual({ ok: false, reason: "not_open" });
      expect(dom.fillPermissionTool).not.toHaveBeenCalled();
    });

    it("refuses with form_not_present when the manual-add form isn't rendered (wrong pane active)", async () => {
      const dom = fakeSettingsDom({ mounted: true, fillToolResult: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionAdd({ toolName: "Bash" })).resolves.toEqual({ ok: false, reason: "form_not_present" });
      expect(dom.clickPermissionAdd).not.toHaveBeenCalled();
    });

    it("fills the pattern field with '' when omitted, and refuses with add_disabled when the Add button stays disabled after fill", async () => {
      const dom = fakeSettingsDom({ mounted: true, fillToolResult: true, canSubmit: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionAdd({ toolName: "   " })).resolves.toEqual({ ok: false, reason: "add_disabled" });
      expect(dom.fillPermissionPattern).toHaveBeenCalledWith("");
      expect(dom.clickPermissionAdd).not.toHaveBeenCalled();
    });

    it("fills both fields, clicks Add, and succeeds once the tool input clears only after a tick (handleAdd's async success signal)", async () => {
      let toolValue = "Bash";
      const clickPermissionAdd = vi.fn(() => {
        setTimeout(() => {
          toolValue = "";
        }, 0);
      });
      const dom: SettingsDom = {
        ...fakeSettingsDom({ mounted: true, canSubmit: true }),
        permissionToolInputValue: () => toolValue,
        clickPermissionAdd,
      };
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionAdd({ toolName: "Bash", pattern: 'OUT="/tmp/o" node *' })).resolves.toEqual({ ok: true });
      expect(dom.fillPermissionTool).toHaveBeenCalledWith("Bash");
      expect(dom.fillPermissionPattern).toHaveBeenCalledWith('OUT="/tmp/o" node *');
      expect(clickPermissionAdd).toHaveBeenCalledTimes(1);
    });

    it("refuses with add_failed when the tool input never clears (the mutation was refused store-side), bounded by the commit-poll deadline", async () => {
      const dom = fakeSettingsDom({ mounted: true, canSubmit: true, toolInputValue: "Bash" });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const start = Date.now();
      await expect(facade.settingsPermissionAdd({ toolName: "Bash" })).resolves.toEqual({ ok: false, reason: "add_failed" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });
  });

  describe("settingsPermissionRemove", () => {
    it("refuses with not_open when the dialog isn't mounted, touching no row", async () => {
      const dom = fakeSettingsDom({ mounted: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionRemove({ toolName: "Bash", pattern: "git *" })).resolves.toEqual({ ok: false, reason: "not_open" });
      expect(dom.clickPermissionRemove).not.toHaveBeenCalled();
    });

    it("computes the SAME aria-label ruleRemoveAriaLabel produces (byte-parity with PermissionsEditor.tsx's row) and refuses with rule_not_found when no such row is rendered", async () => {
      const dom = fakeSettingsDom({ mounted: true, clickRemoveResult: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionRemove({ toolName: "Bash", pattern: "git *" })).resolves.toEqual({ ok: false, reason: "rule_not_found" });
      expect(dom.clickPermissionRemove).toHaveBeenCalledWith(ruleRemoveAriaLabel({ toolName: "Bash", pattern: "git *" }));
    });

    it('computes the "all uses" aria-label for a pattern-less rule (pattern omitted)', async () => {
      const dom = fakeSettingsDom({ mounted: true, clickRemoveResult: false });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionRemove({ toolName: "WebFetch" })).resolves.toEqual({ ok: false, reason: "rule_not_found" });
      expect(dom.clickPermissionRemove).toHaveBeenCalledWith(ruleRemoveAriaLabel({ toolName: "WebFetch", pattern: undefined }));
    });

    it("clicks the matching row and succeeds once the row disappears only after a tick", async () => {
      let rowExists = true;
      const clickPermissionRemove = vi.fn(() => {
        setTimeout(() => {
          rowExists = false;
        }, 0);
        return true;
      });
      const dom: SettingsDom = {
        ...fakeSettingsDom({ mounted: true }),
        permissionRemoveRowExists: () => rowExists,
        clickPermissionRemove,
      };
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      await expect(facade.settingsPermissionRemove({ toolName: "Bash", pattern: "git *" })).resolves.toEqual({ ok: true });
      expect(clickPermissionRemove).toHaveBeenCalledTimes(1);
    });

    it("refuses with remove_failed when the row never disappears, bounded by the commit-poll deadline", async () => {
      const dom = fakeSettingsDom({ mounted: true, clickRemoveResult: true, removeRowExists: true });
      const facade = buildFacade(settingsStoreWithRules([]), dom);
      const start = Date.now();
      await expect(facade.settingsPermissionRemove({ toolName: "Bash", pattern: "git *" })).resolves.toEqual({ ok: false, reason: "remove_failed" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});

describe("automation facade — agentCardState (design/slice-P7.18-cut.md §4 W4)", () => {
  const noTranscriptDom4: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom4: TodoPanelDom = { panel: () => null };
  const noStartScreenDom4: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom4: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };
  const inertSettingsDom4: SettingsDom = {
    mounted: () => false,
    activePane: () => null,
    panesVisible: () => [],
    searchQuery: () => "",
    clickSidebarSettings: vi.fn(),
    clickBackToApp: vi.fn(),
    clickPaneTab: vi.fn(() => false),
    fillPermissionTool: vi.fn(() => false),
    fillPermissionPattern: vi.fn(),
    permissionToolInputValue: () => "",
    canSubmitPermissionAdd: () => false,
    clickPermissionAdd: vi.fn(),
    clickPermissionRemove: vi.fn(() => false),
    permissionRemoveRowExists: () => false,
  };
  const inertCtxPopoverDom4: CtxPopoverDom = {
    mounted: () => false,
    open: () => false,
    clickTrigger: vi.fn(),
    percentText: () => null,
    headline: () => null,
    rows: () => [],
    sessionLineVisible: () => false,
  };

  /** A bare zustand settings store with no snapshot — `createAutomationFacade`'s signature requires one, but agentCardState never reads it. */
  function emptySettingsStore4() {
    const store = createSettingsStore();
    store.setState({ snapshot: null });
    return store;
  }

  /** Builds a facade wired ONLY for `agentCardState` — every other DI slot carries an inert double that agentCardState never touches. */
  function buildFacade(registry: TabRegistry, tabsStore: TabsStoreApi, agentCardDom: AgentCardDom) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom4,
      noTodoPanelDom4,
      noStartScreenDom4,
      noModelPillDom4,
      emptySettingsStore4(),
      inertSettingsDom4,
      inertCtxPopoverDom4,
      agentCardDom,
    );
  }

  it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
    const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    tabsStore.getState().setActiveTab("tab-b");
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    expect(facade.agentCardState(tabId, "call-1")).toEqual({ ok: false, reason: "tab_not_active" });
  });

  it("rejects an unknown tabId (unknown_tab) — defensive-only, mirroring ctxPopoverState's own defensive-branch test", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    tabsStore.setState({ activeTabId: "ghost" });
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    expect(facade.agentCardState("ghost", "call-1")).toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("reports the empty default shape (not an error) when the card isn't rendered yet — unknown toolCallId, or the block hasn't reached the transcript", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    expect(facade.agentCardState(tabId, "call-1")).toEqual({
      ok: true,
      expanded: false,
      promptCollapsed: true,
      feedRowCount: 0,
      resultRendered: false,
    });
  });

  it("queries agentCardDom.state with the EXACT tabId + toolCallId requested", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const seen: Array<[string, string]> = [];
    const agentCardDom: AgentCardDom = {
      state: (t, id) => {
        seen.push([t, id]);
        return null;
      },
      clickToggle: vi.fn(() => false),
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    facade.agentCardState(tabId, "call-42");
    expect(seen).toEqual([[tabId, "call-42"]]);
  });

  it("spreads a found card's expanded/promptCollapsed/feedRowCount/resultRendered verbatim", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const agentCardDom: AgentCardDom = {
      state: () => ({ expanded: true, promptCollapsed: true, feedRowCount: 5, resultRendered: true }),
      clickToggle: vi.fn(() => false),
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    expect(facade.agentCardState(tabId, "call-1")).toEqual({
      ok: true,
      expanded: true,
      promptCollapsed: true,
      feedRowCount: 5,
      resultRendered: true,
    });
  });

  it("reports promptCollapsed:false once the plaque's own second click has expanded it", () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const agentCardDom: AgentCardDom = {
      state: () => ({ expanded: true, promptCollapsed: false, feedRowCount: 2, resultRendered: true }),
      clickToggle: vi.fn(() => false),
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    const state = facade.agentCardState(tabId, "call-1");
    expect(state).toMatchObject({ ok: true, promptCollapsed: false });
  });
});

describe("automation facade — agentCardExpand (design/slice-P7.18-cut.md §4 W4)", () => {
  const noTranscriptDom5: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom5: TodoPanelDom = { panel: () => null };
  const noStartScreenDom5: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom5: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };
  const inertSettingsDom5: SettingsDom = {
    mounted: () => false,
    activePane: () => null,
    panesVisible: () => [],
    searchQuery: () => "",
    clickSidebarSettings: vi.fn(),
    clickBackToApp: vi.fn(),
    clickPaneTab: vi.fn(() => false),
    fillPermissionTool: vi.fn(() => false),
    fillPermissionPattern: vi.fn(),
    permissionToolInputValue: () => "",
    canSubmitPermissionAdd: () => false,
    clickPermissionAdd: vi.fn(),
    clickPermissionRemove: vi.fn(() => false),
    permissionRemoveRowExists: () => false,
  };
  const inertCtxPopoverDom5: CtxPopoverDom = {
    mounted: () => false,
    open: () => false,
    clickTrigger: vi.fn(),
    percentText: () => null,
    headline: () => null,
    rows: () => [],
    sessionLineVisible: () => false,
  };

  function emptySettingsStore5() {
    const store = createSettingsStore();
    store.setState({ snapshot: null });
    return store;
  }

  function buildFacade(registry: TabRegistry, tabsStore: TabsStoreApi, agentCardDom: AgentCardDom) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom5,
      noTodoPanelDom5,
      noStartScreenDom5,
      noModelPillDom5,
      emptySettingsStore5(),
      inertSettingsDom5,
      inertCtxPopoverDom5,
      agentCardDom,
    );
  }

  it("refuses a tabId that isn't the active tab (tab_not_active)", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
    registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
    tabsStore.getState().setActiveTab("tab-b");
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    await expect(facade.agentCardExpand(tabId, "call-1")).resolves.toEqual({ ok: false, reason: "tab_not_active" });
  });

  it("rejects an unknown tabId (unknown_tab)", async () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    tabsStore.setState({ activeTabId: "ghost" });
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    await expect(facade.agentCardExpand("ghost", "call-1")).resolves.toEqual({ ok: false, reason: "unknown_tab" });
  });

  it("refuses with not_present when no card with this toolCallId is rendered", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const clickToggle = vi.fn(() => false);
    const agentCardDom: AgentCardDom = { state: () => null, clickToggle };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    await expect(facade.agentCardExpand(tabId, "call-1")).resolves.toEqual({ ok: false, reason: "not_present" });
    expect(clickToggle).not.toHaveBeenCalled();
  });

  it("no-ops (ok:true) without clicking when the card already reads expanded:true", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const clickToggle = vi.fn(() => true);
    const agentCardDom: AgentCardDom = {
      state: () => ({ expanded: true, promptCollapsed: true, feedRowCount: 0, resultRendered: false }),
      clickToggle,
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    await expect(facade.agentCardExpand(tabId, "call-1")).resolves.toEqual({ ok: true });
    expect(clickToggle).not.toHaveBeenCalled();
  });

  it("clicks the toggle and succeeds once the card reports expanded:true only after a tick (same commit-race guard as ctxPopoverOpen/modelPillPick)", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    let expanded = false;
    const clickToggle = vi.fn(() => {
      setTimeout(() => {
        expanded = true;
      }, 0);
      return true;
    });
    const agentCardDom: AgentCardDom = {
      state: () => (expanded ? { expanded: true, promptCollapsed: true, feedRowCount: 3, resultRendered: true } : { expanded: false, promptCollapsed: true, feedRowCount: 0, resultRendered: false }),
      clickToggle,
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    await expect(facade.agentCardExpand(tabId, "call-1")).resolves.toEqual({ ok: true });
    expect(clickToggle).toHaveBeenCalledTimes(1);
  });

  it("refuses with did_not_expand when the click never expands the card, bounded by the commit-poll deadline", async () => {
    const { registry, tabsStore, tabId } = setupReadyTab();
    tabsStore.getState().setActiveTab(tabId);
    const clickToggle = vi.fn(() => true);
    const agentCardDom: AgentCardDom = {
      state: () => ({ expanded: false, promptCollapsed: true, feedRowCount: 0, resultRendered: false }),
      clickToggle,
    };
    const facade = buildFacade(registry, tabsStore, agentCardDom);
    const start = Date.now();
    await expect(facade.agentCardExpand(tabId, "call-1")).resolves.toEqual({ ok: false, reason: "did_not_expand" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
    expect(clickToggle).toHaveBeenCalledTimes(1);
  });
});

describe("automation facade — Skills pane probe/driver (design/slice-P7.20-cut.md §5 W4)", () => {
  // Skills is a GLOBAL (app-level) probe/driver — no `:tabId` guard family
  // (same posture as the MCP pane block above; unlike ctxPopover/agentCard,
  // which are per-tab). Every non-Skills DI slot below is a minimal inert
  // fake — required only because `createAutomationFacade`'s signature is
  // fixed-arity, never exercised by these tests.
  const noTranscriptDom4: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom4: TodoPanelDom = { panel: () => null };
  const noStartScreenDom4: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom4: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };
  const inertSettingsDom4: SettingsDom = {
    mounted: () => false,
    activePane: () => null,
    panesVisible: () => [],
    searchQuery: () => "",
    clickSidebarSettings: vi.fn(),
    clickBackToApp: vi.fn(),
    clickPaneTab: vi.fn(() => false),
    fillPermissionTool: vi.fn(() => false),
    fillPermissionPattern: vi.fn(),
    permissionToolInputValue: () => "",
    canSubmitPermissionAdd: () => false,
    clickPermissionAdd: vi.fn(),
    clickPermissionRemove: vi.fn(() => false),
    permissionRemoveRowExists: () => false,
  };
  const inertCtxPopoverDom4: CtxPopoverDom = {
    mounted: () => false,
    open: () => false,
    clickTrigger: vi.fn(),
    percentText: () => null,
    headline: () => null,
    rows: () => [],
    sessionLineVisible: () => false,
  };
  const inertAgentCardDom4: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
  const inertMcpPaneDom4: McpPaneDom = {
    mounted: () => false,
    rows: () => [],
    rowEnabled: () => undefined,
    clickRowToggle: () => false,
    problemCount: () => 0,
    importOpen: () => false,
    importScanLoaded: () => false,
    importCandidates: () => [],
    consentChecked: () => false,
    setCandidateChecked: () => false,
    setConsentChecked: vi.fn(),
    clickImportButton: vi.fn(),
    clickApplyButton: () => false,
    importResultsSignature: () => "",
  };

  /** A bare zustand settings store with no snapshot — the Skills facade methods never read it, but `createAutomationFacade`'s signature requires one. */
  function emptySettingsStore4() {
    const store = createSettingsStore();
    store.setState({ snapshot: null });
    return store;
  }

  /** Builds a facade wired ONLY for the Skills methods — the tab/registry/settings plumbing is present (required by the fixed-arity signature) but never exercised by these tests. */
  function buildFacade(dom: SkillsPaneDom) {
    const tabsStore: TabsStoreApi = createTabsStore();
    const registry: TabRegistry = createTabRegistry(tabsStore);
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom4,
      noTodoPanelDom4,
      noStartScreenDom4,
      noModelPillDom4,
      emptySettingsStore4(),
      inertSettingsDom4,
      inertCtxPopoverDom4,
      inertAgentCardDom4,
      inertMcpPaneDom4,
      dom,
    );
  }

  function skillRow(overrides: Partial<SkillsPaneRowState> = {}): SkillsPaneRowState {
    return { name: "alpha", sourceKind: "project", enabled: true, hasToggle: true, ...overrides };
  }

  function skillCandidate(overrides: Partial<SkillsPaneImportCandidateState> = {}): SkillsPaneImportCandidateState {
    return {
      id: "claude /home/x/.claude/skills imported-one",
      harness: "claude",
      name: "imported-one",
      checked: false,
      needsConversion: false,
      alreadyPresent: false,
      ...overrides,
    };
  }

  /** A fully-controllable fake `SkillsPaneDom` (same discipline as `fakeCtxPopoverDom`): read probes are frozen at construction via `overrides`; every drive method is a spy so a test can assert exactly which real DOM action the facade would have fired. `rows`/`rowExists` derive from the SAME `overrides.rows` list a caller mutates in-place, so a test can flip a row's `enabled`/presence between the "before" read and the awaited "after" poll without rebuilding the fake. */
  function fakeSkillsPaneDom(
    overrides: Partial<{
      mounted: boolean;
      rows: SkillsPaneRowState[];
      problems: number;
      importOpen: boolean;
      importScanLoaded: boolean;
      importCandidates: SkillsPaneImportCandidateState[];
      clickRowToggleResult: boolean;
      clickRowDeleteResult: boolean;
      confirmDeleteVisible: boolean;
      clickRowConfirmDeleteResult: boolean;
      setCandidateCheckedResult: boolean;
      clickApplyButtonResult: boolean;
      importResultsSignature: string;
    }> = {},
  ): SkillsPaneDom {
    const rows = overrides.rows ?? [];
    return {
      mounted: () => overrides.mounted ?? true,
      rows: () => rows,
      rowEnabled: (name) => rows.find((r) => r.name === name)?.enabled,
      rowExists: (name) => rows.some((r) => r.name === name),
      clickRowToggle: vi.fn<(name: string) => boolean>(() => overrides.clickRowToggleResult ?? true),
      clickRowDelete: vi.fn<(name: string) => boolean>(() => overrides.clickRowDeleteResult ?? true),
      confirmDeleteVisible: () => overrides.confirmDeleteVisible ?? true,
      clickRowConfirmDelete: vi.fn<(name: string) => boolean>(() => overrides.clickRowConfirmDeleteResult ?? true),
      problemCount: () => overrides.problems ?? 0,
      importOpen: () => overrides.importOpen ?? false,
      importScanLoaded: () => overrides.importScanLoaded ?? true,
      importCandidates: () => overrides.importCandidates ?? [],
      setCandidateChecked: vi.fn<(id: string, checked: boolean) => boolean>(() => overrides.setCandidateCheckedResult ?? true),
      setImportScope: vi.fn<(scope: SkillScope) => void>(),
      clickImportButton: vi.fn<() => void>(),
      clickApplyButton: vi.fn<() => boolean>(() => overrides.clickApplyButtonResult ?? true),
      importResultsSignature: () => overrides.importResultsSignature ?? "",
    };
  }

  describe("skillsPaneState", () => {
    it("reports the closed shape (empty defaults) when the pane isn't mounted — never reads the other DOM probes", () => {
      const dom = fakeSkillsPaneDom({ mounted: false, rows: [skillRow()], problems: 3 });
      const facade = buildFacade(dom);
      expect(facade.skillsPaneState()).toEqual({ rows: [], problems: 0, importOpen: false, importCandidates: [] });
    });

    it("reads rows/problems straight off the DOM accessor when mounted, with importCandidates empty while the dialog is closed", () => {
      const rows = [skillRow({ name: "alpha" }), skillRow({ name: "broken-plugin", sourceKind: "plugin", hasToggle: false })];
      const dom = fakeSkillsPaneDom({ mounted: true, rows, problems: 1, importOpen: false, importCandidates: [skillCandidate()] });
      const facade = buildFacade(dom);
      expect(facade.skillsPaneState()).toEqual({ rows, problems: 1, importOpen: false, importCandidates: [] });
    });

    it("populates importCandidates only while the dialog is open", () => {
      const candidates = [skillCandidate({ id: "c1" }), skillCandidate({ id: "c2", alreadyPresent: true })];
      const dom = fakeSkillsPaneDom({ mounted: true, rows: [], problems: 0, importOpen: true, importCandidates: candidates });
      const facade = buildFacade(dom);
      expect(facade.skillsPaneState()).toEqual({ rows: [], problems: 0, importOpen: true, importCandidates: candidates });
    });
  });

  describe("skillsToggle", () => {
    it("refuses with pane_not_mounted, touching no DOM click", async () => {
      const dom = fakeSkillsPaneDom({ mounted: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsToggle("alpha")).resolves.toEqual({ ok: false, reason: "pane_not_mounted" });
      expect(dom.clickRowToggle).not.toHaveBeenCalled();
    });

    it("refuses with row_not_found when no row with this exact name is rendered", async () => {
      const dom = fakeSkillsPaneDom({ mounted: true, rows: [skillRow({ name: "alpha" })] });
      const facade = buildFacade(dom);
      await expect(facade.skillsToggle("missing")).resolves.toEqual({ ok: false, reason: "row_not_found" });
      expect(dom.clickRowToggle).not.toHaveBeenCalled();
    });

    it("refuses with not_toggleable for a read-only plugin row (no switch rendered at all)", async () => {
      const dom = fakeSkillsPaneDom({
        mounted: true,
        rows: [skillRow({ name: "plugin-skill", sourceKind: "plugin", hasToggle: false })],
        clickRowToggleResult: false,
      });
      const facade = buildFacade(dom);
      await expect(facade.skillsToggle("plugin-skill")).resolves.toEqual({ ok: false, reason: "not_toggleable" });
    });

    it("clicks the row's switch and succeeds once the row's enabled reading flips (a real React commit, not a synthetic poke)", async () => {
      const rows = [skillRow({ name: "alpha", enabled: true })];
      const clickRowToggle = vi.fn((name: string) => {
        const row = rows.find((r) => r.name === name);
        if (row) {
          // Models a real async main-IPC round-trip landing one tick later.
          setTimeout(() => {
            row.enabled = !row.enabled;
          }, 0);
        }
        return true;
      });
      const dom: SkillsPaneDom = { ...fakeSkillsPaneDom({ mounted: true, rows }), clickRowToggle };
      const facade = buildFacade(dom);
      await expect(facade.skillsToggle("alpha")).resolves.toEqual({ ok: true });
      expect(clickRowToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe("skillsDelete", () => {
    it("refuses with pane_not_mounted, touching no DOM click", async () => {
      const dom = fakeSkillsPaneDom({ mounted: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsDelete("alpha")).resolves.toEqual({ ok: false, reason: "pane_not_mounted" });
      expect(dom.clickRowDelete).not.toHaveBeenCalled();
    });

    it("refuses with row_not_found when no row with this exact name is rendered", async () => {
      const dom = fakeSkillsPaneDom({ mounted: true, rows: [] });
      const facade = buildFacade(dom);
      await expect(facade.skillsDelete("ghost")).resolves.toEqual({ ok: false, reason: "row_not_found" });
      expect(dom.clickRowDelete).not.toHaveBeenCalled();
    });

    it("refuses with not_deletable for a read-only plugin row (neither trash icon nor confirm row rendered)", async () => {
      const dom = fakeSkillsPaneDom({
        mounted: true,
        rows: [skillRow({ name: "plugin-skill", sourceKind: "plugin", hasToggle: false })],
        clickRowDeleteResult: false,
      });
      const facade = buildFacade(dom);
      await expect(facade.skillsDelete("plugin-skill")).resolves.toEqual({ ok: false, reason: "not_deletable" });
    });

    it("refuses with confirm_not_shown when the inline confirm row never appears after the trash-icon click, bounded by the commit-poll deadline", async () => {
      const dom = fakeSkillsPaneDom({
        mounted: true,
        rows: [skillRow({ name: "alpha" })],
        clickRowDeleteResult: true,
        confirmDeleteVisible: false,
      });
      const facade = buildFacade(dom);
      const start = Date.now();
      await expect(facade.skillsDelete("alpha")).resolves.toEqual({ ok: false, reason: "confirm_not_shown" });
      expect(Date.now() - start).toBeGreaterThanOrEqual(450);
      expect(dom.clickRowConfirmDelete).not.toHaveBeenCalled();
    });

    it("drives BOTH real clicks (trash icon, then the confirm row's own Delete button) and succeeds once the row disappears", async () => {
      const rows = [skillRow({ name: "alpha" })];
      const clickRowConfirmDelete = vi.fn((name: string) => {
        const idx = rows.findIndex((r) => r.name === name);
        if (idx >= 0) {
          setTimeout(() => {
            rows.splice(idx, 1);
          }, 0);
        }
        return true;
      });
      const dom: SkillsPaneDom = {
        ...fakeSkillsPaneDom({ mounted: true, rows, clickRowDeleteResult: true, confirmDeleteVisible: true }),
        clickRowConfirmDelete,
      };
      const facade = buildFacade(dom);
      await expect(facade.skillsDelete("alpha")).resolves.toEqual({ ok: true });
      expect(dom.clickRowDelete).toHaveBeenCalledTimes(1);
      expect(clickRowConfirmDelete).toHaveBeenCalledTimes(1);
    });
  });

  describe("skillsImportOpen", () => {
    it("refuses with pane_not_mounted, touching no DOM click", async () => {
      const dom = fakeSkillsPaneDom({ mounted: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: false, reason: "pane_not_mounted" });
      expect(dom.clickImportButton).not.toHaveBeenCalled();
    });

    it("no-ops the open-click (dialog already open) and succeeds immediately once the scan already reads loaded", async () => {
      const dom = fakeSkillsPaneDom({ mounted: true, importOpen: true, importScanLoaded: true });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
      expect(dom.clickImportButton).not.toHaveBeenCalled();
    });

    it("clicks the header import button when closed, then waits for the scan to settle before returning ok", async () => {
      let open = false;
      let scanLoaded = false;
      const dom: SkillsPaneDom = {
        ...fakeSkillsPaneDom({ mounted: true }),
        importOpen: () => open,
        importScanLoaded: () => scanLoaded,
        clickImportButton: vi.fn(() => {
          setTimeout(() => {
            open = true;
            setTimeout(() => {
              scanLoaded = true;
            }, 0);
          }, 0);
        }),
      };
      const facade = buildFacade(dom);
      await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: true });
      expect(dom.clickImportButton).toHaveBeenCalledTimes(1);
    });

    it("refuses with did_not_open when the click never opens the dialog, bounded by the commit-poll deadline", async () => {
      const dom = fakeSkillsPaneDom({ mounted: true, importOpen: false });
      const facade = buildFacade(dom);
      const start = Date.now();
      await expect(facade.skillsImportOpen()).resolves.toEqual({ ok: false, reason: "did_not_open" });
      expect(Date.now() - start).toBeGreaterThanOrEqual(450);
      expect(dom.clickImportButton).toHaveBeenCalledTimes(1);
    });
  });

  describe("skillsImportApply", () => {
    it("refuses with dialog_not_open, touching no candidate/scope/apply state", async () => {
      const dom = fakeSkillsPaneDom({ importOpen: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "user" })).resolves.toEqual({ ok: false, reason: "dialog_not_open" });
      expect(dom.clickApplyButton).not.toHaveBeenCalled();
    });

    it("refuses with scan_not_loaded when the dialog is open but the scan hasn't resolved yet", async () => {
      const dom = fakeSkillsPaneDom({ importOpen: true, importScanLoaded: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "user" })).resolves.toEqual({ ok: false, reason: "scan_not_loaded" });
      expect(dom.clickApplyButton).not.toHaveBeenCalled();
    });

    it("refuses with candidate_not_found when a requested id isn't among the currently-listed candidates", async () => {
      const dom = fakeSkillsPaneDom({
        importOpen: true,
        importScanLoaded: true,
        importCandidates: [skillCandidate({ id: "c1" })],
        setCandidateCheckedResult: false,
      });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "user", ids: ["c1", "ghost"] })).resolves.toEqual({
        ok: false,
        reason: "candidate_not_found",
      });
    });

    it("selects EXACTLY the requested ids (every other candidate explicitly unchecked), sets scope, clicks Apply, and succeeds once the results signature changes", async () => {
      const candidates = [skillCandidate({ id: "c1" }), skillCandidate({ id: "c2", alreadyPresent: true })];
      let signature = "";
      const setCandidateChecked = vi.fn((_id: string, _checked: boolean) => true);
      const setImportScope = vi.fn();
      const clickApplyButton = vi.fn(() => {
        setTimeout(() => {
          signature = "c1: imported|c2: imported (renamed to avoid a conflict)";
        }, 0);
        return true;
      });
      const dom: SkillsPaneDom = {
        ...fakeSkillsPaneDom({ importOpen: true, importScanLoaded: true, importCandidates: candidates }),
        setCandidateChecked,
        setImportScope,
        clickApplyButton,
        importResultsSignature: () => signature,
      };
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "project", ids: ["c1", "c2"] })).resolves.toEqual({ ok: true });
      expect(setCandidateChecked).toHaveBeenCalledWith("c1", true);
      expect(setCandidateChecked).toHaveBeenCalledWith("c2", true);
      expect(setImportScope).toHaveBeenCalledWith("project");
      expect(clickApplyButton).toHaveBeenCalledTimes(1);
    });

    it("leaves the dialog's own current selection as-is when ids is omitted (no setCandidateChecked calls)", async () => {
      const candidates = [skillCandidate({ id: "c1", checked: true })];
      const setCandidateChecked = vi.fn(() => true);
      let signature = "";
      const clickApplyButton = vi.fn(() => {
        setTimeout(() => {
          signature = "c1: imported";
        }, 0);
        return true;
      });
      const dom: SkillsPaneDom = {
        ...fakeSkillsPaneDom({ importOpen: true, importScanLoaded: true, importCandidates: candidates }),
        setCandidateChecked,
        clickApplyButton,
        importResultsSignature: () => signature,
      };
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "user" })).resolves.toEqual({ ok: true });
      expect(setCandidateChecked).not.toHaveBeenCalled();
    });

    it("refuses with apply_disabled when the Apply button is currently disabled (nothing selected)", async () => {
      const dom = fakeSkillsPaneDom({ importOpen: true, importScanLoaded: true, clickApplyButtonResult: false });
      const facade = buildFacade(dom);
      await expect(facade.skillsImportApply({ scope: "user" })).resolves.toEqual({ ok: false, reason: "apply_disabled" });
    });
  });
});

describe("automation facade — Subagents pane probe/driver (design/slice-P7.21-cut.md §4 W4)", () => {
  // Subagents is a GLOBAL (app-level) probe/driver — no `:tabId` guard family
  // (same posture as the Skills pane block above). Every non-Subagents DI slot
  // below is a minimal inert fake — required only because
  // `createAutomationFacade`'s signature is fixed-arity, never exercised by
  // these tests.
  const noTranscriptDom5: TranscriptDom = { container: () => null, jumpButtonVisible: () => false };
  const noTodoPanelDom5: TodoPanelDom = { panel: () => null };
  const noStartScreenDom5: StartScreenDom = { rendered: () => false, recentCount: () => 0, projectMenuOpen: () => false, clickProjectChip: () => {} };
  const noModelPillDom5: ModelPillDom = {
    mounted: () => false,
    popoverOpen: () => false,
    currentPage: () => "root",
    manageDisabled: () => true,
    clickChip: vi.fn(),
    clickRootRow: vi.fn(),
    clickItemAt: vi.fn(),
  };
  const inertSettingsDom5: SettingsDom = {
    mounted: () => false,
    activePane: () => null,
    panesVisible: () => [],
    searchQuery: () => "",
    clickSidebarSettings: vi.fn(),
    clickBackToApp: vi.fn(),
    clickPaneTab: vi.fn(() => false),
    fillPermissionTool: vi.fn(() => false),
    fillPermissionPattern: vi.fn(),
    permissionToolInputValue: () => "",
    canSubmitPermissionAdd: () => false,
    clickPermissionAdd: vi.fn(),
    clickPermissionRemove: vi.fn(() => false),
    permissionRemoveRowExists: () => false,
  };
  const inertCtxPopoverDom5: CtxPopoverDom = {
    mounted: () => false,
    open: () => false,
    clickTrigger: vi.fn(),
    percentText: () => null,
    headline: () => null,
    rows: () => [],
    sessionLineVisible: () => false,
  };
  const inertAgentCardDom5: AgentCardDom = { state: () => null, clickToggle: vi.fn(() => false) };
  const inertMcpPaneDom5: McpPaneDom = {
    mounted: () => false,
    rows: () => [],
    rowEnabled: () => undefined,
    clickRowToggle: () => false,
    problemCount: () => 0,
    importOpen: () => false,
    importScanLoaded: () => false,
    importCandidates: () => [],
    consentChecked: () => false,
    setCandidateChecked: () => false,
    setConsentChecked: vi.fn(),
    clickImportButton: vi.fn(),
    clickApplyButton: () => false,
    importResultsSignature: () => "",
  };
  const inertSkillsPaneDom5: SkillsPaneDom = {
    mounted: () => false,
    rows: () => [],
    rowEnabled: () => undefined,
    rowExists: () => false,
    clickRowToggle: () => false,
    clickRowDelete: () => false,
    confirmDeleteVisible: () => false,
    clickRowConfirmDelete: () => false,
    problemCount: () => 0,
    importOpen: () => false,
    importScanLoaded: () => false,
    importCandidates: () => [],
    setCandidateChecked: () => false,
    setImportScope: vi.fn(),
    clickImportButton: vi.fn(),
    clickApplyButton: () => false,
    importResultsSignature: () => "",
  };

  /** A bare zustand settings store with no snapshot — the Subagents facade methods never read it, but `createAutomationFacade`'s signature requires one. */
  function emptySettingsStore5() {
    const store = createSettingsStore();
    store.setState({ snapshot: null });
    return store;
  }

  /** Builds a facade wired ONLY for the Subagents methods — the tab/registry/settings/skills plumbing is present (required by the fixed-arity signature) but never exercised by these tests. */
  function buildFacade(dom: SubagentsPaneDom) {
    const tabsStore: TabsStoreApi = createTabsStore();
    const registry: TabRegistry = createTabRegistry(tabsStore);
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      noTranscriptDom5,
      noTodoPanelDom5,
      noStartScreenDom5,
      noModelPillDom5,
      emptySettingsStore5(),
      inertSettingsDom5,
      inertCtxPopoverDom5,
      inertAgentCardDom5,
      inertMcpPaneDom5,
      inertSkillsPaneDom5,
      dom,
    );
  }

  function subagentRow(overrides: Partial<SubagentsPaneRowState> = {}): SubagentsPaneRowState {
    return { name: "researcher", sourceKind: "user", toolsBadge: "3 tools", description: "Researches things.", editable: true, ...overrides };
  }

  const blankEditor = {
    open: false,
    mode: null as "create" | "edit" | null,
    tab: null as "edit" | "preview" | null,
    name: "",
    description: "",
    tools: [] as string[],
    body: "",
    canSave: false,
    error: null as string | null,
    issues: [] as string[],
    previewLoading: false,
    previewSystemPrompt: null as string | null,
    previewEffectiveTools: null as string[] | null,
  };

  /** A fully-controllable fake `SubagentsPaneDom` (same discipline as `fakeSkillsPaneDom`): read probes are frozen at construction via `overrides`; every drive method is a spy so a test can assert exactly which real DOM action the facade would have fired. */
  function fakeSubagentsPaneDom(
    overrides: Partial<{
      mounted: boolean;
      rows: SubagentsPaneRowState[];
      problems: number;
      editorOpen: boolean;
      editorMode: "create" | "edit" | null;
      editorTab: "edit" | "preview" | null;
      fieldValues: { name: string; description: string; tools: string[]; body: string } | null;
      canSave: boolean;
      errorText: string | null;
      issues: string[];
      previewLoading: boolean;
      previewPromptText: string | null;
      previewToolsLine: string | null;
      clickRowEditResult: boolean;
      clickRowDeleteResult: boolean;
      confirmDeleteVisible: boolean;
      clickRowConfirmDeleteResult: boolean;
      clickSaveResult: boolean;
      clickEditTabResult: boolean;
      clickPreviewTabResult: boolean;
      setNameResult: boolean;
      setDescriptionResult: boolean;
      setBodyResult: boolean;
      setToolsResult: boolean;
    }> = {},
  ): SubagentsPaneDom {
    const rows = overrides.rows ?? [];
    return {
      mounted: () => overrides.mounted ?? true,
      rows: () => rows,
      rowExists: (name) => rows.some((r) => r.name === name),
      clickCreateButton: vi.fn<() => void>(),
      clickRowEdit: vi.fn<(name: string) => boolean>(() => overrides.clickRowEditResult ?? true),
      clickRowDelete: vi.fn<(name: string) => boolean>(() => overrides.clickRowDeleteResult ?? true),
      confirmDeleteVisible: () => overrides.confirmDeleteVisible ?? true,
      clickRowConfirmDelete: vi.fn<(name: string) => boolean>(() => overrides.clickRowConfirmDeleteResult ?? true),
      problemCount: () => overrides.problems ?? 0,
      editorOpen: () => overrides.editorOpen ?? false,
      editorMode: () => overrides.editorMode ?? null,
      editorTab: () => overrides.editorTab ?? null,
      clickEditTab: vi.fn<() => boolean>(() => overrides.clickEditTabResult ?? true),
      clickPreviewTab: vi.fn<() => boolean>(() => overrides.clickPreviewTabResult ?? true),
      fieldValues: () => overrides.fieldValues ?? null,
      setName: vi.fn<(value: string) => boolean>(() => overrides.setNameResult ?? true),
      setDescription: vi.fn<(value: string) => boolean>(() => overrides.setDescriptionResult ?? true),
      setBody: vi.fn<(value: string) => boolean>(() => overrides.setBodyResult ?? true),
      setTools: vi.fn<(tools: readonly string[]) => boolean>(() => overrides.setToolsResult ?? true),
      previewLoading: () => overrides.previewLoading ?? false,
      previewPromptText: () => overrides.previewPromptText ?? null,
      previewToolsLine: () => overrides.previewToolsLine ?? null,
      canSave: () => overrides.canSave ?? true,
      clickSave: vi.fn<() => boolean>(() => overrides.clickSaveResult ?? true),
      clickCancel: vi.fn<() => void>(),
      errorText: () => overrides.errorText ?? null,
      issues: () => overrides.issues ?? [],
    };
  }

  describe("subagentsPaneState", () => {
    it("reports the closed shape (empty defaults) when the pane isn't mounted — never reads the other DOM probes", () => {
      const dom = fakeSubagentsPaneDom({ mounted: false, rows: [subagentRow()], problems: 3 });
      const facade = buildFacade(dom);
      expect(facade.subagentsPaneState()).toEqual({ rows: [], problems: 0, editor: blankEditor });
    });

    it("reads rows/problems straight off the DOM accessor when mounted, with editor blank while the dialog is closed", () => {
      const rows = [subagentRow({ name: "researcher" }), subagentRow({ name: "general-purpose", sourceKind: "builtin", editable: false })];
      const dom = fakeSubagentsPaneDom({ mounted: true, rows, problems: 1, editorOpen: false });
      const facade = buildFacade(dom);
      expect(facade.subagentsPaneState()).toEqual({ rows, problems: 1, editor: blankEditor });
    });

    it("populates the editor fields/preview only while the dialog is open", () => {
      const dom = fakeSubagentsPaneDom({
        mounted: true,
        editorOpen: true,
        editorMode: "edit",
        editorTab: "preview",
        fieldValues: { name: "researcher", description: "Researches things.", tools: ["Read", "Grep"], body: "prompt body" },
        canSave: true,
        errorText: null,
        issues: [],
        previewLoading: false,
        previewPromptText: "You are researcher...",
        previewToolsLine: "Effective tools: Read, Grep",
      });
      const facade = buildFacade(dom);
      expect(facade.subagentsPaneState()).toEqual({
        rows: [],
        problems: 0,
        editor: {
          open: true,
          mode: "edit",
          tab: "preview",
          name: "researcher",
          description: "Researches things.",
          tools: ["Read", "Grep"],
          body: "prompt body",
          canSave: true,
          error: null,
          issues: [],
          previewLoading: false,
          previewSystemPrompt: "You are researcher...",
          previewEffectiveTools: ["Read", "Grep"],
        },
      });
    });

    it("parses a 'none' effective-tools caption to an empty array", () => {
      const dom = fakeSubagentsPaneDom({
        mounted: true,
        editorOpen: true,
        fieldValues: { name: "", description: "", tools: [], body: "" },
        previewPromptText: "prompt",
        previewToolsLine: "Effective tools: none",
      });
      const facade = buildFacade(dom);
      expect(facade.subagentsPaneState().editor.previewEffectiveTools).toEqual([]);
    });
  });

  describe("subagentsOpenEditor", () => {
    it("refuses with pane_not_mounted, touching no DOM click", async () => {
      const dom = fakeSubagentsPaneDom({ mounted: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor()).resolves.toEqual({ ok: false, reason: "pane_not_mounted" });
      expect(dom.clickCreateButton).not.toHaveBeenCalled();
    });

    it("refuses with already_open when the editor dialog is already mounted", async () => {
      const dom = fakeSubagentsPaneDom({ mounted: true, editorOpen: true });
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor()).resolves.toEqual({ ok: false, reason: "already_open" });
    });

    it("refuses with row_not_found when a name is given but no such row is rendered", async () => {
      const dom = fakeSubagentsPaneDom({ mounted: true, rows: [subagentRow({ name: "researcher" })] });
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor("missing")).resolves.toEqual({ ok: false, reason: "row_not_found" });
      expect(dom.clickRowEdit).not.toHaveBeenCalled();
    });

    it("refuses with not_editable for a read-only built-in/plugin row (no Edit button rendered at all)", async () => {
      const dom = fakeSubagentsPaneDom({
        mounted: true,
        rows: [subagentRow({ name: "general-purpose", sourceKind: "builtin", editable: false })],
        clickRowEditResult: false,
      });
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor("general-purpose")).resolves.toEqual({ ok: false, reason: "not_editable" });
    });

    it("clicks the header's Create button (no name given) and succeeds once the dialog mounts", async () => {
      let editorOpen = false;
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ mounted: true }),
        editorOpen: () => editorOpen,
        clickCreateButton: vi.fn(() => {
          editorOpen = true;
        }),
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor()).resolves.toEqual({ ok: true });
      expect(dom.clickCreateButton).toHaveBeenCalledTimes(1);
    });

    it("clicks the row's Edit button (a real async bridge.read() round-trip) and succeeds once the dialog mounts", async () => {
      let editorOpen = false;
      const rows = [subagentRow({ name: "researcher" })];
      const clickRowEdit = vi.fn((name: string) => {
        // Models the real `bridge.read()` IPC round-trip landing one tick later.
        setTimeout(() => {
          editorOpen = true;
        }, 0);
        return rows.some((r) => r.name === name);
      });
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ mounted: true, rows }),
        editorOpen: () => editorOpen,
        clickRowEdit,
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsOpenEditor("researcher")).resolves.toEqual({ ok: true });
      expect(clickRowEdit).toHaveBeenCalledWith("researcher");
    });
  });

  describe("subagentsEditorSet", () => {
    it("refuses with editor_not_open, touching no field setter", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSet({ name: "x" })).resolves.toEqual({ ok: false, reason: "editor_not_open" });
      expect(dom.setName).not.toHaveBeenCalled();
    });

    it("refuses with field_not_found when the name setter reports no such field rendered", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: true, setNameResult: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSet({ name: "summarizer" })).resolves.toEqual({ ok: false, reason: "field_not_found" });
    });

    it("sets name/description/body and only returns ok once each field's live value visibly reflects the request", async () => {
      const fields = { name: "", description: "", tools: [] as string[], body: "" };
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ editorOpen: true }),
        fieldValues: () => ({ ...fields }),
        setName: vi.fn((value: string) => {
          fields.name = value;
          return true;
        }),
        setDescription: vi.fn((value: string) => {
          fields.description = value;
          return true;
        }),
        setBody: vi.fn((value: string) => {
          fields.body = value;
          return true;
        }),
      };
      const facade = buildFacade(dom);
      await expect(
        facade.subagentsEditorSet({ name: "summarizer", description: "Summarizes code.", body: "You summarize code." }),
      ).resolves.toEqual({ ok: true });
      expect(fields).toEqual({ name: "summarizer", description: "Summarizes code.", tools: [], body: "You summarize code." });
    });

    it("sets tools and only returns ok once the selected set exactly matches the request (order-insensitive)", async () => {
      const fields = { name: "", description: "", tools: [] as string[], body: "" };
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ editorOpen: true }),
        fieldValues: () => ({ ...fields }),
        setTools: vi.fn((tools: readonly string[]) => {
          fields.tools = [...tools];
          return true;
        }),
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSet({ tools: ["Grep", "Read"] })).resolves.toEqual({ ok: true });
      expect(fields.tools).toEqual(["Grep", "Read"]);
    });

    it("refuses with set_failed when the field never visibly updates within the deadline", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: true, fieldValues: { name: "stale", description: "", tools: [], body: "" } });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSet({ name: "summarizer" })).resolves.toEqual({ ok: false, reason: "set_failed" });
    });
  });

  describe("subagentsEditorPreview", () => {
    it("refuses with editor_not_open", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorPreview()).resolves.toEqual({ ok: false, reason: "editor_not_open" });
    });

    it("clicks the Preview tab when not already selected, waits for loading to settle, and returns the real builder's output", async () => {
      // `editorTab` flips to "preview" in the SAME commit as `previewLoading`
      // flipping true (both are set synchronously before the real preview()
      // round-trip in the component) -- only the round-trip's completion is
      // delayed, mirroring the real click -> setEditorTab+setPreviewLoading(true)
      // -> await bridge.preview() -> setPreviewLoading(false) sequence.
      let editorTab: "edit" | "preview" = "edit";
      let loading = true;
      const clickPreviewTab = vi.fn(() => {
        editorTab = "preview";
        setTimeout(() => {
          loading = false;
        }, 0);
        return true;
      });
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ editorOpen: true, editorTab: "edit" }),
        editorTab: () => editorTab,
        clickPreviewTab,
        previewLoading: () => loading,
        previewPromptText: () => "You are summarizer...",
        previewToolsLine: () => "Effective tools: Read, Grep",
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorPreview()).resolves.toEqual({
        ok: true,
        systemPrompt: "You are summarizer...",
        effectiveTools: ["Read", "Grep"],
      });
      expect(clickPreviewTab).toHaveBeenCalledTimes(1);
    });

    it("regression (P7.21 live smoke step 4): does not settle on the vacuous pre-commit window where the tab hasn't switched yet", async () => {
      // Reproduces the REAL race hit by the live subagents-ui-smoke.mjs step 4:
      // a programmatic `.click()` on the Preview tab does not flush its React
      // commit synchronously, so right after `clickPreviewTab()` returns,
      // `editorTab()` still reads "edit" and the `.subagents-preview-pane`
      // loading marker doesn't exist yet -- `previewLoading()` reads `false`
      // (vacuously, "not loading" is indistinguishable from "hasn't started").
      // The buggy predicate `!previewLoading()` alone reads true on that very
      // first synchronous check and returns `settled` before the preview ever
      // starts, reporting `preview_unavailable` even though the real prompt
      // arrives moments later. Gating on `editorTab() === "preview"` too closes
      // that window: `editorTab` and `previewLoading` only flip together
      // (matching the component's synchronous setEditorTab+setPreviewLoading
      // pair), so "not on preview yet" can never be misread as "settled".
      let editorTab: "edit" | "preview" = "edit";
      let loading = false;
      let prompt: string | null = null;

      const clickPreviewTab = vi.fn(() => {
        setTimeout(() => {
          editorTab = "preview";
          loading = true;
          setTimeout(() => {
            loading = false;
            prompt = "You are a subagent...";
          }, 0);
        }, 0);
        return true;
      });

      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ editorOpen: true, editorTab: "edit" }),
        editorTab: () => editorTab,
        clickPreviewTab,
        previewLoading: () => loading,
        previewPromptText: () => prompt,
        previewToolsLine: () => (prompt !== null ? "Effective tools: Read" : null),
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorPreview()).resolves.toEqual({
        ok: true,
        systemPrompt: "You are a subagent...",
        effectiveTools: ["Read"],
      });
    });

    it("does not re-click the tab when already on preview", async () => {
      const dom = fakeSubagentsPaneDom({
        editorOpen: true,
        editorTab: "preview",
        previewLoading: false,
        previewPromptText: "cached prompt",
        previewToolsLine: "Effective tools: none",
      });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorPreview()).resolves.toEqual({ ok: true, systemPrompt: "cached prompt", effectiveTools: [] });
      expect(dom.clickPreviewTab).not.toHaveBeenCalled();
    });

    it("refuses with preview_unavailable when the settled result never rendered a prompt", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: true, editorTab: "preview", previewLoading: false, previewPromptText: null });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorPreview()).resolves.toEqual({ ok: false, reason: "preview_unavailable" });
    });
  });

  describe("subagentsEditorSave", () => {
    it("refuses with editor_not_open", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSave()).resolves.toEqual({ ok: false, reason: "editor_not_open" });
    });

    it("refuses with cannot_save when the Save button is disabled", async () => {
      const dom = fakeSubagentsPaneDom({ editorOpen: true, clickSaveResult: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSave()).resolves.toEqual({ ok: false, reason: "cannot_save" });
    });

    it("clicks Save and succeeds once the dialog closes (a real async bridge.save()/create() round-trip)", async () => {
      let open = true;
      const clickSave = vi.fn(() => {
        setTimeout(() => {
          open = false;
        }, 0);
        return true;
      });
      const dom: SubagentsPaneDom = { ...fakeSubagentsPaneDom({ editorOpen: true }), editorOpen: () => open, clickSave };
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSave()).resolves.toEqual({ ok: true });
    });

    it("carries the refusal message + issues when the dialog stays open with a rendered error", async () => {
      let errorText: string | null = null;
      const clickSave = vi.fn(() => {
        setTimeout(() => {
          errorText = "That name is reserved by a built-in subagent — choose another.";
        }, 0);
        return true;
      });
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ editorOpen: true, issues: ["name: reserved"] }),
        clickSave,
        errorText: () => errorText,
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsEditorSave()).resolves.toEqual({
        ok: false,
        reason: "That name is reserved by a built-in subagent — choose another.",
        issues: ["name: reserved"],
      });
    });
  });

  describe("subagentsDelete", () => {
    it("refuses with pane_not_mounted, touching no DOM click", async () => {
      const dom = fakeSubagentsPaneDom({ mounted: false });
      const facade = buildFacade(dom);
      await expect(facade.subagentsDelete("summarizer")).resolves.toEqual({ ok: false, reason: "pane_not_mounted" });
      expect(dom.clickRowDelete).not.toHaveBeenCalled();
    });

    it("refuses with row_not_found when no row with this exact name is rendered", async () => {
      const dom = fakeSubagentsPaneDom({ mounted: true, rows: [] });
      const facade = buildFacade(dom);
      await expect(facade.subagentsDelete("missing")).resolves.toEqual({ ok: false, reason: "row_not_found" });
      expect(dom.clickRowDelete).not.toHaveBeenCalled();
    });

    it("refuses with not_deletable for a read-only built-in/plugin row (no trash icon rendered at all)", async () => {
      const dom = fakeSubagentsPaneDom({
        mounted: true,
        rows: [subagentRow({ name: "general-purpose", sourceKind: "builtin", editable: false })],
        clickRowDeleteResult: false,
      });
      const facade = buildFacade(dom);
      await expect(facade.subagentsDelete("general-purpose")).resolves.toEqual({ ok: false, reason: "not_deletable" });
    });

    it("clicks trash then confirm and succeeds once the row disappears (a real async bridge.delete() round-trip)", async () => {
      const rows = [subagentRow({ name: "summarizer" })];
      const dom: SubagentsPaneDom = {
        ...fakeSubagentsPaneDom({ mounted: true, rows, confirmDeleteVisible: true }),
        rowExists: (name: string) => rows.some((r) => r.name === name),
        clickRowConfirmDelete: vi.fn((name: string) => {
          setTimeout(() => {
            rows.splice(
              rows.findIndex((r) => r.name === name),
              1,
            );
          }, 0);
          return true;
        }),
      };
      const facade = buildFacade(dom);
      await expect(facade.subagentsDelete("summarizer")).resolves.toEqual({ ok: true });
    });
  });
});

describe("automation facade — LSP / Hooks panel probes/drivers (design/slice-P7.25-cut.md §3 W3)", () => {
  /** Builds a facade wired ONLY for the LSP/Hooks panel methods — every other DOM/store slot keeps its own real default (never exercised by these tests). */
  function buildFacade(registry: TabRegistry, tabsStore: TabsStoreApi, lspPanelDom?: LspPanelDom, hooksPanelDom?: HooksPanelDom) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lspPanelDom,
      hooksPanelDom,
    );
  }

  describe("lspPanelState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const lspPanelDom: LspPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, lspPanelDom);
      expect(facade.lspPanelState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("reports open:false with empty defaults when the panel isn't in the DOM (toggled closed)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const lspPanelDom: LspPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, lspPanelDom);
      expect(facade.lspPanelState(tabId)).toEqual({ ok: true, open: false, counts: null, servers: [] });
    });

    it("reports open:true + spreads counts/servers when the panel is mounted", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const lspPanelDom: LspPanelDom = {
        panel: () => ({ counts: "1 ready · 1 crashed", servers: [{ name: "fake", state: "ready" }, { name: "other", state: "crashed" }] }),
        toggle: vi.fn(),
      };
      const facade = buildFacade(registry, tabsStore, lspPanelDom);
      expect(facade.lspPanelState(tabId)).toEqual({
        ok: true,
        open: true,
        counts: "1 ready · 1 crashed",
        servers: [
          { name: "fake", state: "ready" },
          { name: "other", state: "crashed" },
        ],
      });
    });
  });

  describe("lspPanelToggle", () => {
    it("refuses a tabId that isn't the active tab, touching no DOM click", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const lspPanelDom: LspPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, lspPanelDom);
      expect(facade.lspPanelToggle(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
      expect(lspPanelDom.toggle).not.toHaveBeenCalled();
    });

    it("clicks the real SessionHeader toggle button via lspPanelDom.toggle()", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const lspPanelDom: LspPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, lspPanelDom);
      expect(facade.lspPanelToggle(tabId)).toEqual({ ok: true });
      expect(lspPanelDom.toggle).toHaveBeenCalledTimes(1);
    });
  });

  describe("hooksPanelState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const hooksPanelDom: HooksPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("reports open:false with empty defaults when the panel isn't in the DOM (toggled closed)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const hooksPanelDom: HooksPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelState(tabId)).toEqual({ ok: true, open: false, configError: null, groups: [] });
    });

    it("reports open:true + spreads configError/groups when the panel is mounted", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const hooksPanelDom: HooksPanelDom = {
        panel: () => ({ configError: null, groups: [{ event: "PostToolUse", count: 2 }] }),
        toggle: vi.fn(),
      };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelState(tabId)).toEqual({
        ok: true,
        open: true,
        configError: null,
        groups: [{ event: "PostToolUse", count: 2 }],
      });
    });

    it("reports the configError alert text when the config is malformed", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const hooksPanelDom: HooksPanelDom = {
        panel: () => ({ configError: "Invalid hook config /ws/.anycode/config.json", groups: [] }),
        toggle: vi.fn(),
      };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelState(tabId)).toEqual({
        ok: true,
        open: true,
        configError: "Invalid hook config /ws/.anycode/config.json",
        groups: [],
      });
    });
  });

  describe("hooksPanelToggle", () => {
    it("refuses a tabId that isn't the active tab, touching no DOM click", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const hooksPanelDom: HooksPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelToggle(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
      expect(hooksPanelDom.toggle).not.toHaveBeenCalled();
    });

    it("clicks the real SessionHeader toggle button via hooksPanelDom.toggle()", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const hooksPanelDom: HooksPanelDom = { panel: () => null, toggle: vi.fn() };
      const facade = buildFacade(registry, tabsStore, undefined, hooksPanelDom);
      expect(facade.hooksPanelToggle(tabId)).toEqual({ ok: true });
      expect(hooksPanelDom.toggle).toHaveBeenCalledTimes(1);
    });
  });
});

function checkpointMeta(overrides: Partial<WireCheckpointMeta> = {}): WireCheckpointMeta {
  return { id: "cp-1", label: "Write file A", createdAt: 1000, reason: "auto", ...overrides };
}

describe("automation facade — checkpoint timeline / rewind probes+driver (design slice-P7.26-R2-ratification.md §1 W3)", () => {
  /** Builds a facade wired ONLY for the checkpoint/rewind methods — every other DOM/store slot keeps its own real default (never exercised by these tests). */
  function buildFacade(
    registry: TabRegistry,
    tabsStore: TabsStoreApi,
    checkpointPanelDom?: CheckpointPanelDom,
    transcriptBlockDom?: TranscriptBlockDom,
    dom?: TranscriptDom,
  ) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      dom,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      checkpointPanelDom,
      transcriptBlockDom,
    );
  }

  describe("checkpointPanelState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const checkpointPanelDom: CheckpointPanelDom = { panel: () => null, toggle: vi.fn(), refresh: vi.fn() };
      const facade = buildFacade(registry, tabsStore, checkpointPanelDom);
      await expect(facade.checkpointPanelState(tabId)).resolves.toEqual({ ok: false, reason: "tab_not_active" });
      expect(checkpointPanelDom.toggle).not.toHaveBeenCalled();
    });

    it("opens the closed panel (toggle, not refresh) and returns the rows once the list lands", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      let rows: { items: Array<{ id: string; label: string; age: string; reason: string }> } | null = null;
      const checkpointPanelDom: CheckpointPanelDom = {
        panel: () => rows,
        toggle: vi.fn(() => {
          rows = { items: [{ id: "cp-1", label: "Write file A", age: "2m", reason: "Auto" }] };
        }),
        refresh: vi.fn(),
      };
      const facade = buildFacade(registry, tabsStore, checkpointPanelDom);
      await expect(facade.checkpointPanelState(tabId)).resolves.toEqual({
        ok: true,
        visible: true,
        items: [{ id: "cp-1", label: "Write file A", age: "2m", reason: "Auto" }],
      });
      expect(checkpointPanelDom.toggle).toHaveBeenCalledTimes(1);
      expect(checkpointPanelDom.refresh).not.toHaveBeenCalled();
    });

    it("refreshes an already-open panel (refresh, not toggle) to force a fresh list", async () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      let rows: { items: Array<{ id: string; label: string; age: string; reason: string }> } = { items: [] };
      const checkpointPanelDom: CheckpointPanelDom = {
        panel: () => rows,
        toggle: vi.fn(),
        refresh: vi.fn(() => {
          rows = { items: [{ id: "cp-2", label: "Write file B", age: "0m", reason: "Auto" }] };
        }),
      };
      const facade = buildFacade(registry, tabsStore, checkpointPanelDom);
      await expect(facade.checkpointPanelState(tabId)).resolves.toEqual({
        ok: true,
        visible: true,
        items: [{ id: "cp-2", label: "Write file B", age: "0m", reason: "Auto" }],
      });
      expect(checkpointPanelDom.refresh).toHaveBeenCalledTimes(1);
      expect(checkpointPanelDom.toggle).not.toHaveBeenCalled();
    });
  });

  describe("rewindState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const facade = buildFacade(registry, tabsStore, undefined, undefined, { container: () => null, jumpButtonVisible: () => false });
      expect(facade.rewindState(tabId)).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("refuses when no transcript element is mounted (no_transcript)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = buildFacade(registry, tabsStore, undefined, undefined, { container: () => null, jumpButtonVisible: () => false });
      expect(facade.rewindState(tabId)).toEqual({ ok: false, reason: "no_transcript" });
    });

    it("reports lastResult:null + the live block count before any rewind_result has landed", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const transcriptDom: TranscriptDom = {
        container: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        jumpButtonVisible: () => false,
      };
      const transcriptBlockDom: TranscriptBlockDom = { count: () => 3 };
      const facade = buildFacade(registry, tabsStore, undefined, transcriptBlockDom, transcriptDom);
      expect(facade.rewindState(tabId)).toEqual({ ok: true, lastResult: null, transcriptBlockCount: 3 });
    });

    it("reports the last rewind_result's fields + the (now-shrunk) block count once one has landed", () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({
        type: "rewind_result",
        requestId: "r1",
        ok: true,
        conversationRestored: true,
        restoredPaths: 2,
        safetyCheckpointId: "cp-safety-1",
      });
      const transcriptDom: TranscriptDom = {
        container: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        jumpButtonVisible: () => false,
      };
      const transcriptBlockDom: TranscriptBlockDom = { count: () => 1 };
      const facade = buildFacade(registry, tabsStore, undefined, transcriptBlockDom, transcriptDom);
      expect(facade.rewindState(tabId)).toEqual({
        ok: true,
        lastResult: { ok: true, reason: null, conversationRestored: true, restoredPaths: 2, safetyId: "cp-safety-1" },
        transcriptBlockCount: 1,
      });
    });
  });

  describe("checkpointRewind", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active), sending nothing", async () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const facade = buildFacade(registry, tabsStore);
      await expect(facade.checkpointRewind(tabId, { scope: "both" })).resolves.toEqual({ ok: false, reason: "tab_not_active" });
      expect(port.sent).toEqual([{ type: "ui_ready" }]);
    });

    it("refuses with checkpoint_not_specified when neither checkpointId nor index is given", async () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const facade = buildFacade(registry, tabsStore);
      await expect(facade.checkpointRewind(tabId, { scope: "both" })).resolves.toEqual({ ok: false, reason: "checkpoint_not_specified" });
      expect(port.sent).toEqual([{ type: "ui_ready" }]);
    });

    it("refuses with checkpoint_not_found when index is out of range against the current list", async () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({ type: "checkpoint_list", checkpoints: [checkpointMeta()] });
      const facade = buildFacade(registry, tabsStore);
      await expect(facade.checkpointRewind(tabId, { index: 1, scope: "both" })).resolves.toEqual({
        ok: false,
        reason: "checkpoint_not_found",
      });
      expect(port.sent).toEqual([{ type: "ui_ready" }]);
    });

    it("resolves index 0 to the NEWEST checkpoint (newest-first order), sends the matching rewind_request, and returns rewindState once the reply lands", async () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      port.emit({
        type: "checkpoint_list",
        checkpoints: [checkpointMeta({ id: "older", createdAt: 1000 }), checkpointMeta({ id: "newer", createdAt: 2000 })],
      });
      const transcriptDom: TranscriptDom = {
        container: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        jumpButtonVisible: () => false,
      };
      const transcriptBlockDom: TranscriptBlockDom = { count: () => 0 };
      const facade = buildFacade(registry, tabsStore, undefined, transcriptBlockDom, transcriptDom);

      const resultPromise = facade.checkpointRewind(tabId, { index: 0, scope: "both" });
      // The facade generates+sends its own requestId synchronously before its
      // first `await` (waitUntil) — port.sent already carries it here. The
      // emitted rewind_result MUST carry that exact id (W3-FIX: correlation
      // by requestId, not "any change to the slot") for the settle poll to
      // ever resolve.
      const sentRequestId = (port.sent.at(-1) as { requestId: string }).requestId;
      // Simulate the host's async reply landing (a real round-trip: safety
      // checkpoint write + file restore, design §2.6) before the settle poll
      // exhausts its deadline.
      queueMicrotask(() =>
        port.emit({ type: "rewind_result", requestId: sentRequestId, ok: true, conversationRestored: true, restoredPaths: 0, safetyCheckpointId: "safety-1" }),
      );
      await expect(resultPromise).resolves.toEqual({
        ok: true,
        reason: null,
        lastResult: { ok: true, reason: null, conversationRestored: true, restoredPaths: 0, safetyId: "safety-1" },
        transcriptBlockCount: 0,
      });
      expect(port.sent).toEqual([
        { type: "ui_ready" },
        { type: "rewind_request", requestId: sentRequestId, checkpointId: "newer", scope: "both" },
      ]);
    });

    it("sends the exact checkpointId when given explicitly, ignoring the current list entirely", async () => {
      const { registry, tabsStore, tabId, port } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const transcriptDom: TranscriptDom = {
        container: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
        jumpButtonVisible: () => false,
      };
      const transcriptBlockDom: TranscriptBlockDom = { count: () => 0 };
      const facade = buildFacade(registry, tabsStore, undefined, transcriptBlockDom, transcriptDom);

      const resultPromise = facade.checkpointRewind(tabId, { checkpointId: "explicit-id", scope: "files" });
      const sentRequestId = (port.sent.at(-1) as { requestId: string }).requestId;
      queueMicrotask(() =>
        port.emit({ type: "rewind_result", requestId: sentRequestId, ok: false, reason: "checkpoint not found", conversationRestored: false, restoredPaths: null }),
      );
      // W3-FIX (codex #1): a rejected rewind must surface the HOST's real
      // ok:false/reason at the top level — the pre-fix facade returned a
      // false ok:true here (it merely proved the probe itself read fine).
      await expect(resultPromise).resolves.toEqual({
        ok: false,
        reason: "checkpoint not found",
        lastResult: { ok: false, reason: "checkpoint not found", conversationRestored: false, restoredPaths: null, safetyId: null },
        transcriptBlockCount: 0,
      });
      expect(port.sent).toEqual([
        { type: "ui_ready" },
        { type: "rewind_request", requestId: sentRequestId, checkpointId: "explicit-id", scope: "files" },
      ]);
    });
  });
});

describe("automation facade — tryAgainButtonState/tryAgainButtonClick (TASK.33 W8-FIX #2)", () => {
  /** Builds a facade wired ONLY for the try-again-button methods — every other DOM/store slot keeps its own real default (never exercised by these tests). */
  function buildFacade(registry: TabRegistry, tabsStore: TabsStoreApi, tryAgainButtonDom?: TryAgainButtonDom) {
    return createAutomationFacade(
      registry,
      tabsStore,
      stubBridge(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tryAgainButtonDom,
    );
  }

  describe("tryAgainButtonState", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => false) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonState(tabId, "loop_end:t1")).toEqual({ ok: false, reason: "tab_not_active" });
    });

    it("rejects an unknown tabId (unknown_tab)", () => {
      const tabsStore = createTabsStore();
      const registry = createTabRegistry(tabsStore);
      tabsStore.setState({ activeTabId: "ghost" });
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => false) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonState("ghost", "loop_end:t1")).toEqual({ ok: false, reason: "unknown_tab" });
    });

    it("reports the empty default shape (not an error) when the block isn't rendered yet", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => false) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonState(tabId, "loop_end:t1")).toEqual({
        ok: true,
        count: 0,
        visible: false,
        enabled: false,
      });
    });

    it("queries tryAgainButtonDom.state with the EXACT tabId + blockId requested", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const seen: Array<[string, string]> = [];
      const tryAgainButtonDom: TryAgainButtonDom = {
        state: (t, id) => {
          seen.push([t, id]);
          return null;
        },
        click: vi.fn(() => false),
      };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      facade.tryAgainButtonState(tabId, "loop_end:t42");
      expect(seen).toEqual([[tabId, "loop_end:t42"]]);
    });

    it("spreads a found button's count/visible/enabled verbatim — count>1 rides through uncollapsed, since more than one button is itself the defect this probe exists to catch", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const tryAgainButtonDom: TryAgainButtonDom = {
        state: () => ({ count: 2, visible: true, enabled: true }),
        click: vi.fn(() => false),
      };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonState(tabId, "loop_end:t1")).toEqual({
        ok: true,
        count: 2,
        visible: true,
        enabled: true,
      });
    });
  });

  describe("tryAgainButtonClick", () => {
    it("refuses a tabId that isn't the active tab (tab_not_active), touching no DOM click", () => {
      const { registry, tabsStore, tabId } = setupReadyTab("tab-a");
      registry.registerPort("tab-b", "/ws/b", asPort(new FakeMessagePort()));
      tabsStore.getState().setActiveTab("tab-b");
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => true) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonClick(tabId, "loop_end:t1")).toEqual({ ok: false, reason: "tab_not_active" });
      expect(tryAgainButtonDom.click).not.toHaveBeenCalled();
    });

    it("rejects an unknown tabId (unknown_tab), touching no DOM click", () => {
      const tabsStore = createTabsStore();
      const registry = createTabRegistry(tabsStore);
      tabsStore.setState({ activeTabId: "ghost" });
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => true) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonClick("ghost", "loop_end:t1")).toEqual({ ok: false, reason: "unknown_tab" });
      expect(tryAgainButtonDom.click).not.toHaveBeenCalled();
    });

    it("fires a REAL click via tryAgainButtonDom.click() with the exact tabId + blockId, returning {ok:true}", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const seen: Array<[string, string]> = [];
      const tryAgainButtonDom: TryAgainButtonDom = {
        state: () => null,
        click: (t, id) => {
          seen.push([t, id]);
          return true;
        },
      };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonClick(tabId, "loop_end:t42")).toEqual({ ok: true });
      expect(seen).toEqual([[tabId, "loop_end:t42"]]);
    });

    it("returns {ok:false, reason:'not_present'} when nothing was there to click (missing or ambiguous button)", () => {
      const { registry, tabsStore, tabId } = setupReadyTab();
      tabsStore.getState().setActiveTab(tabId);
      const tryAgainButtonDom: TryAgainButtonDom = { state: () => null, click: vi.fn(() => false) };
      const facade = buildFacade(registry, tabsStore, tryAgainButtonDom);
      expect(facade.tryAgainButtonClick(tabId, "loop_end:t1")).toEqual({ ok: false, reason: "not_present" });
    });
  });
});
