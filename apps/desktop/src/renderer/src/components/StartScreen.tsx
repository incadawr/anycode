/**
 * "New Task" start screen (slice P7.12 §4.5 / intake F5#1a, extended by F5#1b
 * §2-D2/D3, restyled in slice-start-composer-cut): a composer-styled new-task
 * state — the SAME composer grammar the live-session composer uses
 * (`.composer` elevated card + borderless `.composer-textarea` +
 * `.composer-footer`), just without mounting `Composer.tsx` itself (that one
 * is bound to a live session via `TabContext`/`useTabSend`). A row of
 * environment chips (project popover) sits ABOVE the card (zcode/claude
 * desktop grammar). Renders in App.tsx's main-pane whenever `draftActive` is
 * true (App owns the precedence over the normal tab UI, §4.6) — this
 * component owns none of that gating itself, mirroring WelcomeScreen.tsx's
 * split of concerns.
 *
 * The project control (D2) merges the old standalone folder button + loose
 * recents strip into ONE popover: click opens a list of recent workspaces
 * (`deriveRecentWorkspaces`, limit 8) followed by a divider and a "Browse…"
 * row that fires the native dialog (`pickFolderForDraft`, reused verbatim).
 * The model chip (D3) is the footer-left control: a flat popover (grammar of
 * `model-list-claude-code.png`) built from ModelPill's own exported helpers
 * (`modelMenuItems`/`modelDisplayName`/`resolvePid`, imported — not
 * re-derived). Both popovers copy `ModeMenu.tsx`'s mechanics (roving focus
 * via its exported `nextRovingIndex`, outside-mousedown close, Esc close);
 * the start composer has no `overflow:hidden` ancestor, so plain absolute
 * positioning is used (the `ModelPill`/`Sidebar` fixed-position anchor dance
 * is only needed to escape such an ancestor).
 *
 * The textarea is store-controlled (`value={draft.prompt}`, write-through
 * `setDraftPrompt`) rather than local React state, so the automation facade
 * (W3) can drive/read the exact same state path a human types into — no
 * second source of truth to keep in sync.
 *
 * Submission always goes through `submitStartDraft()` (start-session.ts) with
 * its defaults (no second path, §4.3) — this component's only job is to
 * gate the Send button per §3-D3 and surface a `{ok:false}` refusal as a
 * toast via the injected `onToast`.
 *
 * The decision logic below (`computeSendDisabledReason`/`isSendKeydown`/
 * `deriveRecentWorkspaces`/`pickFolderForDraft`/`computeProjectLabel`/
 * `resolveProviderDefaultModel`/`computeModelChipDisplay`/`pickModelForDraft`)
 * is factored out as plain exported functions — this package's vitest config
 * runs `environment: "node"` (no jsdom, App.test.ts's precedent), so
 * StartScreen.test.ts exercises these directly rather than rendering the
 * component.
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTabsStore, type SessionDraft, type TabsStoreApi } from "../tabs-store.js";
import { useSettingsStore } from "../settings-store.js";
import { submitStartDraft, type StartSubmitResult } from "../start-session.js";
import { Folder, ArrowUp, BrandMark, Check, Chevron, Clipboard, Search, Terminal, Warning } from "./icons.js";
import { modelDisplayName, modelMenuItems, pillLabel, resolvePid } from "./ModelPill.js";
import { ModeMenu, nextRovingIndex } from "./ModeMenu.js";
import type { SessionSummary, WorkspacePickResult } from "../../../shared/tabs.js";
import type { EngineId } from "../../../shared/engines.js";
import type { ToastKind } from "../toasts.js";

export interface StartScreenProps {
  onToast(kind: ToastKind, text: string): void;
}

/** §2-D2: bumped from F5#1a's 5 now that recents live inside a popover rather than an always-visible strip. */
const RECENT_LIMIT = 8;
const PROJECT_HINT_DURATION_MS = 4_000;

/** A compact first-message starting point. Clicking one never starts a task; it only fills the draft. */
const STARTER_PRESETS = [
  { title: "Explore the codebase", prompt: "Explore this codebase and explain how it is structured.", icon: Search },
  { title: "Build a new feature", prompt: "Help me plan and implement a new feature: ", icon: Terminal },
  { title: "Review current changes", prompt: "Review the current changes and suggest improvements.", icon: Clipboard },
  { title: "Fix an issue", prompt: "Investigate and fix this issue: ", icon: Warning },
] as const;

