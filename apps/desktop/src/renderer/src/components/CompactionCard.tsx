/**
 * GitHub #36: the compaction row, made clickable.
 *
 * A compaction is the one operation that DESTROYS transcript context, and the
 * row that reports it used to be a dead line carrying only token numbers — no
 * way to see what actually survived without opening the SQLite DB. The row is
 * now a disclosure (the same posture Reasoning and tool cards take) over three
 * pieces of evidence:
 *
 *  - the SUMMARY that replaced the compacted prefix, rendered as markdown with
 *    a copy button — this is verbatim what the model sees from now on, own
 *    "Session continued…" wrapper included;
 *  - the COMPACTION PROMPT that produced it, in a collapsed sub-disclosure (a
 *    live row carries the exact text off `compaction_end.prompt`; a row rebuilt
 *    from history falls back to the renderer's parity-tested mirror);
 *  - the model and the wall time of the summarizing call, when the host knew
 *    them.
 *
 * A failed or not-applied row expands to its reason (already on the row) plus
 * the prompt, and NO summary — there is no summary, and inventing one would be
 * the worst possible lie for this row in particular.
 *
 * Rows restored from persisted history (`block.restored`) start EXPANDED: the
 * pre-#36 projection rendered the summary item as a plain user bubble, so a
 * resumed session used that text at a glance; collapsing it by default would
 * take content away. Live rows start collapsed, which is where the issue's
 * "expand to see" affordance belongs.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { TranscriptBlock } from "../store.js";
import { COMPACTION_INSTRUCTION_MIRROR } from "../compaction-prompt.js";
import { Markdown } from "./Markdown.js";
import { formatElapsed } from "./WorkingRow.js";
import { Check, Chevron, Copy } from "./icons.js";

type CompactionBlock = Extract<TranscriptBlock, { kind: "compaction" }>;

/** Writes to the clipboard if available, swallowing rejection (same posture as Markdown.tsx's private helper). */
function tryClipboardWrite(text: string, onSuccess: () => void): void {
  const write = navigator.clipboard?.writeText(text);
  if (!write) {
    return;
  }
  void write.then(onSuccess).catch(() => {});
}

/**
 * The one line a compaction card shows. Kept a pure function of the block so
 * the wording is pinnable without mounting the list, and so the states read as
 * one decision rather than nested ternaries in JSX.
 *
 * Running says which compaction it is, because the two have different causes a
 * user needs to tell apart: one they asked for, one the context window forced.
 * Done reports both readings — the point of the row is that the meter fell for
 * a REASON, so the reason carries the numbers. A missing `postTokens` prints
 * "?" rather than a zero: the host declined to say, and inventing a number here
 * would be a worse answer than admitting it. A done row with NO numbers at all
 * is a row rebuilt from persisted history (GitHub #36): the swap's readings
 * were never stored, so the row says what it does know — that a summary is
 * there to open — instead of two question marks.
 *
 * The not-ok branch never says "failed": `compaction_end` carries one `error`
 * string for both outcomes, and the commonest one is a deliberate no-op
 * (context/manager.ts's empty-prefix return, whose own comment reads "nothing
 * to compact. Not a failure."). Calling that a failure would be a claim the
 * wire does not support — the CLI hedges the same ambiguity as "compaction
 * skipped/failed" (cli/render.ts). "Not applied" states the one thing that IS
 * certain of both, and leaves the verb to the host's own reason instead of
 * stuttering over it ("skipped/failed: compaction skipped: …", live 07.09).
 */
export function compactionRowText(block: CompactionBlock): string {
  if (block.status === "running") {
    return block.trigger === "auto"
      ? "Context window full — compacting conversation…"
      : "Compacting conversation…";
  }
  if (block.status === "failed") {
    return `Compaction not applied: ${block.error ?? "unknown error"}`;
  }
  // A host that reports only the pre-reading (native Codex compaction) gets
  // the "before:" wording instead of a "N → ? tokens" half-arrow.
  if (block.preTokens !== undefined && block.postTokens === undefined) {
    return `Conversation compacted (before: ${block.preTokens} tokens)`;
  }
  if (block.preTokens === undefined && block.postTokens === undefined) {
    return "Conversation compacted earlier — summary available";
  }
  const pre = block.preTokens ?? "?";
  const post = block.postTokens ?? "?";
  return `Conversation compacted: ${pre} → ${post} tokens`;
}

/**
 * Meta line of the summarizing call: model and wall time, whichever the host
 * supplied; `undefined` when it supplied neither (a restored row, or a foreign
 * engine's native compaction). Exported pure for the wording pin.
 */
