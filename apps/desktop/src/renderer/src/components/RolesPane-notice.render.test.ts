/**
 * B6 regression: "Roles saved." used to render below the last field of the
 * pane, off screen under the Save roles button at 900 px. The editor now takes
 * the pane's notice into its actions row, left of the buttons.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RolePickerDialog } from "./RolePickerDialog.js";
import { RolesSaveNotice } from "./RolesPane.js";

const base = {
  open: true,
  connections: [],
  activeConnectionId: undefined,
  engines: { claudeReady: true, codexReady: true },
  onSave: () => {},
};

describe("Save feedback sits in the actions row, next to the button", () => {
  it("renders the notice inside .role-picker-actions, before the save button", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, {
      ...base, inline: true, saveLabel: "Save roles",
      actionsNotice: createElement(RolesSaveNotice, { ok: true }),
    }));
    const actions = html.slice(html.indexOf('class="role-picker-actions"'));
    const noticeAt = actions.indexOf("Roles saved.");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(actions.indexOf('data-testid="role-picker-save"'));
    // Nothing closes the actions row between its opening tag and the notice.
    expect(actions.slice(0, noticeAt)).not.toContain("</div>");
  });

  it("shows no notice element when there is nothing to report", () => {
    const html = renderToStaticMarkup(createElement(RolePickerDialog, { ...base, inline: true }));
    const actions = html.slice(html.indexOf('class="role-picker-actions"'));
    expect(actions).not.toContain('role="status"');
  });
});