/** Basename of a workspace path, tolerant of trailing slashes and both separators — same rule as Sidebar.tsx's private helper. */
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}

/**
 * §3-D4: dedupe `SessionSummary.workspace` by its max `updatedAt`, exclude
 * hidden workspaces, take the top `limit` by recency.
 */
export function deriveRecentWorkspaces(
  sessions: readonly SessionSummary[],
  hiddenWorkspaces: readonly string[],
  limit: number = RECENT_LIMIT,
): string[] {
  const latestByWorkspace = new Map<string, number>();
  for (const session of sessions) {
    if (hiddenWorkspaces.includes(session.workspace)) {
      continue;
    }
    const seen = latestByWorkspace.get(session.workspace);
    if (seen === undefined || session.updatedAt > seen) {
      latestByWorkspace.set(session.workspace, session.updatedAt);
    }
  }
  return [...latestByWorkspace.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([workspace]) => workspace);
}

/** §2-D2: the project control's label — the workspace's basename once one is chosen, else the prompt to pick one. Exported for unit testing. */
export function computeProjectLabel(workspace: string | null): string {
  return workspace !== null ? basename(workspace) : "Choose a project";
}

/** §3-D3: Send stays disabled until a project is chosen and the prompt is non-blank — mirrors Composer's `sendDisabledReason`. */
export function computeSendDisabledReason(draft: SessionDraft): string | undefined {
  if (draft.workspace === null) {
    return "Choose a project first";
  }
  if (draft.prompt.trim().length === 0) {
    return "Type a message to send";
  }
  return undefined;
}

/** Enter=send, Shift+Enter=newline — Composer.tsx parity (Composer.tsx:488-493). */
export function isSendKeydown(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === "Enter" && !event.shiftKey;
}

/** Starter cards preserve typed work by appending after it instead of replacing it. */
export function applyStarterPreset(current: string, preset: string): string {
  return current.length === 0 ? preset : current.endsWith("\n") ? current + preset : `${current}\n${preset}`;
}

export interface GuardedSubmitDeps {
  /** Whether §3-D3's folder/prompt gate currently allows a submit. */
  canSend: boolean;
  /**
   * A plain mutable latch (a `useRef`, not `useState`): two clicks/Enters
   * dispatched in the same tick both close over the same pre-update render,
   * so a `useState` flag alone can't stop the second one from slipping
   * through before React commits the re-render — the ref is checked and set
   * synchronously, before the first `await`.
   */
  guard: { current: boolean };
  /** Drives the Send button's `disabled` (React state, for the visible UI). */
  setSubmitting(value: boolean): void;
  submit(): Promise<StartSubmitResult>;
  onToast(kind: ToastKind, text: string): void;
}

/** Double-submit guard (codex review, P7.12 fix): a rapid double-click/double-Enter must create at most one session from a draft. */
export async function guardedSubmit(deps: GuardedSubmitDeps): Promise<void> {
  if (!deps.canSend || deps.guard.current) {
    return;
  }
  deps.guard.current = true;
  deps.setSubmitting(true);
  try {
    const result = await deps.submit();
    if (!result.ok) {
      deps.onToast("shell_error", result.message);
    }
  } finally {
    deps.guard.current = false;
    deps.setSubmitting(false);
  }
}

export interface FolderPickDeps {
  pickWorkspace(): Promise<WorkspacePickResult>;
  tabsStore: TabsStoreApi;
}

function defaultFolderPickDeps(): FolderPickDeps {
  return { pickWorkspace: () => window.anycode.pickWorkspace(), tabsStore: useTabsStore };
}

/** The project control's "Browse…" row (§2-D2): fires the native dialog, writes a non-cancelled pick onto the draft. */
export async function pickFolderForDraft(deps: FolderPickDeps = defaultFolderPickDeps()): Promise<void> {
  const result = await deps.pickWorkspace();
  if (result.workspace !== null) {
    deps.tabsStore.getState().setDraftWorkspace(result.workspace);
  }
}

/**
 * §3-D3: the resolved provider default the model chip falls back to when the
 * draft has no explicit pick — `defaults[pid]?.model ?? provider.model`,
 * the same resolution `main/host-env.ts`'s `buildHostEnv` and `ModelPill`'s
 * own ack-persist use. Exported for unit testing.
 */
