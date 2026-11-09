/**
 * Per-session switch row. Node env, no DOM: the initial render (no
 * tab context, state not yet loaded) shows the disabled reason; the wiring to
 * `setSessionAccess(tabId, enabled)` is pinned by the IPC tests.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionAccessRow, SessionApprovalsField, SessionHandleField, commitSessionHandle } from "./SessionAccessRow.js";
import {
  handleErrorText,
  SESSION_APPROVALS_ARIA_LABEL,
  SESSION_APPROVALS_DETAIL,
  SESSION_APPROVALS_NOTE,
  SESSION_HANDLE_DETAIL,
  SESSION_HANDLE_HINT,
  SESSION_HANDLE_LABEL,
  SESSION_SWITCH_TITLE,
  sessionApprovalsLabel,
} from "./sessions-api-model.js";

const neverBridge = {
  get: () => new Promise<never>(() => {}),
  setSessionAccess: () => new Promise<never>(() => {}),
  setSessionHandle: () => new Promise<never>(() => {}),
  setSessionApprovals: () => new Promise<never>(() => {}),
};

describe("SessionAccessRow", () => {
  it("without a tab it is disabled and says to open a session", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).toContain(SESSION_SWITCH_TITLE);
    expect(html).toContain("Open a session to share it.");
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });

  it("the row is labelled as a Sessions API group for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).toContain('aria-label="Sessions API"');
  });

  it("renders one row in the shared menu shape: icon, title + wrapping detail, control last", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    // The icon is the row's first child, the text block follows it, and the
    // checkbox sits in the actions slot at the end (same shape as Workspace/Branch).
    expect(html.indexOf("<svg")).toBeGreaterThan(-1);
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("environment-menu-row-main"));
    expect(html.indexOf("environment-menu-row-main")).toBeLessThan(html.indexOf("environment-menu-actions"));
    expect(html.indexOf("environment-menu-actions")).toBeLessThan(html.indexOf('data-environment-action="sessions-api-access"'));
    // Titles and secondary lines are separate elements, and the secondary line wraps.
    expect(html).toContain('class="environment-menu-row-title"');
    expect(html).toContain("environment-menu-row-detail-prose");
  });
});

describe("SessionAccessRow handle field", () => {
  it("handle input hidden when switch off", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).not.toContain('data-environment-action="sessions-api-handle"');
    expect(html).not.toContain("Handle (optional)");
  });

  it("commit sends only the tabId and the trimmed handle (blank = clear)", async () => {
    const calls: unknown[][] = [];
    const bridge = { setSessionHandle: async (...args: unknown[]) => { calls.push(args); return { ok: false as const, reason: "invalid" as const }; } };
    await commitSessionHandle(bridge, "tab-7", "  build-bot  ");
    await commitSessionHandle(bridge, "tab-7", "   ");
    expect(calls).toEqual([["tab-7", "build-bot"], ["tab-7", null]]);
  });

  it("maps invalid and duplicate results to their inline messages", () => {
    expect(handleErrorText("invalid")).toContain("Use lowercase letters");
    expect(handleErrorText("duplicate")).toContain("Another live session");
  });
});

describe("SessionAccessRow External approvals", () => {
  it("T30 the approvals checkbox is NOT rendered while sharing is off (no tab, state not loaded)", () => {
    const html = renderToStaticMarkup(createElement(SessionAccessRow, { bridge: neverBridge }));
    expect(html).not.toContain('data-environment-action="sessions-api-approvals"');
    expect(html).not.toContain(SESSION_APPROVALS_NOTE);
  });

  it("T30 when shown it carries the exact aria-label, the caption and the OFF label by default", () => {
    const html = renderToStaticMarkup(createElement(SessionApprovalsField, { approvals: false, onChange: () => {} }));
    // React static markup escapes the apostrophe as &#x27;.
    expect(html).toContain(`aria-label="${SESSION_APPROVALS_ARIA_LABEL.replace(/'/g, "&#x27;")}"`);
    expect(html).toContain('data-environment-action="sessions-api-approvals"');
    expect(html).toContain(SESSION_APPROVALS_NOTE.replace(/'/g, "&#x27;"));
    expect(html).toContain("External approvals off");
    expect(html).toContain('aria-checked="false"');
    expect(renderToStaticMarkup(createElement(SessionApprovalsField, { approvals: true, onChange: () => {} }))).toContain("External approvals on");
  });

  it("T31 the approvals row puts its caption on the wrapping secondary line and the checkbox on the right", () => {
    const html = renderToStaticMarkup(createElement(SessionApprovalsField, { approvals: true, onChange: () => {} }));
    expect(html).toContain("External approvals on");
    expect(html).toContain("environment-menu-row-detail-prose");
    // The row carries no decorative icon of its own (the help button's glyph is inside it).
    expect(html).not.toMatch(/environment-menu-row" role="group" aria-label="External approvals"><svg/);
    expect(html.indexOf("environment-menu-row-main")).toBeLessThan(html.indexOf("environment-menu-actions"));
    expect(html.indexOf("environment-menu-actions")).toBeLessThan(html.indexOf('data-environment-action="sessions-api-approvals"'));
  });

  it("T30 sessions-api-model pins the labels and the caption", () => {
    expect(SESSION_APPROVALS_ARIA_LABEL).toBe("Allow approving this session's tool requests from outside");
    expect(SESSION_APPROVALS_NOTE).toBe("Whoever holds the Sessions API token can allow or deny this session's tool requests.");
    expect(SESSION_APPROVALS_DETAIL).toBe("Token holder can answer tool requests");
    expect(sessionApprovalsLabel(true)).toBe("External approvals on");
    expect(sessionApprovalsLabel(false)).toBe("External approvals off");
  });
});

describe("SessionAccessRow explanations", () => {
  /** Ids the row points at with aria-describedby: the help button and the control share one. */
  function tooltipIds(html: string): string[] {
    const ids = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1] ?? "");
    return [...new Set(ids)];
  }

  it("the approvals row shows the short detail and keeps the full sentence behind the help button", () => {
    const html = renderToStaticMarkup(createElement(SessionApprovalsField, { approvals: true, onChange: () => {} }));
    expect(html).toContain(SESSION_APPROVALS_DETAIL);
    expect(html).toContain(SESSION_APPROVALS_NOTE.replace(/'/g, "&#x27;"));
    expect(html).toContain('role="tooltip"');
    // The button points at the tooltip that carries the full sentence.
    const ids = tooltipIds(html);
    expect(ids).toHaveLength(1);
    expect(html).toContain(`id="${ids[0]}"`);
  });

  it("the handle row shows the short detail and keeps the hint in the tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHandleField, { value: "build-bot", error: null, onChange: () => {}, onCommit: () => {} }),
    );
    expect(html).toContain(SESSION_HANDLE_DETAIL);
    expect(html).toContain(SESSION_HANDLE_HINT);
    expect(html).toContain('role="tooltip"');
    const ids = tooltipIds(html);
    expect(ids).toHaveLength(1);
    expect(html).toContain(`id="${ids[0]}"`);
  });

  it("two rows in the same menu get their own tooltip ids", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(SessionApprovalsField, { approvals: true, onChange: () => {} }),
        createElement(SessionHandleField, { value: "build-bot", error: null, onChange: () => {}, onCommit: () => {} }),
      ),
    );
    const ids = tooltipIds(html);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("SessionAccessRow layout", () => {
  it("the handle row carries a visible label, its hint as a tooltip and the field on the right", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHandleField, { value: "build-bot", error: null, onChange: () => {}, onCommit: () => {} }),
    );
    expect(html).not.toMatch(/environment-menu-row" role="group" aria-label="Session handle"><svg/);
    expect(html).toContain('placeholder="Agent name"');
    expect(html).toContain(SESSION_HANDLE_LABEL);
    expect(html).toContain(SESSION_HANDLE_DETAIL);
    // The hint is not an HTML title on the field: it is the help tooltip.
    expect(html).not.toContain(`title="${SESSION_HANDLE_HINT}"`);
    expect(html).toContain(SESSION_HANDLE_HINT);
    expect(html).toContain("environment-menu-text-input");
    expect(html.indexOf("environment-menu-row-main")).toBeLessThan(html.indexOf("environment-menu-actions"));
    expect(html.indexOf("environment-menu-actions")).toBeLessThan(html.indexOf('data-environment-action="sessions-api-handle"'));
    expect(html).not.toContain('role="alert"');
  });

  it("a handle error is an alert line inside the row, not a clipped detail", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHandleField, { value: "", error: "Another live session already uses this handle.", onChange: () => {}, onCommit: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("environment-menu-row-error");
    expect(html).toContain("Another live session already uses this handle.");
  });
});

