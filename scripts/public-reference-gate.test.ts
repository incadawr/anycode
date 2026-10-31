/**
 * Public-tree gate: no tracker card references in any tracked file.
 *
 * What counts as a reference: the tracker product name (optionally with a card
 * number and a letter suffix), and the card marker followed by `.`/`-`/space
 * and a number, an optional letter suffix and an optional `-F5`-style
 * sub-item. The marker may also be glued straight onto the number, which is how
 * card numbers leak into script names, log tags and directory names. Dotted
 * plan numbering written after the marker is covered too.
 *
 * The product name and the marker are assembled from fragments so this file
 * cannot match itself: the gate scans `git ls-files`, which includes this file.
 *
 * Exemptions are exact whole tokens, not shapes. A shape such as `task-<n>`
 * covers both an internal background-task id and a real card number, so each
 * entry names one file and one complete token, split around the marker
 * (`before` + MARK + `value`) so the table itself stays free of literal
 * references. Matching the whole token keeps an exemption narrow: allowing an
 * evidence directory does not allow a different path that starts the same way.
 *
 * Scanning covers file names as well as bodies: a card number in a path is the
 * same leak as a card number in a comment.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/** Tracker product name and card marker, split so this file cannot match itself. */
const PRODUCT = "tas" + "kana";
const MARK = "tas" + "k";

/**
 * Reference shapes:
 *   1. the product name, optionally followed by a card number (optional letter);
 *   2. dotted plan numbering after the marker;
 *   3. the marker with an optional `.`/`-`/space and a number, optional letter
 *      suffix and optional sub-item such as `-F5`.
 * Case variants are spelled out instead of using the `i` flag: with `i` the
 * `-[A-Z]` sub-item branch would swallow the first letter of a following word.
 */
const REF_SOURCE =
  "(?:" +
  "[Tt][Aa][Ss][Kk][Aa][Nn][Aa](?:[ ._:#-]*\\d+[a-z]?)?" +
  "|[Tt]ask\\s+\\d+(?:\\.\\d+)+" +
  "|[Tt][Aa][Ss][Kk][.\\- ]?\\d+[a-z]?(?:-[A-ZА-Я]\\d*|-[а-я]\\d+)?" +
  ")";

const newRef = () => new RegExp(REF_SOURCE, "g");

/** Characters that make up one identifier, path segment or log tag. */
const TOKEN_CHARS = /[A-Za-z0-9_./\\\u0400-\u04FF-]/;

type Entry = {
  /** Tracked path, exactly as `git ls-files` prints it. */
  path: string;
  /** Text before the marker inside the exempted token. */
  before?: string;
  /** Text after the marker; MARK + value is compared against the whole token. */
  value: string;
  /** Why this token is not a card reference. */
  note: string;
};

/**
 * Every exemption, by file and by complete token. Add one only for a token that
 * has been read and confirmed not to name a card; never widen an entry to a
 * shape or to a whole file.
 */
