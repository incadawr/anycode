import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactionCard, CompactionDetail, compactionMeta, compactionRowText } from "./CompactionCard.js";
import { COMPACTION_INSTRUCTION_MIRROR } from "../compaction-prompt.js";
import type { TranscriptBlock } from "../store.js";

type CompactionBlock = Extract<TranscriptBlock, { kind: "compaction" }>;

const SUMMARY = "Session continued. Summary of the earlier conversation:\n\n- Goal: make the row open";

const card = (patch: Partial<CompactionBlock> = {}): CompactionBlock => ({
  kind: "compaction",
  id: "compaction:0",
  status: "done",
  ...patch,
});

const render = (block: CompactionBlock): string =>
  renderToStaticMarkup(createElement(CompactionCard, { block }));

/** The expanded body on its own — this file renders to static markup, so a
 *  collapsed live row cannot be clicked open here. */
const renderDetail = (block: CompactionBlock): string =>
  renderToStaticMarkup(createElement(CompactionDetail, { block }));

describe("CompactionCard — the row is a disclosure (GitHub #36)", () => {
  it("a live finished row starts COLLAPSED: the summary is evidence on demand, not a wall of text in the flow", () => {
    const html = render(card({ preTokens: 170_669, postTokens: 24_154, summary: SUMMARY }));

    expect(html).toContain("Conversation compacted: 170669 → 24154 tokens");
    // Collapsed, and the summary is genuinely absent from the markup — not
    // merely hidden by CSS.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Goal: make the row open");
    expect(html).not.toContain("Compaction prompt");
  });

  it("a restored record row starts COLLAPSED — reopening a session must not spill every old summary into the flow", () => {
    const html = render(card({ restored: true, summaryOrigin: "record", recordId: "rec-1", summary: SUMMARY }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Goal: make the row open");
    // The row still says what it has, and its numbers when the record kept them.
    expect(html).toContain("Conversation compacted earlier — summary available");
  });

  it("the LEGACY history-item row starts EXPANDED, so a resumed session keeps the summary it used to show as a bubble", () => {
    const html = render(card({ restored: true, summaryOrigin: "history", summaryItemId: "summary-1", summary: SUMMARY }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Goal: make the row open");
    expect(html).toContain('aria-label="Copy summary"');
    // The row knows it has no swap readings and says what it does know.
    expect(html).toContain("Conversation compacted earlier — summary available");
    // The durable link travels as data, not as prose.
    expect(html).toContain('data-summary-item-id="summary-1"');
  });

  it("shows the compaction prompt in its own collapsed sub-disclosure", () => {
    const html = renderDetail(card({ summary: SUMMARY, prompt: "PROMPT SENT TO THE SUMMARIZER" }));

    expect(html).toContain("Compaction prompt");
    expect(html).toContain("PROMPT SENT TO THE SUMMARIZER");
    // `<details>` = closed until the reader asks, without any state of ours.
    expect(html).toContain("<details");
  });

  it("a legacy row with no recorded prompt shows the CURRENT instruction, labelled as such — never as the one that was used", () => {
    const html = renderDetail(card({ restored: true, summaryOrigin: "history", summary: SUMMARY }));

    expect(html).toContain("Compaction prompt (current instruction)");
    expect(html).toContain("The instruction used for this summary was not recorded");
    expect(html).toContain(COMPACTION_INSTRUCTION_MIRROR.slice(0, 60));
  });

  it("a row restored from a durable record shows the prompt that was ACTUALLY sent, with no 'current instruction' hedge", () => {
    const html = renderDetail(
      card({ restored: true, summaryOrigin: "record", summary: SUMMARY, prompt: "the 2026-09 instruction" }),
    );

    expect(html).toContain("the 2026-09 instruction");
    expect(html).not.toContain("current instruction");
    expect(html).not.toContain(COMPACTION_INSTRUCTION_MIRROR.slice(0, 60));
  });

  it("a live row uses the EXACT prompt off the wire, never the mirror", () => {
    const html = renderDetail(card({ summary: SUMMARY, prompt: "a different instruction" }));

    expect(html).toContain("a different instruction");
    expect(html).not.toContain(COMPACTION_INSTRUCTION_MIRROR.slice(0, 60));
  });

  it("a failed row expands to its prompt and says there is no summary — it never invents one", () => {
    const html = renderDetail(card({ status: "failed", error: "model unreachable", prompt: "PROMPT" }));

    // The reason lives on the row itself (the alert), the body carries the
    // prompt and the honest absence of a summary.
    expect(render(card({ status: "failed", error: "model unreachable", prompt: "PROMPT" }))).toContain(
      "Compaction not applied: model unreachable",
    );
    expect(html).toContain("No summary was recorded for this compaction.");
    expect(html).toContain("PROMPT");
    expect(html).not.toContain('aria-label="Copy summary"');
    // The failed row keeps the alert register it has always had.
    expect(render(card({ status: "failed", error: "model unreachable" }))).toContain('role="alert"');
  });

  it("a restored record from a native engine (no summary, no prompt) shows neither a panel nor a borrowed instruction", () => {
    const html = renderDetail(card({ restored: true, summaryOrigin: "record", preTokens: 5_000, postTokens: 400 }));

    expect(html).toContain("No summary was recorded for this compaction.");
    expect(html).not.toContain("Compaction prompt");
  });

  it("a FINISHED compaction whose engine exposed no summary says so instead of showing an empty panel", () => {
    // Claude compacts natively and exposes no summary; the row must be honest
    // rather than pretend the panel is broken.
    const html = renderDetail(card({ preTokens: 10_000, postTokens: 900 }));

    expect(html).toContain("No summary was recorded for this compaction.");
    expect(html).not.toContain("Compaction prompt");
    // …and the collapsed row says nothing about a summary at all.
    expect(render(card({ preTokens: 10_000, postTokens: 900 }))).not.toContain("No summary was recorded");
  });

  it("a RUNNING compaction is not a disclosure — there is nothing to show yet", () => {
    const html = render(card({ status: "running", trigger: "auto" }));

    expect(html).toContain("Context window full — compacting conversation…");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("compaction-detail");
  });

  it("reports the summarizing call's model and duration, and omits the line entirely when neither is known", () => {
    expect(compactionMeta(card({ model: "glm-5.3", durationMs: 4_200 }))).toBe("glm-5.3 · 4s");
    expect(compactionMeta(card({ model: "glm-5.3" }))).toBe("glm-5.3");
    expect(compactionMeta(card({ durationMs: 900 }))).toBe("1s");
    expect(compactionMeta(card({}))).toBeUndefined();

    // A FAILED call names the model that was asked (the host knows it before the
    // call fails), so the row is not left with a bare duration.
    expect(compactionMeta(card({ status: "failed", error: "model unreachable", model: "glm-5.3", durationMs: 2_000 }))).toBe(
      "glm-5.3 · 2s",
    );
    const html = renderDetail(card({ restored: true, summary: SUMMARY, model: "glm-5.3", durationMs: 4_200 }));
    expect(html).toContain("Summarizing call: glm-5.3 · 4s");
    expect(renderDetail(card({ restored: true, summary: SUMMARY }))).not.toContain("Summarizing call:");
  });
});

describe("compactionRowText — GitHub #36 additions", () => {
  it("keeps the established wording for every state that has numbers or a reason", () => {
    expect(compactionRowText(card({ status: "running", trigger: "manual" }))).toBe("Compacting conversation…");
    expect(compactionRowText(card({ preTokens: 10_703, postTokens: 509 }))).toBe(
      "Conversation compacted: 10703 → 509 tokens",
    );
    expect(compactionRowText(card({ status: "failed", error: "model unreachable" }))).toBe(
      "Compaction not applied: model unreachable",
    );
  });

  it("a restored row has no swap readings, so it announces the summary instead of two question marks", () => {
    const text = compactionRowText(card({ restored: true, summary: SUMMARY }));
    expect(text).toBe("Conversation compacted earlier — summary available");
    expect(text).not.toContain("?");
  });
});
