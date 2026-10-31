/**
 * GitHub #14 — behavioral wiring tests for the Composer's submit-time slash
 * interception. The repo's `TranscriptMinimap.harness.test.ts` pattern (node
 * environment, no DOM): `vi.mock("react")` with slot-backed
 * useState/useRef/useEffect/useLayoutEffect/useContext, effects drained by a
 * mount loop. `Composer` is invoked as a plain function and returns its
 * element tree with the REAL event props attached; the textarea/button props
 * are invoked directly and a re-mount reflects what a setter wrote.
 *
 * A separate file from Composer.test.ts on purpose: the vi.mock("react") must
 * be module-level (vitest hoists it), which would break that file's real-hook
 * pure-function tests. The tab/store/settings/tabs stores and every child
 * component are mocked so this harness only exercises Composer's own closures,
 * with `resolveBareSlashSubmit` and the paste helpers kept REAL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface HarnessState {
  state: Record<string, unknown[]>;
  refs: Record<string, Array<{ current: unknown }>>;
  effects: Record<string, Array<{ fn: () => unknown; deps?: readonly unknown[]; cleanup?: () => void }>>;
  callbacks: Record<string, Array<{ fn: unknown; deps?: readonly unknown[] }>>;
  pending: Array<() => unknown>;
  cursor: number;
  refCursor: number;
  effectCursor: number;
  callbackCursor: number;
  key: string;
  storeState: Record<string, unknown>;
  tabsState: { tabs: unknown[]; availableEngines: string[] };
  settingsState: {
    snapshot: { settings: { provider: { connections: unknown[]; activeConnectionId: string } } };
    setPatch: () => Promise<{ ok: true }>;
  };
  apiMethods: Record<string, ReturnType<typeof vi.fn>>;
  sendToHost: ReturnType<typeof vi.fn>;
  storeApi: { getState: () => Record<string, unknown> };
  tabContext: { tabId: string };
}

const harness = vi.hoisted((): HarnessState => ({
  state: {},
  refs: {},
  effects: {},
  callbacks: {},
  pending: [],
  cursor: 0,
  refCursor: 0,
  effectCursor: 0,
  callbackCursor: 0,
  key: "",
  storeState: {},
  tabsState: { tabs: [], availableEngines: ["claude", "codex"] },
  settingsState: {
    snapshot: { settings: { provider: { connections: [], activeConnectionId: "" } } },
    setPatch: () => Promise.resolve({ ok: true }),
  },
  apiMethods: {},
  sendToHost: vi.fn(),
  storeApi: { getState: () => ({}) },
  tabContext: { tabId: "tab-1" },
}));

/** React's dep comparison, near enough: same length and all Object.is-equal. */
function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false;
  }
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const slots = (harness.state[harness.key] ??= []);
      const slot = harness.cursor++;
      if (slots.length <= slot) {
        slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      const set = (next: unknown): void => {
        slots[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[slot]) : next;
      };
      return [slots[slot], set];
    },
    useRef(initial: unknown) {
      const slots = (harness.refs[harness.key] ??= []);
      const slot = harness.refCursor++;
      slots[slot] ??= { current: initial };
      return slots[slot];
    },
    useContext() {
      return harness.tabContext;
    },
    useEffect(fn: () => unknown, deps?: readonly unknown[]) {
      const slots = (harness.effects[harness.key] ??= []);
      const slot = harness.effectCursor++;
      const prev = slots[slot];
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return;
      }
      prev?.cleanup?.();
      slots[slot] = { fn, deps };
      harness.pending.push(fn);
    },
    useLayoutEffect(fn: () => unknown, deps?: readonly unknown[]) {
      const slots = (harness.effects[harness.key] ??= []);
      const slot = harness.effectCursor++;
      const prev = slots[slot];
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return;
      }
      prev?.cleanup?.();
      slots[slot] = { fn, deps };
      harness.pending.push(fn);
    },
    useCallback(fn: unknown, deps?: readonly unknown[]) {
      const slots = (harness.callbacks[harness.key] ??= []);
      const slot = harness.callbackCursor++;
      const prev = slots[slot] as { fn: unknown; deps?: readonly unknown[] } | undefined;
      if (prev !== undefined && sameDeps(prev.deps, deps)) {
        return prev.fn;
      }
      slots[slot] = { fn, deps };
      return fn;
    },
  };
});

// Store/tab/settings seams — the harness owns their state and spies.
vi.mock("../store.js", () => ({
  isSessionBusy: (status: string): boolean => status !== "idle",
}));

