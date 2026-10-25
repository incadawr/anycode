/**
 * Pure helpers for the popped-out preview window (Taskana 4778): its title and
 * the "Return to AnyCode" affordances. No Electron imports, so the logic is
 * unit-testable; `createElectronPreviewWindow` wires them to the real window.
 */

export const RETURN_LABEL = "Return to AnyCode";

/** Window title: the page title, else the host of its URL, else a neutral label (never the app name). */
export function popoutTitle(pageTitle: string, url: string): string {
  const title = pageTitle.trim();
  if (title !== "" && title !== url) {
    return title;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "");
      return name !== "" ? name : "Preview";
    }
    if (parsed.host !== "") {
      return parsed.host;
    }
  } catch {
    // fall through
  }
  return title !== "" ? title : "Preview";
}

/** Cmd/Ctrl+Shift+D inside the pop-out window returns the preview to the pane. */
export function isReturnShortcut(input: { type: string; key: string; shift: boolean; meta: boolean; control: boolean }): boolean {
  return input.type === "keyDown" && input.shift && (input.meta || input.control) && input.key.toLowerCase() === "d";
}

/** Menu template shared by the window's menu bar (Windows/Linux) and its right-click menu. */
export function returnMenuTemplate(onReturn: () => void): Array<{ label: string; accelerator: string; click: () => void }> {
  return [{ label: RETURN_LABEL, accelerator: "CommandOrControl+Shift+D", click: onReturn }];
}
