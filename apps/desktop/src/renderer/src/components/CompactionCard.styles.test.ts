// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { expect, it } from "vitest";

it("reserves dot width and disables the animation for reduced motion", () => {
  const css = readFileSync(new NodeURL("../app.css", import.meta.url), "utf8");
  const stylesheet = document.createElement("style");
  stylesheet.textContent = css;
  document.head.append(stylesheet);
  const container = document.createElement("div");
  container.innerHTML = '<span class="compaction-dots"><span>.</span><span>.</span><span>.</span></span>';
  const dots = container.querySelector(".compaction-dots")!;
  try {
    const style = window.getComputedStyle(dots);
    expect(style.display).toBe("inline-flex");
    expect(style.width).toBe("1.2em");
    const children = Array.from(dots.children).map(dot => window.getComputedStyle(dot));
    expect(children.every(dot => dot.animation.includes("compaction-dot-pulse"))).toBe(true);
    expect(new Set(children.map(dot => dot.animationDelay)).size).toBe(3);
    expect(css).toMatch(/@keyframes compaction-dot-pulse\s*\{[^}]*opacity:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.compaction-dots > span\s*\{[^}]*animation: none;[^}]*opacity: 1;/);
  } finally {
    stylesheet.remove();
  }
});