const ALLOW: Entry[] = [
  // ids of internal background tasks and throwaway worktrees used as test data or log values
  { path: "apps/desktop/scripts/detach-smoke.mjs", value: "145", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/model-picker-smoke.mjs", value: "106", note: "temporary-directory prefix of a dev smoke script" },
  { path: "apps/desktop/src/host/session.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/session.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/session.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/session.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/session.test.ts", before: "\\n", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/session.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/tasks-wire.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/tasks-wire.test.ts", value: "-999", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/host/tasks-wire.test.ts", before: "\\n", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/boot-tree.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/boot-tree.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/boot-tree.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/codex-rollout-fixtures/reasoning-nonempty-summary.jsonl", value: " 10", note: "plan numbering inside a captured engine payload, unchanged from the base commit" },
  { path: "apps/desktop/src/main/tab-ipc.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/tab-ipc.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/worktree-janitor.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/worktree-janitor.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/main/worktree-janitor.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/components/BackgroundTasksPanel.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/components/BackgroundTasksPanel.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/components/Sidebar.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/components/Sidebar.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/components/Sidebar.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "apps/desktop/src/shared/protocol.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "docs/development/agent-communication.md", value: "-42", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", value: "-3", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "/repo/.anycode/worktrees/", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "/repo/.anycode/worktrees/", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "/repo/.anycode/worktrees/", value: "-3", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "anycode-wt/", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "anycode-wt/", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "anycode-wt/", value: "-3", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.test.ts", before: "anycode/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/background-notice.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/background-notice.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/background-notice.test.ts", before: "\\n", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/commands.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/commands.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/commands.test.ts", value: "-9", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/cli/main.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/dispatcher.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", value: "-9", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", before: "/work/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", before: "/work/.anycode/worktrees/", value: "-9", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/dispatch/scheduler.test.ts", before: "anycode-wt/", value: "-9", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/loop/agent-loop.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/loop/agent-loop.test.ts", before: "/work/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/loop/agent-loop.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tasks/manager.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tasks/manager.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tasks/manager.test.ts", value: "-42", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tasks/manager.test.ts", value: "-999", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-background.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-background.test.ts", value: "-7", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-background.test.ts", value: "-9", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-kill.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-kill.test.ts", value: "-404", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-output.test.ts", value: "-1", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-output.test.ts", value: "-2", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/bash-output.test.ts", value: "-404", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/worktrees.test.ts", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/worktrees.test.ts", before: "/repo/.anycode/worktrees/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "packages/core/src/tools/worktrees.test.ts", before: "anycode-wt/", value: "-5", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },
  { path: "references/claude-code-2.1.212/W0-FINDINGS.md", value: ".3", note: "ids of internal background tasks and throwaway worktrees used as test data or log values" },

  // dotted plan / slice numbering carried by the prose, not a card number
  { path: ".github/workflows/release.yml", value: " 2.6.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.test.ts", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.test.ts", value: " 3.3.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.test.ts", value: " 3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.test.ts", value: " 3.7.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: " 1.9", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: " 3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: " 3.3.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: " 3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/index.ts", value: "-1.7", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/host/terminal.test.ts", value: " 2.4.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/main/codex-rollout-fixtures/reasoning-nonempty-summary.jsonl", value: " 10.7", note: "plan numbering inside a captured engine payload, unchanged from the base commit" },
  { path: "apps/desktop/src/main/tabs.ts", value: " 2.4.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/main/tabs.ts", value: " 2.4.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/App.tsx", value: " 2.1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/App.tsx", value: " 2.1.6", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/anycode-window.d.ts", value: " 2.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/anycode-window.d.ts", value: " 2.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/anycode-window.d.ts", value: " 2.1.6", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/app.css", value: " 3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/SessionPicker.test.ts", value: " 2.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/SessionPicker.tsx", value: " 2.1.6", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/SettingsScreen.tsx", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.test.ts", value: "-3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.test.ts", value: "-3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.tsx", value: " 3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/components/ToolCallCard.tsx", value: " 3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/port.ts", value: " 2.4.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/settings.css", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 1.9", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 2.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 2.1.6", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.test.ts", value: " 3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.ts", value: " 1.9", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.ts", value: " 2.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.ts", value: " 3.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.ts", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/store.ts", value: " 3.4.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/tab-registry.test.ts", value: " 2.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/tab-registry.test.ts", value: " 2.4.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/tabs-store.ts", value: " 2.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/renderer/src/terminal-view.test.ts", value: " 2.4.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/settings/files.ts", value: " 2.2.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/settings/schema.ts", value: " 2.2.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/envelopes.ts", value: " 2.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/protocol.ts", value: " 2.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/protocol.ts", value: " 3.2.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/settings.ts", value: " 2.2.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/tabs.ts", value: " 2.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/tabs.ts", value: " 2.1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/tabs.ts", value: " 2.1.6", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/tabs.ts", value: "-2.1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "apps/desktop/src/shared/terminal.ts", value: "-2.4.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.ts", value: " 1.7", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/adapters/node/sqlite-persistence.ts", value: " 1.9", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/args.ts", value: " 1.7", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/args.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/args.ts", value: " 4.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/commands.test.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/commands.test.ts", value: " 4.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/commands.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/commands.ts", value: " 4.1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/integration.test.ts", value: " 4.1.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.test.ts", value: " 3.1.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.test.ts", value: " 3.2.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.test.ts", value: " 3.3.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.ts", value: " 0.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.ts", value: " 1.7", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/main.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 3.1.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 3.2.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 3.4.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 4.1.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/render.ts", value: " 4.2.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/status.ts", value: " 4.2.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/status.ts", value: " 4.2.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/terminal-broker.ts", value: " 4.1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/theme.test.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/theme.test.ts", value: " 4.1.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/theme.ts", value: " 4.1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/cli/theme.ts", value: " 4.1.3", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/context/budget.test.ts", value: " 1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/context/history.test.ts", value: " 1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/context/manager.test.ts", value: " 1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/context/tokenizer.test.ts", value: " 1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/context/tokenizer.ts", value: " 1.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/dispatch/hook-runner.ts", value: " 0.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/dispatch/hook-runner.ts", value: " 1.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/extensions/bootstrap.test.ts", value: " 3.6.4", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/extensions/bootstrap.test.ts", value: " 3.7.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/index.ts", value: " 1.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/mcp/index.ts", value: " 3.2.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/mcp/tool-bridge.ts", value: " 3.2.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/mcp/transport-compat.ts", value: " 3.2.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/prompts/sections.ts", value: " 3.6.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/prompts/sections.ts", value: " 3.6.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/prompts/system.test.ts", value: " 3.6.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/skills/discovery.ts", before: "3.7/", value: " 3.3.5", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/skills/index.ts", value: " 3.3.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/tools/skill.ts", value: " 3.3.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/workflow/index.ts", value: " 3.4.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/workflow/index.ts", value: " 3.4.2", note: "dotted plan / slice numbering carried by the prose, not a card number" },
  { path: "packages/core/src/workflow/template.ts", value: " 3.4.1", note: "dotted plan / slice numbering carried by the prose, not a card number" },

  // fragments of paths, evidence directories and session names from the unpublished working tree
  { path: "apps/desktop/scripts/child-session-engine-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-engine-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S4/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-explicit-provider-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-explicit-provider-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S2/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-permission-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-permission-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S2/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-race-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-race-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S2/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-scenario-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-scenario-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S2/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-split-smoke.mjs", value: "102-track", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/child-session-split-smoke.mjs", before: "working-docs/", value: "102-track/evidence/S3/", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/detach-smoke.mjs", before: "evidence/", value: "145/detach-result.json", note: "evidence directory of a dev smoke script (unpublished working tree)" },
  { path: "apps/desktop/scripts/model-picker-smoke.mjs", before: "anycode-", value: "106-model-picker-evidence-", note: "temporary-directory prefix of a dev smoke script" },
  { path: "apps/desktop/scripts/model-picker-smoke.mjs", before: "anycode-", value: "106-model-picker-profile-", note: "temporary-directory prefix of a dev smoke script" },
  { path: "apps/desktop/scripts/model-picker-smoke.mjs", before: "anycode-", value: "106-model-picker-ws-", note: "temporary-directory prefix of a dev smoke script" },
  { path: "apps/desktop/src/main/codex-rollout-fixtures/agent-message-inter-agent.jsonl", before: "/Users/scrubbed/projects/tools/anycode/.anycode/worktrees/", value: "-5\\", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "apps/desktop/src/preload/index.ts", value: " 2.4.4.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "apps/desktop/src/shared/credentials.ts", value: " 2.5.1.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "apps/desktop/src/shared/protocol.test.ts", value: " 3.2.4.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "apps/desktop/src/shared/terminal.ts", value: " 2.4.1.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/cli/commands.test.ts", value: "-2\\n", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/cli/main.test.ts", before: "/", value: "-1\\s", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/context/history.test.ts", value: " 1.2.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/extensions/bootstrap.test.ts", value: "-3.3.2/3.3.3/3.3.4", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/skills/index.ts", value: " 3.3.2.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/tools/schemas.ts", value: "-1\\", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/tools/todo-read.ts", value: " 1.5.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/tools/todo-write.ts", value: " 1.5.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },
  { path: "packages/core/src/workflow/index.ts", value: " 3.4.3.", note: "fragments of paths, evidence directories and session names from the unpublished working tree" },

  // skill metadata value inside a captured skill file
  { path: "apps/desktop/src/main/skills-ipc.test.ts", value: "ana\\n---\\nnested", note: "captured skill-file body used as test input" },
  { path: "packages/core/src/skills/harness-skill-import.test.ts", value: "ana\\n", note: "captured skill-file body used as test input" },
];

/** The whole identifier around a match, so an exemption is never a prefix. */
function tokenAt(line: string, index: number, length: number): string {
  let start = index;
  let end = index + length;
  while (start > 0 && TOKEN_CHARS.test(line[start - 1])) start -= 1;
  while (end < line.length && TOKEN_CHARS.test(line[end])) end += 1;
  return line.slice(start, end);
}

function allowed(path: string, token: string): boolean {
  const lower = token.toLowerCase();
  return ALLOW.some(
    (e) =>
      e.path === path && ((e.before ?? "") + MARK + e.value).toLowerCase() === lower,
  );
}

/** Reference matches in one line, minus the exempted tokens. */
export function scanLine(path: string, line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(newRef())) {
    const token = tokenAt(line, m.index ?? 0, m[0].length);
    if (!allowed(path, token)) hits.push(`${path}: ${token}`);
  }
  return hits;
}

/** Scan a body and the path itself; returns `path: token` for each violation. */
export function scanText(path: string, text: string): string[] {
  const hits = scanLine(path, path);
  for (const line of text.split("\n")) hits.push(...scanLine(path, line));
  return hits;
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((rel) => existsSync(join(ROOT, rel)));
}

/** Every token in the tracked tree that the pattern matches, with its path. */
function tokensInTree(files: string[]): Array<{ path: string; token: string }> {
  const out: Array<{ path: string; token: string }> = [];
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const line of [rel, ...text.split("\n")]) {
      for (const m of line.matchAll(newRef())) {
        out.push({ path: rel, token: tokenAt(line, m.index ?? 0, m[0].length) });
      }
    }
  }
  return out;
}

describe("public tree carries no tracker card references", () => {
  it("finds none in any tracked file or file name", () => {
    const violations: string[] = [];
    for (const rel of tracked()) {
      violations.push(...scanText(rel, readFileSync(join(ROOT, rel), "utf8")));
    }
    expect(violations).toEqual([]);
  });

  it("keeps every exemption in use, so the table cannot rot", () => {
    const seen = new Set(
      tokensInTree(tracked()).map(({ path, token }) => `${path}\0${token.toLowerCase()}`),
    );
    const stale: string[] = [];
    for (const entry of ALLOW) {
      if (!existsSync(join(ROOT, entry.path))) {
        stale.push(`${entry.path}: file is gone`);
      } else if (
        !seen.has(
          `${entry.path}\0${((entry.before ?? "") + MARK + entry.value).toLowerCase()}`,
        )
      ) {
        stale.push(`${entry.path}: ${MARK + entry.value} no longer occurs`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("rejects every shape the gate exists for", () => {
    const card = MARK.toUpperCase() + ".123";
    const glued = MARK + "106-slice";
    expect(scanText("docs/x.md", `see ${PRODUCT} for details`)).not.toEqual([]);
    expect(scanText("docs/x.md", `moved to ${card} yesterday`)).not.toEqual([]);
    expect(scanText("docs/x.md", `${PRODUCT}-cli did it`)).not.toEqual([]);
    expect(scanText(".github/workflows/ci.yml", `pinned in ${PRODUCT} 4750a`)).not.toEqual([]);
    expect(scanText("sample.ts", `waiting on ${MARK}-123`)).not.toEqual([]);
    expect(scanText("AGENTS.md", `history lives in ${card}`)).not.toEqual([]);
    expect(scanText("sample.ts", `mkdtemp(join(tmp, "${PRODUCT}4294-"))`)).not.toEqual([]);
    expect(scanText("sample.ts", `// ${glued} notes`)).not.toEqual([]);
    expect(scanText("sample.ts", `// working-docs/${MARK}102-track/evidence`)).not.toEqual([]);
    expect(scanText(`scripts/${glued}.mjs`, "clean body")).not.toEqual([]);
    expect(scanText(`src/${card}.ts`, "clean body")).not.toEqual([]);
  });

  it("rejects the exact wording an earlier exemption used to cover", () => {
    // A `.each` title is out of reach for the AST gate that pinned this branch;
    // it is not out of reach here.
    expect(
      scanText(
        "apps/desktop/src/settings/schema.test.ts",
        `    "${PRODUCT} 4118: a corrupt modelCapabilities"`,
      ),
    ).not.toEqual([]);
  });

  it("accepts a token only when it is listed for that exact file", () => {
    const entry = ALLOW[0];
    const token = (entry.before ?? "") + MARK + entry.value;
    expect(scanText(entry.path, `// ${token} stays`)).toEqual([]);
    // the same token in another file is still a violation
    expect(scanText("docs/other.md", `// ${token} stays`)).not.toEqual([]);
    // nor does an exemption cover a longer token that starts the same way
    expect(scanText(entry.path, `// ${token}extended`)).not.toEqual([]);
  });
});
