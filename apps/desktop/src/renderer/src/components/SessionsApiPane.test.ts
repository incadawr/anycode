/**
 * Pane render tests (Taskana 4747). The renderer package runs in node with no DOM
 * (same rationale as LanguageServersPane.test.ts), so the presentational body is
 * rendered to static markup and the container's wiring is pinned through a fake bridge.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionsApiPaneView, type SessionsApiPaneViewProps } from "./SessionsApiPane.js";
import type { CommunicationView } from "../../../shared/communication-config.js";

const TOKEN = "deadbeef".repeat(8);
const base = (over: Partial<CommunicationView> = {}): CommunicationView => ({
  enabled: false,
  workspaces: [],
  port: null,
  defaultSessionAccess: "off",
  status: { state: "off", workspaces: 0, sessions: 0 },
  tabs: [],
  ...over,
});
const noop = () => {};
function props(over: Partial<SessionsApiPaneViewProps> & { view?: CommunicationView } = {}): SessionsApiPaneViewProps {
  return {
    view: base(),
    envControlled: false,
    error: null,
    portText: "",
    copied: null,
    confirmingRegenerate: false,
    onToggle: noop, onAddFolder: noop, onRemoveFolder: noop, onPortText: noop, onApplyPort: noop,
    onDefaultAccess: noop, onCopy: noop, onRegenerateAsk: noop, onRegenerateConfirm: noop, onRegenerateCancel: noop,
    ...over,
  };
}
const render = (p: SessionsApiPaneViewProps) => renderToStaticMarkup(createElement(SessionsApiPaneView, p));
/** The opening tag of the button whose visible text is `label`. */
function buttonTag(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  if (!match) throw new Error(`no button ${label}`);
  return match[0];
}

describe("SessionsApiPaneView (Taskana 4747)", () => {
  it("renders the status line for off and listening", () => {
    expect(render(props())).toContain("Off");
    expect(render(props({ view: base({ enabled: true, port: 4310, status: { state: "listening", url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 0, sessions: 0 } }) }))).toContain("Listening on 127.0.0.1:4310");
  });

  it("the env override disables the toggle, the folder controls and the port field, and says why", () => {
    const html = render(props({ envControlled: true }));
    expect(html).toContain("Controlled by ANYCODE_COMMUNICATION_CONFIG");
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
    expect(buttonTag(html, "Add folder…")).toContain("disabled");
    expect(buttonTag(html, "Apply")).toContain("disabled");
  });

  it("copy buttons are disabled unless listening", () => {
    const off = render(props());
    for (const label of ["Claude Code", "Codex", "Generic"]) expect(buttonTag(off, label)).toContain("disabled");
    const listening = render(props({ view: base({ enabled: true, status: { state: "listening", url: "http://127.0.0.1:1/mcp", port: 1, workspaces: 0, sessions: 0 } }) }));
    for (const label of ["Claude Code", "Codex", "Generic"]) expect(buttonTag(listening, label)).not.toContain("disabled");
  });

  it("folders render as escaped text, never as markup", () => {
    const html = render(props({ view: base({ workspaces: ['/x/<img src=x onerror=1>/"q"'] }) }));
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("an empty folder list while enabled shows the no-restriction hint, not a refusal", () => {
    const html = render(props({ view: base({ enabled: true }) }));
    expect(html).toContain("No folder restriction");
    expect(html).not.toContain('role="alert"');
  });

  it("regenerate asks for confirmation first and states the restart requirement", () => {
    const idle = render(props({ view: base({ enabled: true, status: { state: "listening", url: "http://127.0.0.1:1/mcp", port: 1, workspaces: 0, sessions: 0 } }) }));
    expect(idle).not.toContain("Regenerate now");
    const asked = render(props({ confirmingRegenerate: true }));
    expect(asked).toContain("Regenerate now");
    expect(asked).toMatch(/restart the external client/);
  });

  it("no token-shaped text appears in any rendered state", () => {
    const states = [
      props(),
      props({ envControlled: true }),
      props({ view: base({ enabled: true, workspaces: ["/a"], port: 4310, status: { state: "listening", url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 1, sessions: 2 } }) }),
      props({ copied: { label: "Codex", note: '[mcp_servers.anycode-sessions]\ncommand = "node"' }, error: "The change could not be made." }),
      props({ confirmingRegenerate: true }),
    ];
    for (const state of states) {
      const html = render(state);
      expect(html).not.toContain(TOKEN);
      expect(html).not.toMatch(/[0-9a-f]{48,}/);
    }
  });

  it("the per-session default selector reflects the saved value", () => {
    expect(render(props({ view: base({ defaultSessionAccess: "on" }) }))).toMatch(/<option value="on" selected=""/);
  });
});

describe("SessionsApiPane wiring (Taskana 4747)", () => {
  it("the container calls addWorkspace with NO arguments and never builds a path client-side", () => {
    const source = readFileSync(new URL("./SessionsApiPane.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/bridge\.addWorkspace\(\)/);
    expect(source).not.toMatch(/addWorkspace\([^)]/);
    expect(source).not.toMatch(/\bpath\b\s*:/);
  });
});
