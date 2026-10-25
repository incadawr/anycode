/**
 * Settings → Roles used to mount the role editor as a native modal
 * (`showModal`) that never closed: the whole window went inert ("frozen")
 * with no way back. The pane must render the editor inline; the first-run
 * picker stays a modal.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RolePickerDialog } from "./RolePickerDialog.js";
import { RolesPane } from "./RolesPane.js";

const base = {
  open: true,
  connections: [],
  activeConnectionId: undefined,
  engines: { claudeReady: true, codexReady: true },
  onSave: () => {},
};

describe("Roles editor modality", () => {
  it("the Settings Roles pane renders the editor in the page flow, never as a <dialog>", () => {
    const html = renderToStaticMarkup(createElement(RolesPane));
    expect(html).toContain("role-picker-inline");
    expect(html).not.toContain("<dialog");
  });

  it("inline mode renders a section; the default (first run) stays a dialog", () => {
    expect(renderToStaticMarkup(createElement(RolePickerDialog, { ...base, inline: true }))).toMatch(/^<section[^>]*role-picker-inline/);
    expect(renderToStaticMarkup(createElement(RolePickerDialog, base))).toMatch(/^<dialog/);
  });
});