export function compactionMeta(block: CompactionBlock): string | undefined {
  const parts: string[] = [];
  if (block.model !== undefined && block.model.length > 0) {
    parts.push(block.model);
  }
  if (block.durationMs !== undefined) {
    parts.push(formatElapsed(Math.round(block.durationMs / 1000)));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function CompactionCard({ block, enter = false }: { block: CompactionBlock; enter?: boolean }) {
  // Null = no override yet, so the default follows the block (restored rows
  // open, live rows closed). A manual toggle sticks for the life of the mount,
  // which `key={block.id}` in MessageList keeps stable across re-renders.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const controlsId = useId();
  const running = block.status === "running";
  // GitHub #36 follow-up: a row rebuilt from a DURABLE RECORD starts collapsed —
  // reopening a session with five compactions must not spill five summaries into
  // the transcript; the row says "summary available" and one click opens it.
  // The LEGACY fallback (a summary found only as a `compact_summary` history
  // item, i.e. written before records existed) starts expanded, because the
  // pre-#36 transcript showed that text outright and hiding it would take
  // content away.
  const expanded = !running && (userExpanded ?? block.summaryOrigin === "history");
  const rowClass = `message ${block.status === "failed" ? "message-error" : "message-loop-end"}`;

  return (
    <div
      className={`compaction-card${enter ? " message-enter" : ""}`}
      data-block-id={block.id}
      data-compaction-status={block.status}
    >
      <div
        className={`${rowClass} compaction-head`}
        {...(block.status === "failed" ? { role: "alert" as const } : {})}
      >
        {running ? (
          <span className="compaction-toggle-static">
            <span className="compaction-caret" aria-hidden="true">
              <Chevron />
            </span>
            {compactionRowText(block)}
          </span>
        ) : (
          <button
            type="button"
            className="compaction-toggle"
            aria-expanded={expanded}
            aria-controls={controlsId}
            onClick={() => setUserExpanded(!expanded)}
          >
            <span className="compaction-caret" aria-hidden="true">
              <Chevron />
            </span>
            {compactionRowText(block)}
          </button>
        )}
      </div>
      {expanded && <CompactionDetail block={block} id={controlsId} />}
    </div>
  );
}

/**
 * The expanded body, split out so the evidence itself is testable without
 * mounting a disclosure state (the renderer's tests render to static markup).
 * The copy affordance lives here because it is the summary's affordance: one
 * click puts the exact text the model sees on the clipboard.
 */
export function CompactionDetail({ block, id }: { block: CompactionBlock; id?: string }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  // GitHub #36 follow-up: the prompt shown is the one that was ACTUALLY sent.
  // A live row carries it off `compaction_end.prompt`, and a row restored from a
  // durable record carries the copy the host recorded at the time — so the card
  // never presents today's instruction as the one that produced an old summary.
  // The ONLY fallback is the legacy history-item row, which has no record at
  // all: there the card shows the current instruction but says so, instead of
  // passing it off as the historical text. A foreign engine's row (claude) has
  // neither — its compaction is a native `/compact`, not this instruction — and
  // shows no prompt section at all.
  const recordedPrompt = block.prompt;
  const prompt = recordedPrompt ?? (block.summaryOrigin === "history" ? COMPACTION_INSTRUCTION_MIRROR : undefined);
  const meta = compactionMeta(block);

  const onCopy = (): void => {
    if (block.summary === undefined) {
      return;
    }
    tryClipboardWrite(block.summary, () => {
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      id={id}
      className="compaction-detail"
      // The durable link the issue asks for: which persisted history item holds
      // the summary this row is showing. Kept as data/title rather than as
      // prose — it is an identifier, not a fact a reader needs in the flow.
      {...(block.summaryItemId !== undefined ? { "data-summary-item-id": block.summaryItemId } : {})}
      {...(block.summaryItemId !== undefined ? { title: `Summary stored as history item ${block.summaryItemId}` } : {})}
    >
      {meta !== undefined && <div className="compaction-meta">Summarizing call: {meta}</div>}
      {block.summary !== undefined ? (
        <section className="compaction-section">
          <div className="compaction-section-head">
            <span className="compaction-section-title">Summary</span>
            <button
              type="button"
              className="compaction-copy"
              data-copied={copied}
              aria-label="Copy summary"
              onClick={onCopy}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="compaction-summary">
            <Markdown text={block.summary} />
          </div>
        </section>
      ) : (
        <p className="compaction-note">No summary was recorded for this compaction.</p>
      )}
      {prompt !== undefined && (
        <details className="compaction-prompt">
          <summary className="compaction-prompt-title">
            {recordedPrompt !== undefined ? "Compaction prompt" : "Compaction prompt (current instruction)"}
          </summary>
          <pre className="compaction-prompt-text">{prompt}</pre>
          {recordedPrompt === undefined && (
            <p className="compaction-prompt-note">
              The instruction used for this summary was not recorded; this is the current compaction prompt.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