vi.mock("../tab-context.js", () => ({
  TabContext: { $$typeof: Symbol.for("react.context"), _currentValue: null },
  useTabStore(selector: (state: Record<string, unknown>) => unknown) {
    return selector(harness.storeState);
  },
  useTabSend() {
    return harness.sendToHost;
  },
  useTabStoreApi() {
    return harness.storeApi;
  },
}));

vi.mock("../settings-store.js", () => ({
  useSettingsStore: {
    getState: () => harness.settingsState,
  },
}));

vi.mock("../tabs-store.js", () => {
  const useTabsStore = (selector: (state: Record<string, unknown>) => unknown) => selector(harness.tabsState);
  (useTabsStore as unknown as { getState: () => Record<string, unknown> }).getState = () => harness.tabsState;
  return { useTabsStore };
});

// Child components: plain stubs — none are exercised, they only keep Composer's
// render tree importable. A test drives the real `selectSlashItem` closure
// through the SlashMenu ELEMENT's `onSelect` prop (see `findSlashMenu`), never
// by rendering the stub.
const NullComponent = (): null => null;

vi.mock("./ModeMenu.js", () => ({
  ModeMenu: NullComponent,
  modeChangeDisabled: (_turnStatus: string, ready: boolean): boolean => !ready,
}));

vi.mock("./ModelPill.js", () => ({
  ModelPill: NullComponent,
  modelPickDisabled: (
    turnStatus: string,
    queueInFlight: unknown,
    ready: boolean,
    midTurnChangeSupported = false,
  ): boolean => (!ready ? true : midTurnChangeSupported ? false : turnStatus !== "idle" || queueInFlight !== null),
}));

vi.mock("./EngineControls.js", () => ({
  EngineModelMenu: NullComponent,
  EnginePresetMenu: NullComponent,
  engineControlDisabled: (turnStatus: string, queueInFlight: unknown, ready: boolean): boolean =>
    (turnStatus !== "idle" || queueInFlight !== null) || !ready,
  // Native effort control: not what this harness exercises (the native menu is
  // a null component here) — present only so Composer's import resolves.
  nativeEffortControl: (): undefined => undefined,
}));

vi.mock("./EnvironmentMenu.js", () => ({ EnvironmentMenu: NullComponent }));
vi.mock("./BackgroundAgents.js", () => ({ BackgroundAgents: NullComponent }));
vi.mock("./PromptQueue.js", () => ({ PromptQueue: NullComponent }));
vi.mock("./RolePickerDialog.js", () => ({ RolePickerDialog: NullComponent }));
vi.mock("./icons.js", () => ({ ArrowUp: NullComponent, ImageIcon: NullComponent, Stop: NullComponent, X: NullComponent }));
vi.mock("./Sidebar.js", () => ({
  clampMenuLeft: (left: number, _width: number, viewport: number): number => Math.min(Math.max(left, 0), viewport - 6),
  formatAge: (): string => "",
}));
vi.mock("./SlashMenu.js", () => ({ SlashMenu: NullComponent }));

// Plain node has no `window`; the Composer reads window.anycode?.platform at
// render time and uses window.addEventListener/setTimeout in its effects.
vi.stubGlobal("window", {
  anycode: { platform: "darwin", skills: { list: () => Promise.resolve({ rows: [] }) } },
  dispatchEvent: (): boolean => true,
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
  setTimeout: (): number => 1,
  clearTimeout: (): void => {},
  innerWidth: 1200,
  innerHeight: 800,
});

const { Composer } = await vi.importActual<typeof import("./Composer.js")>("./Composer.js");

type AnyElement = { type: unknown; props: Record<string, unknown> };

function isElement(value: unknown): value is AnyElement {
  return typeof value === "object" && value !== null && "type" in value && "props" in value;
}

function walk(node: unknown, visit: (element: AnyElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit);
    }
    return;
  }
  if (!isElement(node)) {
    return;
  }
  visit(node);
  walk(node.props.children, visit);
}

function findTextarea(tree: unknown): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (element.type === "textarea") {
      found = element;
    }
  });
  return found;
}

function findByAria(tree: unknown, label: string): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (element.props["aria-label"] === label) {
      found = element;
    }
  });
  return found;
}

