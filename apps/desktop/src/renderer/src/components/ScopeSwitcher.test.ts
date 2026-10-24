/**
 * Taskana 4706: pure-helper tests for the shared Global-vs-Project scope
 * control (ScopeSwitcher.tsx). Same convention as the panes' own test files:
 * this package's vitest runs `environment: "node"` with no jsdom/
 * @testing-library, so the control's behavior is pinned through its exported
 * pure helpers (the component itself is a thin two-button shell over them).
 */
import { describe, expect, it } from "vitest";
import { defaultPaneScope, projectOptionLabel, resolvePaneScope } from "./ScopeSwitcher.js";

describe("ScopeSwitcher helpers (Taskana 4706)", () => {
  it("resolvePaneScope falls back to user when no project target exists", () => {
    expect(resolvePaneScope("project", false)).toBe("user");
  });

  it("resolvePaneScope keeps an explicit project choice when a project target exists", () => {
    expect(resolvePaneScope("project", true)).toBe("project");
  });

  it("resolvePaneScope keeps user always legal regardless of project availability", () => {
    expect(resolvePaneScope("user", true)).toBe("user");
    expect(resolvePaneScope("user", false)).toBe("user");
  });

  it("defaultPaneScope defaults to the open project (card item 1: the active tab), else global", () => {
    expect(defaultPaneScope(true)).toBe("project");
    expect(defaultPaneScope(false)).toBe("user");
  });

  it("projectOptionLabel names the workspace when known, degrades to bare 'Project' when not", () => {
    expect(projectOptionLabel("repo")).toBe("Project: repo");
    expect(projectOptionLabel("")).toBe("Project");
  });
});
