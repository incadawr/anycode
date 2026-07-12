/**

 * placeholders, distinct/ordered ref scanning, inert `$` text, unknown-ref
 * throw, empty vars, literal `$` in values, and UTF-8.
 */

import { describe, expect, it } from "vitest";
import { renderTemplate, scanTemplateRefs } from "./template.js";

function steps(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

describe("scanTemplateRefs", () => {
  it("detects ${input}", () => {
    expect(scanTemplateRefs("before ${input} after")).toEqual({ input: true, stepIds: [] });
  });

  it("collects distinct ${steps.<id>} ids in first-appearance order", () => {
    const refs = scanTemplateRefs("${steps.beta} ${steps.alpha} ${steps.beta} ${input}");
    expect(refs.input).toBe(true);
    expect(refs.stepIds).toEqual(["beta", "alpha"]);
  });

  it("reports no refs for a plain template", () => {
    expect(scanTemplateRefs("nothing to see here")).toEqual({ input: false, stepIds: [] });
  });

  it("treats non-placeholder $ sequences as inert (no refs)", () => {
    // $VAR (no braces), ${foo} (unknown token), ${ input } (spaces), ${steps.}
    // (empty id), ${steps.a.b} (dotted — id must be `}`-terminated).
    const refs = scanTemplateRefs("$VAR ${foo} ${ input } ${steps.} ${steps.a.b} $${input}");
    // $${input} still contains a valid ${input} token after the leading $.
    expect(refs).toEqual({ input: true, stepIds: [] });
  });

  it("accepts a step id at the full length/charset boundary", () => {
    const id = `a${"b-c_9".repeat(13).slice(0, 63)}`; // 1 + 63 = 64 chars, valid NAME_RE
    expect(id.length).toBe(64);
    expect(scanTemplateRefs(`\${steps.${id}}`).stepIds).toEqual([id]);
  });

  it("rejects an over-length step id (65 chars) as inert", () => {
    const tooLong = `a${"b".repeat(64)}`; // 65 chars
    expect(scanTemplateRefs(`\${steps.${tooLong}}`).stepIds).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes ${input}", () => {
    expect(renderTemplate("Task: ${input}.", { input: "do it", steps: steps({}) })).toBe(
      "Task: do it.",
    );
  });

  it("substitutes ${steps.<id>} from the map", () => {
    const out = renderTemplate("A=${steps.a} B=${steps.b}", {
      input: "",
      steps: steps({ a: "one", b: "two" }),
    });
    expect(out).toBe("A=one B=two");
  });

  it("substitutes both placeholder forms together", () => {
    const out = renderTemplate("${input} => ${steps.res}", {
      input: "seed",
      steps: steps({ res: "result" }),
    });
    expect(out).toBe("seed => result");
  });

  it("throws on an unknown ${steps.<id>} at render time", () => {
    expect(() =>
      renderTemplate("${steps.missing}", { input: "x", steps: steps({ present: "y" }) }),
    ).toThrow(/steps\.missing/);
  });

  it("leaves inert $ sequences verbatim", () => {
    const template = "$HOME ${foo} ${steps.} price is $5";
    expect(renderTemplate(template, { input: "X", steps: steps({}) })).toBe(template);
  });

  it("renders empty input to an empty string", () => {
    expect(renderTemplate("[${input}]", { input: "", steps: steps({}) })).toBe("[]");
  });

  it("inserts values literally — a $ inside a value is NOT re-interpreted", () => {
    // The value itself contains what looks like a placeholder; it must NOT be
    // recursively substituted, and its `$` must not corrupt the replacement.
    const out = renderTemplate("${steps.a}", {
      input: "SEED",
      steps: steps({ a: "cost ${input} is $100 & $&" }),
    });
    expect(out).toBe("cost ${input} is $100 & $&");
  });

  it("handles multibyte UTF-8 in both templates and values", () => {
    const out = renderTemplate("→ ${input} · ${steps.s} ✓", {
      input: "café",
      steps: steps({ s: "日本語" }),
    });
    expect(out).toBe("→ café · 日本語 ✓");
  });

  it("substitutes every occurrence of a repeated ref", () => {
    expect(
      renderTemplate("${input}-${input}-${steps.a}-${steps.a}", {
        input: "x",
        steps: steps({ a: "y" }),
      }),
    ).toBe("x-x-y-y");
  });
});
