import { describe, expect, it } from "vitest";
import { COMPACTION_INSTRUCTION } from "@anycode/core";
import { COMPACTION_INSTRUCTION_MIRROR } from "./compaction-prompt.js";

/**
 * GitHub #36: a compaction row rebuilt from persisted history has no event to
 * read the instruction from, so the renderer carries its own copy. This test
 * is the ONLY thing keeping that copy from silently drifting away from the
 * prompt core actually sends — a live value import here is deliberate (tests
 * may import core as a value; production renderer code may not).
 */
describe("compaction prompt mirror (GitHub #36)", () => {
  it("is byte-identical to the real @anycode/core COMPACTION_INSTRUCTION", () => {
    expect(COMPACTION_INSTRUCTION_MIRROR).toBe(COMPACTION_INSTRUCTION);
  });
});
