/**
 * Pure-logic tests for the composer's large-paste collapse (design
 * slice-R7-cut §2/§5.1). `.test.ts` under a node (no-jsdom) vitest env: every
 * export in paste.ts is a total function over plain data.
 */
import { describe, expect, it } from "vitest";
import {
  countPasteLines,
  makePasteMarker,
  reconstitutePasteMarkers,
  shouldCollapsePaste,
  visiblePasteBlocks,
  type PasteBlock,
} from "./paste.js";

function linesOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
}

describe("countPasteLines", () => {
  it("counts newlines + 1, no trimming/normalization", () => {
    expect(countPasteLines("")).toBe(1);
    expect(countPasteLines("a")).toBe(1);
    expect(countPasteLines("a\nb")).toBe(2);
    expect(countPasteLines("a\nb\n")).toBe(3); // trailing newline counts as a line
  });
});

describe("shouldCollapsePaste", () => {
  it("collapses strictly more than the threshold", () => {
    expect(shouldCollapsePaste(linesOf(40))).toBe(false);
    expect(shouldCollapsePaste(linesOf(41))).toBe(true);
    expect(shouldCollapsePaste("")).toBe(false);
  });
});

describe("makePasteMarker", () => {
  it("formats the sentinel marker; distinct ids produce distinct markers", () => {
    expect(makePasteMarker(7)).toBe("⟦pasted #7⟧");
    expect(makePasteMarker(1)).not.toBe(makePasteMarker(2));
  });
});

describe("visiblePasteBlocks", () => {
  it("includes blocks whose marker is present, excludes absent/mangled ones, preserves order", () => {
    const blocks: readonly PasteBlock[] = [
      { id: 1, text: "one", lineCount: 1 },
      { id: 2, text: "two", lineCount: 1 },
      { id: 3, text: "three", lineCount: 1 },
    ];
    const draft = `${makePasteMarker(1)} hello ${makePasteMarker(3)} pasted #2⟧`;
    expect(visiblePasteBlocks(draft, blocks)).toEqual([
      { id: 1, text: "one", lineCount: 1 },
      { id: 3, text: "three", lineCount: 1 },
    ]);
  });
});

describe("reconstitutePasteMarkers — identity", () => {
  it("returns the same reference when there are no blocks", () => {
    const draft = "hello world";
    expect(reconstitutePasteMarkers(draft, [])).toBe(draft);
  });

  it("leaves the draft unchanged when blocks exist but no markers are present", () => {
    const draft = "hello world";
    const blocks: readonly PasteBlock[] = [{ id: 1, text: "one", lineCount: 1 }];
    expect(reconstitutePasteMarkers(draft, blocks)).toBe(draft);
  });
});

describe("reconstitutePasteMarkers — worked example (§2.2)", () => {
  it("splices a single mid-text marker with the block text exactly", () => {
    const pasted = linesOf(60);
    const blocks: readonly PasteBlock[] = [{ id: 1, text: pasted, lineCount: 60 }];
    const draft = `${makePasteMarker(1)} explain this`;
    expect(reconstitutePasteMarkers(draft, blocks)).toBe(`${pasted} explain this`);
  });
});

describe("reconstitutePasteMarkers — multiple blocks", () => {
  it("expands multiple interleaved blocks, preserving order", () => {
    const blocks: readonly PasteBlock[] = [
      { id: 1, text: "AAA", lineCount: 1 },
      { id: 2, text: "BBB", lineCount: 1 },
    ];
    const draft = `pre ${makePasteMarker(1)} mid ${makePasteMarker(2)} post`;
    expect(reconstitutePasteMarkers(draft, blocks)).toBe("pre AAA mid BBB post");
  });
});

describe("reconstitutePasteMarkers — duplicated marker", () => {
  it("expands every occurrence of a duplicated marker", () => {
    const blocks: readonly PasteBlock[] = [{ id: 1, text: "AAA", lineCount: 1 }];
    const draft = `${makePasteMarker(1)} and again ${makePasteMarker(1)}`;
    expect(reconstitutePasteMarkers(draft, blocks)).toBe("AAA and again AAA");
  });
});

describe("reconstitutePasteMarkers — literal-marker collision", () => {
  it("passes through a marker-shaped string with no matching block verbatim", () => {
    const blocks: readonly PasteBlock[] = [{ id: 1, text: "AAA", lineCount: 1 }];
    const draft = `${makePasteMarker(1)} but not ${makePasteMarker(9)}`;
    expect(reconstitutePasteMarkers(draft, blocks)).toBe(`AAA but not ${makePasteMarker(9)}`);
  });
});

describe("reconstitutePasteMarkers — replacer-function law", () => {
  it("treats $&/$'/$1 in block text as literal (not a replacement pattern)", () => {
    const blocks: readonly PasteBlock[] = [{ id: 1, text: "cost is $1, or $& and $'", lineCount: 1 }];
    const draft = makePasteMarker(1);
    expect(reconstitutePasteMarkers(draft, blocks)).toBe("cost is $1, or $& and $'");
  });
});

describe("reconstitutePasteMarkers — single-pass law", () => {
  it("does not re-scan expanded block content for other blocks' markers", () => {
    const blocks: readonly PasteBlock[] = [
      { id: 1, text: `contains ${makePasteMarker(2)} literally`, lineCount: 1 },
      { id: 2, text: "BBB", lineCount: 1 },
    ];
    const draft = makePasteMarker(1);
    expect(reconstitutePasteMarkers(draft, blocks)).toBe(`contains ${makePasteMarker(2)} literally`);
  });
});
