/**
 * Read-only COMPLETED child transcript view-state mapper (TASK.102 CUT-S2
 * §10.8.1 point 4, slice S2c C4): a pure projection from a
 * `CHILD_HISTORY_CHANNEL` response (main/tab-ipc.ts's `handleChildHistory`)
 * into exactly one of three view states App.tsx's read-only child branch
 * renders. No I/O, no DOM, no JSX — the channel call itself (main-authority
 * `isValidChildId` pre-flight + `getChildSession` relationship-authorization
 * + `loadHistory`) lives in main/tab-ipc.ts; this module only decides what
 * the RESULT of that call means for the screen.
 *
 * `ChildHistoryResult` mirrors main/tab-ipc.ts's export of the same name —
 * DUPLICATED on purpose, not imported: `apps/desktop/src/shared/**` is
 * frozen/out of this slice's fence (another job owns it in this worktree),
 * so the channel's small result envelope is kept in sync by contract, the
 * same "duplicated on purpose" convention as `ArtifactReadImageResult`
 * across main/artifacts-ipc.ts, preload/index.ts, and this renderer bundle.
 * `WireHistoryItem` itself is NOT duplicated — it is imported type-only from
 * `shared/protocol.ts` (reading `shared/**` types is unrestricted; only
 * EDITING that tree is out of fence), exactly like store.ts's own import.
 *
 * The three-state split is deliberate (§10.8.1 point 4's "smejnaya dyra а"):
 * a refused channel call (malformed id, or a legal durable card whose child
 * row never made it past the boot deadline — §2.6.4's 30s `child-ready`
 * timeout) must render an honest "unavailable" message, NEVER an exception,
 * an eternal spinner, or a bounce back to master. An authorized-but-empty
 * history (a cancelled child reaped before its first flush) is a SEPARATE,
 * equally honest "empty" state — not folded into "unavailable", because the
 * channel call itself succeeded and authorized this renderer to see the
 * (empty) transcript.
 */
import type { WireHistoryItem } from "../../shared/protocol.js";
import { projectHistoryToBlocks, type TranscriptBlock } from "./store.js";

/**
 * Mirrors main/tab-ipc.ts's `ChildHistoryResult` byte-for-byte (see module
 * doc comment for why this is a duplicate, not an import). `items` is
 * `readonly` here (this module never mutates it) even though the wire value
 * arriving over `ipcRenderer.invoke` is a plain array.
 */
export type ChildHistoryResult =
  | { ok: true; items: readonly WireHistoryItem[] }
  | { ok: false; reason: "invalid_id" | "not_found" };

/**
 * The three states App.tsx's read-only child branch can render. `blocks` is
 * the ordinary transcript projection (`projectHistoryToBlocks` — the SAME
 * function `SessionSurface`'s live/resume hydration already uses, so a child
 * card nested inside a child's own history renders through the identical
 * React/Markdown tract — XSS law, no HTML strings, no second renderer).
 */
export type ChildHistoryViewState =
  | { kind: "blocks"; blocks: TranscriptBlock[] }
  | { kind: "empty" }
  | { kind: "unavailable" };

/**
 * Maps one channel response to a view state. Pure and stateless — calling it
 * twice on the SAME `result` produces two structurally-equal but freshly
 * computed block arrays (never an accumulation over a previous call), which
 * is exactly the "flip live -> completed re-renders the projection FROM
 * ZERO, not appended onto the live transcript" invariant CUT-S1 §9.2 /
 * CUT-S2 §10.4 requires for the moment a shown child settles: App.tsx simply
 * calls this again with the freshly-fetched result, it never patches a
 * previous `ChildHistoryViewState` in place.
 */
export function projectChildHistoryResult(result: ChildHistoryResult): ChildHistoryViewState {
  if (!result.ok) {
    return { kind: "unavailable" };
  }
  if (result.items.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "blocks", blocks: projectHistoryToBlocks(result.items) };
}
