import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ClaudeTurnPreview } from "./ClaudeTurnPreview.js";

describe("Claude provisional response", () => {
  it("renders unassigned text and tool status and disappears on clear", () => {
    const markup = renderToStaticMarkup(createElement(ClaudeTurnPreview, { preview: { text: "live <answer>", tools: [{ id: "call", name: "Bash", status: "requested" }] } }));
    expect(markup).toContain("Response being identified");
    expect(markup).toContain("live &lt;answer&gt;");
    expect(markup).toContain("Bash: ");
    expect(markup).toContain("requested");
    expect(renderToStaticMarkup(createElement(ClaudeTurnPreview, { preview: null }))).toBe("");
  });
});