export function resolveProviderDefaultModel(
  providerModel: string | undefined,
  providerDefaults: Record<string, { model?: string } | undefined> | undefined,
  pid: string,
): string {
  return providerDefaults?.[pid]?.model ?? providerModel ?? "";
}

export interface ModelChipDisplay {
  /** The model id the chip currently represents — the draft's explicit pick, else the resolved provider default. */
  modelId: string;
  /** Display label (`modelDisplayName`, reused from ModelPill). */
  label: string;
  /** True when showing the resolved default rather than an explicit draft pick (chip renders muted/"default" styled, §3-D3). */
  isDefault: boolean;
}

/** §3-D3: the model chip's display data. Exported for unit testing. */
export function computeModelChipDisplay(
  draftModel: string | null,
  resolvedDefault: string,
  catalogModels: readonly { id: string; name?: string }[] | undefined,
): ModelChipDisplay {
  const isDefault = draftModel === null;
  const modelId = draftModel ?? resolvedDefault;
  return { modelId, label: modelDisplayName(modelId, catalogModels), isDefault };
}

export interface ModelPickDeps {
  tabsStore: TabsStoreApi;
}

function defaultModelPickDeps(): ModelPickDeps {
  return { tabsStore: useTabsStore };
}

/**
 * A model-chip row's click handler (§3-D3): stores the explicit id the user
 * clicked. There is no dedicated "Default" affordance in v1's flat list (no
 * effort row, no manage row — just `modelMenuItems`), so every pick is
 * explicit; `null` (= "use the provider default") is reachable only via
 * `openDraft`/`discardDraft`'s initial state, never from a click. Exported
 * for unit testing.
 */
export function pickModelForDraft(modelId: string, deps: ModelPickDeps = defaultModelPickDeps()): void {
  deps.tabsStore.getState().setDraftModel(modelId);
}

/**
 * slice-start-composer-cut §5: preselect the last-used workspace once per
 * draft. Returns `recents[0]` ONLY when there IS a draft with no workspace
 * chosen yet AND at least one recent exists — `null` otherwise, so:
 * (a) an explicit user pick (`draft.workspace !== null`) is never overwritten;
 * (b) empty recents keep the "Choose a project first" gate (§3-D3);
 * (c) no draft at all is a no-op. Pure (no store writes); the effect below
 * owns the one-time `setDraftWorkspace` write. Exported for unit testing.
 */
export function seedWorkspaceFromRecents(
  draft: SessionDraft | null,
  recents: readonly string[],
): string | null {
  if (draft === null || draft.workspace !== null) {
    return null;
  }
  return recents[0] ?? null;
}