/**
 * The rendered `<SlashMenu items={…} selectedIndex={…} onSelect={…} …>` element.
 * Composer only emits it while `slashOpen`, so finding it also asserts the menu
 * really opened for this draft+caret. Its `onSelect` is the REAL
 * `selectSlashItem` closure imported from the actual module.
 */
function findSlashMenu(tree: unknown): AnyElement | undefined {
  let found: AnyElement | undefined;
  walk(tree, (element) => {
    if (Array.isArray(element.props.items) && typeof element.props.onSelect === "function") {
      found = element;
    }
  });
  return found;
}

function makeStoreState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turn: { status: "idle", turnId: null, requestId: null },
    queueInFlight: null,
    childSurface: false,
    mode: "plan",
    model: "claude-x",
    imageInput: undefined,
    imageFallback: undefined,
    connection: "ready",
    contextUsage: null,
    contextBreakdown: null,
    contextWindowAssumed: false,
    sessionTokens: null,
    usageAudit: { lastStep: null, totals: null, totalSteps: 0, list: null },
    quota: null,
    engine: null,
    pendingEngineChange: null,
    shell: null,
    steering: { supported: false },
    transcript: [],
    orchestrateActive: false,
    ...overrides,
  };
}

const CODEX_ENGINE = {
  id: "codex",
  capabilities: {
    supportsCorePermissions: false,
    supportsModelSelection: false,
    supportsImages: true,
    supportsContextUsage: true,
    supportsContextBreakdown: false,
    supportsManualCompact: false,
  },
  model: { current: "gpt-5.4", available: [], effort: undefined },
  permissions: { presets: [], activePresetId: "" },
};

function resetHarness(): void {
  harness.state = {};
  harness.refs = {};
  harness.effects = {};
  harness.callbacks = {};
  harness.pending = [];
  harness.storeState = makeStoreState();
  harness.tabsState = { tabs: [], availableEngines: ["claude", "codex"] };
  harness.settingsState = {
    snapshot: { settings: { provider: { connections: [], activeConnectionId: "" } } },
    setPatch: () => Promise.resolve({ ok: true }),
  };
  harness.apiMethods = {
    appendUserText: vi.fn(),
    recordSentMessage: vi.fn(),
    enqueuePrompt: vi.fn(),
    recordPendingSteer: vi.fn(),
    markUiSteer: vi.fn(),
    setNotice: vi.fn(),
    gitSetPanelOpen: vi.fn(),
  };
  harness.sendToHost = vi.fn();
  harness.storeApi = { getState: () => ({ ...harness.storeState, ...harness.apiMethods }) };
}

/** Seed Composer's ten useState slots: text(0), pasteBlocks(1), attachedImages(2), imageError(3), caret(4), … */
function seed(draft: string, caret: number, storeState?: Record<string, unknown>): void {
  harness.storeState = storeState ?? harness.storeState;
  harness.state["composer"] = [draft, [], [], null, caret, 0, false, [], false, null];
}

function mountComposer(): unknown {
  let tree: unknown = undefined;
  for (let pass = 0; pass < 10; pass++) {
    harness.key = "composer";
    harness.cursor = 0;
    harness.refCursor = 0;
    harness.effectCursor = 0;
    harness.callbackCursor = 0;
    harness.pending = [];
    tree = (Composer as unknown as () => unknown)();
    const pending = harness.pending;
    harness.pending = [];
    if (pending.length === 0) {
      break;
    }
    for (const fn of pending) {
      const cleanup = fn();
      const slots = harness.effects[harness.key];
      if (typeof cleanup === "function" && slots) {
        const slot = slots.find((s) => s.fn === fn);
        if (slot && slot.cleanup === undefined) {
          slot.cleanup = cleanup as () => void;
        }
      }
    }
  }
  return tree;
}

function keyDown(overrides: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}): {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean };
  preventDefault: ReturnType<typeof vi.fn>;
} {
  return {
    key: overrides.key ?? "Enter",
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
    preventDefault: vi.fn(),
  };
}

const BUSY_COMPACT_TEXT = "Cannot compact while this session is busy. Try again after this turn.";
const UNSUPPORTED_COMPACT_TEXT = "Manual compaction is not available in this session.";