export function StartScreen({ onToast }: StartScreenProps) {
  const draft = useTabsStore((state) => state.draft);
  const hiddenWorkspaces = useTabsStore((state) => state.hiddenWorkspaces);
  const snapshot = useSettingsStore((state) => state.snapshot);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  // Core is always the local compatibility choice. Codex is appended only
  // after main returns its already-validated availability verdict.
  const [availableEngines, setAvailableEngines] = useState<readonly EngineId[]>(["core"]);
  const [submitting, setSubmitting] = useState(false);
  const submitGuardRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectHintVisible, setProjectHintVisible] = useState(true);
  const [projectHintHovered, setProjectHintHovered] = useState(false);
  const [projectFocusIndex, setProjectFocusIndex] = useState(0);
  const projectRootRef = useRef<HTMLDivElement>(null);
  const projectChipRef = useRef<HTMLButtonElement>(null);
  const projectItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFocusIndex, setModelFocusIndex] = useState(0);
  const modelRootRef = useRef<HTMLDivElement>(null);
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const modelItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Plain derived values (not hooks) — safe to compute ahead of the
  // `draft === null` early return below and reference from the effects'
  // dependency arrays, since none of them dereference `draft` unguarded
  // (`draft?.model ?? null`).
  const recents = deriveRecentWorkspaces(sessions, hiddenWorkspaces);
  const providerId = snapshot?.settings.provider.id;
  const pid = resolvePid(providerId);
  const catalogModels = snapshot?.catalog?.find((entry) => entry.id === providerId)?.models;
  const resolvedDefault = resolveProviderDefaultModel(snapshot?.settings.provider.model, snapshot?.settings.provider.defaults, pid);
  const modelChip = computeModelChipDisplay(draft?.model ?? null, resolvedDefault, catalogModels);
  // The active-session ModelPill includes the persisted effort in its label.
  // A brand-new draft has no host yet, so its honest equivalent is the
  // provider default; an explicit model pick deliberately shows only the
  // model because its capabilities have not been negotiated with a host.
  const defaultEffort = snapshot?.settings.provider.defaults?.[pid]?.reasoningEffort;
  const modelChipLabel = draft?.model === null && defaultEffort !== undefined
    ? pillLabel(modelChip.label, defaultEffort, ["off"])
    : modelChip.label;
  const modelItems = modelMenuItems(modelChip.modelId, catalogModels);
  const projectRowCount = recents.length + 1; // +1 for the trailing "Browse…" row

  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listSessions()
      .then((list) => {
        if (!cancelled) {
          setSessions(list);
        }
      })
      .catch((error: unknown) => {
        console.warn("[StartScreen] listSessions failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.anycode
      .listAvailableEngines()
      .then(({ engineIds }) => {
        if (!cancelled) setAvailableEngines(engineIds);
      })
      .catch((error: unknown) => {
        // Absence/failure is fail-closed for optional engines, while the
        // historical Core start flow remains available.
        console.warn("[StartScreen] listAvailableEngines failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // slice-start-composer-cut §5: preselect the last-used workspace once per
  // draft (StartScreen unmounts on discardDraft, so this ref resets per
  // draft). Only fires while `draft.workspace === null` — an explicit pick
  // (recents click / Browse dialog) flips workspace non-null and stops the
  // seed from ever overwriting it; empty recents leave the §3-D3 gate intact.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    const seed = seedWorkspaceFromRecents(draft, recents);
    if (seed !== null) {
      seededRef.current = true;
      useTabsStore.getState().setDraftWorkspace(seed);
    }
  }, [draft, recents]);

  // WelcomeScreen.tsx precedent (:47-49): the one actionable field on an
  // otherwise-empty screen gets the initial focus.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // The folder chip needs a brief orientation cue when this state opens, then
  // should behave like a normal hover/focus tooltip instead of staying noisy.
  useEffect(() => {
    const timeout = window.setTimeout(() => setProjectHintVisible(false), PROJECT_HINT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  // Outside mousedown closes the project popover (ModeMenu.tsx pattern);
  // clicking the model chip counts as "outside" here, so the two popovers
  // never end up open at once without any extra coordination.
  useEffect(() => {
    if (!projectMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (projectRootRef.current && !projectRootRef.current.contains(event.target as Node)) {
        setProjectMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [projectMenuOpen]);

  // Outside mousedown closes the model popover — same pattern, independent state.
  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    function onMouseDown(event: MouseEvent): void {
      if (modelRootRef.current && !modelRootRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [modelMenuOpen]);

  // Seed the project popover's roving focus at the current workspace (if it's
  // among the recents) whenever it opens, mirroring ModelPill's own seeding.
  useEffect(() => {
    if (!projectMenuOpen) {
      return;
    }
    const currentIndex = draft && draft.workspace !== null ? recents.indexOf(draft.workspace) : -1;
    setProjectFocusIndex(Math.max(0, currentIndex));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-seed on
    // an open transition (mirrors ModeMenu/ModelPill's narrow deps); recomputing
    // on every recents/draft tick would fight the user's roving-arrow input.
  }, [projectMenuOpen]);

  useEffect(() => {
    if (projectMenuOpen) {
      projectItemRefs.current[projectFocusIndex]?.focus();
    }
  }, [projectMenuOpen, projectFocusIndex]);

  // Seed the model popover's roving focus at the current pick whenever it opens.
  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    setModelFocusIndex(Math.max(0, modelItems.findIndex((item) => item.id === modelChip.modelId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same narrow-deps
    // discipline as the project popover's seeding effect above.
  }, [modelMenuOpen]);

  useEffect(() => {
    if (modelMenuOpen) {
      modelItemRefs.current[modelFocusIndex]?.focus();
    }
  }, [modelMenuOpen, modelFocusIndex]);

  if (draft === null) {
    return null;
  }

  const sendDisabledReason = submitting ? "Sending…" : computeSendDisabledReason(draft);
  const canSend = sendDisabledReason === undefined;
  const codexDraft = draft.engine === "codex";
  const showProjectHint = draft.workspace !== null && (projectHintVisible || projectHintHovered);

  async function submit(): Promise<void> {
    await guardedSubmit({
      canSend,
      guard: submitGuardRef,
      setSubmitting,
      submit: submitStartDraft,
      onToast,
    });
  }

  function closeProjectMenu(returnFocus: boolean): void {
    setProjectMenuOpen(false);
    if (returnFocus) {
      projectChipRef.current?.focus();
    }
  }

  function selectRecentProject(workspace: string): void {
    useTabsStore.getState().setDraftWorkspace(workspace);
    closeProjectMenu(true);
  }

  function selectBrowse(): void {
    // The native dialog is about to take focus regardless — no need to
    // return it to the chip first.
    setProjectMenuOpen(false);
    void pickFolderForDraft();
  }

  function onProjectChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setProjectMenuOpen(true);
    }
  }

  function onProjectMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setProjectFocusIndex((i) => nextRovingIndex(i, 1, projectRowCount));
        break;
      case "ArrowUp":
        event.preventDefault();
        setProjectFocusIndex((i) => nextRovingIndex(i, -1, projectRowCount));
        break;
      case "Home":
        event.preventDefault();
        setProjectFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setProjectFocusIndex(projectRowCount - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (projectFocusIndex < recents.length) {
          selectRecentProject(recents[projectFocusIndex]!);
        } else {
          selectBrowse();
        }
        break;
      case "Escape":
        event.preventDefault();
        closeProjectMenu(true);
        break;
      case "Tab":
        setProjectMenuOpen(false);
        break;
      default:
        break;
    }
  }

  function closeModelMenu(returnFocus: boolean): void {
    setModelMenuOpen(false);
    if (returnFocus) {
      modelChipRef.current?.focus();
    }
  }

  function selectModel(modelId: string): void {
    pickModelForDraft(modelId);
    closeModelMenu(true);
  }

  function onModelChipKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setModelMenuOpen(true);
    }
  }

  function onModelMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const count = modelItems.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setModelFocusIndex((i) => nextRovingIndex(i, 1, count));
        break;
      case "ArrowUp":
        event.preventDefault();
        setModelFocusIndex((i) => nextRovingIndex(i, -1, count));
        break;
      case "Home":
        event.preventDefault();
        setModelFocusIndex(0);
        break;
      case "End":
        event.preventDefault();
        setModelFocusIndex(count - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const item = modelItems[modelFocusIndex];
        if (item) {
          selectModel(item.id);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        closeModelMenu(true);
        break;
      case "Tab":
        setModelMenuOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <div className="start-screen">
      <div className="start-env-row">
        <div className="start-project" ref={projectRootRef}>
          {showProjectHint && (
            <div id="start-project-hint" className="start-project-hint" role="tooltip">
              Change the project for this task
            </div>
          )}
          <button
            ref={projectChipRef}
            type="button"
            className="start-folder"
            aria-haspopup="menu"
            aria-expanded={projectMenuOpen}
            aria-describedby={showProjectHint ? "start-project-hint" : undefined}
            onClick={() => setProjectMenuOpen((open) => !open)}
            onKeyDown={onProjectChipKeyDown}
            onMouseEnter={() => setProjectHintHovered(true)}
            onMouseLeave={() => setProjectHintHovered(false)}
            onFocus={() => setProjectHintHovered(true)}
            onBlur={() => setProjectHintHovered(false)}
          >
            <Folder />
            <span>{computeProjectLabel(draft.workspace)}</span>
          </button>

          {projectMenuOpen && (
            <div className="start-project-menu" role="menu" aria-label="Project" onKeyDown={onProjectMenuKeyDown}>
              {recents.length > 0 && (
                <ul className="start-recents">
                  {recents.map((workspace, index) => (
                    <li key={workspace}>
                      <button
                        ref={(el) => {
                          projectItemRefs.current[index] = el;
                        }}
                        type="button"
                        tabIndex={index === projectFocusIndex ? 0 : -1}
                        className="start-recent-item"
                        title={workspace}
                        onClick={() => selectRecentProject(workspace)}
                      >
                        {basename(workspace)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {recents.length > 0 && <div className="start-project-menu-divider" />}
              <button
                ref={(el) => {
                  projectItemRefs.current[recents.length] = el;
                }}
                type="button"
                tabIndex={recents.length === projectFocusIndex ? 0 : -1}
                className="start-project-menu-browse"
                onClick={() => selectBrowse()}
              >
                Browse…
              </button>
            </div>
          )}
        </div>
        {/* Design TASK.40 item 4: the selector is a choice of AGENT (which
            runtime drives the turn), not a product — labelled visibly so it
            no longer reads as a generic "Session engine" toggle. Group/pressed
            a11y semantics are unchanged; the visible label doubles as the
            group's accessible name via aria-labelledby. */}
        <div className="start-engine-switch" role="group" aria-labelledby="start-engine-switch-label">
          <span
            id="start-engine-switch-label"
            className="start-engine-switch-label"
            style={{ color: "var(--text-2)", fontSize: "var(--fs-sm)", marginRight: "var(--sp-1)", paddingLeft: "var(--sp-1)" }}
          >
            Agent
          </span>
          <button
            type="button"
            className={`start-engine-choice${draft.engine === "core" ? " start-engine-choice-selected" : ""}`}
            aria-pressed={draft.engine === "core"}
            onClick={() => useTabsStore.getState().setDraftEngine("core")}
          >
            AnyCode
          </button>
          {availableEngines.includes("codex") && (
            <button
              type="button"
              className={`start-engine-choice${codexDraft ? " start-engine-choice-selected" : ""}`}
              aria-pressed={codexDraft}
              onClick={() => useTabsStore.getState().setDraftEngine("codex")}
            >
              Codex
            </button>
          )}
        </div>
      </div>

      <div className="start-intro">
        <BrandMark className="start-brand-mark" />
        <h1>What should we build in AnyCode?</h1>
      </div>

      <div className="start-presets" aria-label="Task starters">
        {STARTER_PRESETS.map(({ title, prompt, icon: Icon }) => (
          <button
            key={title}
            type="button"
            className="start-preset"
            onClick={() => {
              useTabsStore.getState().setDraftPrompt(applyStarterPreset(draft.prompt, prompt));
              textareaRef.current?.focus();
            }}
          >
            <Icon className="start-preset-icon" />
            <span>{title}</span>
          </button>
        ))}
      </div>

      <div className="composer start-composer">
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          aria-label="First message"
          placeholder="What do you want to do?"
          value={draft.prompt}
          onChange={(event) => useTabsStore.getState().setDraftPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (isSendKeydown(event)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <div className="composer-footer-left">
            {codexDraft ? (
              <span className="engine-identity" title="Codex uses its native model and approval policy">Codex</span>
            ) : (
              <>
                <ModeMenu mode={draft.mode} disabled={false} onChange={(mode) => useTabsStore.getState().setDraftMode(mode)} />
                <div className="model-pill start-model" ref={modelRootRef}>
              <button
                ref={modelChipRef}
                type="button"
                className="model-pill-chip"
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                title={modelChipLabel}
                onClick={() => setModelMenuOpen((open) => !open)}
                onKeyDown={onModelChipKeyDown}
              >
                <span className="model-pill-label">{modelChipLabel}</span>
                <Chevron className="model-pill-chevron" />
              </button>

              {modelMenuOpen && (
                <div className="start-model-menu" role="menu" aria-label="Model" onKeyDown={onModelMenuKeyDown}>
                  {modelItems.map((item, index) => {
                    const current = item.id === modelChip.modelId;
                    return (
                      <button
                        key={item.id}
                        ref={(el) => {
                          modelItemRefs.current[index] = el;
                        }}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        tabIndex={index === modelFocusIndex ? 0 : -1}
                        className={`start-model-item${current ? " start-model-item-current" : ""}`}
                        onClick={() => selectModel(item.id)}
                      >
                        <span className="start-model-item-check" aria-hidden="true">
                          {current ? <Check /> : null}
                        </span>
                        <span className="start-model-item-name">{item.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
                </div>
              </>
            )}
          </div>
          <span className="composer-hint composer-hint-hidden" />
          <div className="composer-footer-right">
            <button
              type="button"
              className="composer-send"
              aria-label="Send"
              title={sendDisabledReason}
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <ArrowUp />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