describe("Composer slash-submit wiring (GitHub #14)", () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    for (const slot of harness.effects["composer"] ?? []) {
      slot.cleanup?.();
      slot.cleanup = undefined;
    }
  });

  it("Enter consumes a trailing-space /compact without any user, steer, or queue write", () => {
    seed("/compact ", 9);
    const tree = mountComposer();

    const event = keyDown();
    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.sendToHost).toHaveBeenCalledTimes(1);
    expect(harness.sendToHost).toHaveBeenCalledWith({ type: "compact_request" });
    expect(harness.apiMethods.appendUserText).not.toHaveBeenCalled();
    expect(harness.apiMethods.recordSentMessage).not.toHaveBeenCalled();
    expect(harness.apiMethods.enqueuePrompt).not.toHaveBeenCalled();
    expect(harness.apiMethods.recordPendingSteer).not.toHaveBeenCalled();
    expect(harness.state["composer"]?.[0]).toBe("");
  });

  it("Send consumes a trailing-space /compact without any user, steer, or queue write", () => {
    seed("/compact ", 9);
    const tree = mountComposer();

    (findByAria(tree, "Send")!.props.onClick as () => void)();

    expect(harness.sendToHost).toHaveBeenCalledTimes(1);
    expect(harness.sendToHost).toHaveBeenCalledWith({ type: "compact_request" });
    expect(harness.apiMethods.appendUserText).not.toHaveBeenCalled();
    expect(harness.apiMethods.recordSentMessage).not.toHaveBeenCalled();
    expect(harness.apiMethods.enqueuePrompt).not.toHaveBeenCalled();
    expect(harness.apiMethods.recordPendingSteer).not.toHaveBeenCalled();
    expect(harness.state["composer"]?.[0]).toBe("");
  });

  it("busy exact Enter bypasses the disabled menu row, retains the draft, and shows a notice", () => {
    seed("/compact", 8, makeStoreState({ turn: { status: "running", turnId: "t1", requestId: "r1" } }));
    const tree = mountComposer();

    const event = keyDown();
    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({
      kind: "slash_command_rejected",
      text: BUSY_COMPACT_TEXT,
    });
    expect(harness.sendToHost).not.toHaveBeenCalled();
    // The refusal retains the draft — it is not sent, queued, or cleared.
    expect(harness.state["composer"]?.[0]).toBe("/compact");
  });

  it("the explicit Codex steer button cannot leak a known bare command", () => {
    seed("/compact", 8, makeStoreState({ engine: CODEX_ENGINE, turn: { status: "running", turnId: "t1", requestId: "r1" } }));
    const tree = mountComposer();

    const steer = findByAria(tree, "Steer active Codex turn");
    expect(steer).toBeDefined();
    (steer!.props.onClick as () => void)();

    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({
      kind: "slash_command_rejected",
      text: UNSUPPORTED_COMPACT_TEXT,
    });
    expect(harness.sendToHost).not.toHaveBeenCalled();
    expect(harness.state["composer"]?.[0]).toBe("/compact");
  });

  it("IME composition Enter never submits", () => {
    seed("/compact ", 9);
    const tree = mountComposer();

    const event = keyDown({ isComposing: true });
    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.sendToHost).not.toHaveBeenCalled();
    expect(harness.apiMethods.setNotice).not.toHaveBeenCalled();
  });

  it("Shift+Enter on a bare command does not submit it", () => {
    seed("/compact ", 9);
    const tree = mountComposer();

    const event = keyDown({ shiftKey: true });
    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(event);

    expect(harness.sendToHost).not.toHaveBeenCalled();
    expect(harness.apiMethods.setNotice).not.toHaveBeenCalled();
    expect(harness.state["composer"]?.[0]).toBe("/compact ");
  });

  it("menu Compact rechecks availability before sending (child surface refuses, no compact_request)", () => {
    seed("/compact", 8, makeStoreState({ childSurface: true }));
    const tree = mountComposer();

    // The menu rendered (draft is an exact bare token), and its row select is
    // the real `selectSlashItem` closure -> dispatchSlashIntent(compact_now).
    const menu = findSlashMenu(tree);
    expect(menu).toBeDefined();
    (menu!.props.onSelect as (index: number) => void)(0);

    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({
      kind: "slash_command_rejected",
      text: UNSUPPORTED_COMPACT_TEXT,
    });
    expect(harness.sendToHost).not.toHaveBeenCalled();
    expect(harness.apiMethods.appendUserText).not.toHaveBeenCalled();
    expect(harness.state["composer"]?.[0]).toBe("/compact");
  });

  it.each(["idle", "running"])("%s button permits a command with images rejected by the model", (status) => {
    seed("/compact ", 9, makeStoreState({ imageInput: false, turn: { status, turnId: null, requestId: null } }));
    const image = { id: 1, name: "image.png", dataUrl: "data:image/png;base64,AA==" };
    harness.state["composer"]![2] = [image];
    const button = findByAria(mountComposer(), status === "idle" ? "Send" : "Queue message")!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({ kind: "slash_command_rejected", text: "Remove attachments before running a slash command." });
    expect(harness.state["composer"]?.[0]).toBe("/compact ");
    expect(harness.state["composer"]?.[2]).toEqual([image]);
    expect(harness.sendToHost).not.toHaveBeenCalled();
  });

  it("menu Compact retains draft and image when attachments prevent execution", () => {
    seed("/compact", 8);
    const image = { id: 1, name: "image.png", dataUrl: "data:image/png;base64,AA==" };
    harness.state["composer"]![2] = [image];
    const tree = mountComposer();
    (findSlashMenu(tree)!.props.onSelect as (index: number) => void)(0);
    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({ kind: "slash_command_rejected", text: "Remove attachments before running a slash command." });
    expect(harness.state["composer"]?.[0]).toBe("/compact");
    expect(harness.state["composer"]?.[2]).toEqual([image]);
    expect(harness.sendToHost).not.toHaveBeenCalled();
  });

  it("refuses compact while a drained queue item is in flight", () => {
    seed("/compact ", 9, makeStoreState({ queueInFlight: { id: "queued" } }));
    const tree = mountComposer();
    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(keyDown());
    expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({ kind: "slash_command_rejected", text: BUSY_COMPACT_TEXT });
    expect(harness.state["composer"]?.[0]).toBe("/compact ");
    expect(harness.sendToHost).not.toHaveBeenCalled();
    expect(harness.apiMethods.enqueuePrompt).not.toHaveBeenCalled();
  });

  // Audit C4: an unknown slash command must not become a model turn. The
  // draft is retained so the user can fix it, and nothing is appended, queued,
  // steered or sent.
  it.each(["/foo", "/help", "/compact/compact"])(
    "answers an unknown slash command locally: %s",
    (draft) => {
      seed(draft, draft.length);
      const tree = mountComposer();

      (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(keyDown());

      expect(harness.apiMethods.setNotice).toHaveBeenCalledWith({
        kind: "slash_command_rejected",
        text: `Unknown command: ${draft}. Type / to see the available commands.`,
      });
      expect(harness.sendToHost).not.toHaveBeenCalled();
      expect(harness.apiMethods.appendUserText).not.toHaveBeenCalled();
      expect(harness.apiMethods.recordSentMessage).not.toHaveBeenCalled();
      expect(harness.apiMethods.enqueuePrompt).not.toHaveBeenCalled();
      expect(harness.apiMethods.recordPendingSteer).not.toHaveBeenCalled();
      expect(harness.state["composer"]?.[0]).toBe(draft);
    },
  );

  it("still sends a path that merely starts with a slash", () => {
    seed("/usr/local/bin/node", 19);
    const tree = mountComposer();

    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(keyDown());

    expect(harness.apiMethods.setNotice).not.toHaveBeenCalled();
    expect(harness.apiMethods.appendUserText).toHaveBeenCalledWith(expect.any(String), "/usr/local/bin/node", undefined);
    expect(harness.sendToHost).toHaveBeenCalledTimes(1);
  });

  // The `/foo` and `/tmp` shapes are identical, so the guard asks the root
  // listing which names are real directories: a one-segment path like `/tmp`
  // or `/Users` is the user's message, not a mistyped command.
  it.each(["/tmp", "/etc", "/Users"])("still sends the root-level path %s instead of answering it", (draft) => {
    seed(draft, draft.length);
    const tree = mountComposer();

    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(keyDown());

    expect(harness.apiMethods.setNotice).not.toHaveBeenCalled();
    expect(harness.apiMethods.appendUserText).toHaveBeenCalledWith(expect.any(String), draft, undefined);
    expect(harness.sendToHost).toHaveBeenCalledTimes(1);
  });

  it("leaves slash text to a foreign engine's own surface", () => {
    seed("/clear", 6, makeStoreState({ engine: CODEX_ENGINE }));
    const tree = mountComposer();

    (findTextarea(tree)!.props.onKeyDown as (event: ReturnType<typeof keyDown>) => void)(keyDown());

    expect(harness.apiMethods.setNotice).not.toHaveBeenCalled();
    expect(harness.apiMethods.appendUserText).toHaveBeenCalledWith(expect.any(String), "/clear", undefined);
  });
});
