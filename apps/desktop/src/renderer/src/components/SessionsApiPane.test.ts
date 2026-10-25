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
import { SESSIONS_API_DESCRIPTION, SESSIONS_API_FOLDER_HINT } from "./sessions-api-model.js";
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
const listeningStatus = (sessions = 0) => ({ state: "listening" as const, url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 0, sessions });
const noop = () => {};
function props(over: Partial<SessionsApiPaneViewProps> & { view?: CommunicationView } = {}): SessionsApiPaneViewProps {
  return {
    view: base(),
    envControlled: false,
    error: null,
    portText: "",
    copyClient: "claude-code",
    copied: null,
    confirmingRegenerate: false,
    onToggle: noop, onAddFolder: noop, onRemoveFolder: noop, onPortText: noop, onApplyPort: noop,
    onDefaultAccess: noop, onCopyClient: noop, onCopy: noop, onRegenerateAsk: noop, onRegenerateConfirm: noop, onRegenerateCancel: noop,
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
/** The status chip (the element carrying aria-live), its class and its text. */
function chip(html: string): { className: string; text: string } {
  const match = html.match(/<span class="([^"]*sessions-api-status[^"]*)" aria-live="polite">([^<]*)<\/span>/);
  if (!match) throw new Error("no status chip");
  return { className: match[1] ?? "", text: match[2] ?? "" };
}

describe("SessionsApiPaneView (Taskana 4747)", () => {
  it("the status chip reads Off (muted) while the API is off", () => {
    const c = chip(render(props()));
    expect(c.text).toBe("Off");
    expect(c.className).toContain("settings-secret-status-muted");
  });

  it("the status chip reads Listening · address · N shared (ok) while listening", () => {
    const c = chip(render(props({ view: base({ enabled: true, port: 4310, status: listeningStatus(2) }) })));
    expect(c.text).toBe("Listening · 127.0.0.1:4310 · 2 shared");
    expect(c.className).toContain("settings-secret-status-ok");
  });

  it("the status chip shows Error: <message> (danger) on a failed start", () => {
    const c = chip(render(props({ view: base({ enabled: true, status: { state: "error", reason: "start_failed", detail: "port in use", workspaces: 0, sessions: 0 } }) })));
    expect(c.text).toMatch(/^Error: the port is already in use/);
    expect(c.className).toContain("settings-secret-status-danger");
  });

  it("the enable control is a switch labelled Allow external agents, wired to its state", () => {
    const html = render(props());
    expect(html).toMatch(/<button type="button" role="switch" aria-checked="false"[^>]*class="settings-switch"/);
    expect(html).toContain("Allow external agents");
    expect(render(props({ view: base({ enabled: true }) }))).toMatch(/role="switch" aria-checked="true"/);
  });

  it("the env override disables the switch, the folder controls and the port field, and says why", () => {
    const html = render(props({ envControlled: true }));
    expect(html).toContain("Controlled by ANYCODE_COMMUNICATION_CONFIG");
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(buttonTag(html, "Add folder…")).toContain("disabled");
    expect(buttonTag(html, "Apply")).toContain("disabled");
  });

  it("the Connect section is hidden while off and shown once enabled", () => {
    expect(render(props())).not.toContain("Connect an agent");
    const on = render(props({ view: base({ enabled: true }) }));
    expect(on).toContain("Connect an agent");
    expect(on).toContain("Choose which sessions to share");
    expect(on).toContain("Paste it into your agent&#x27;s MCP settings and restart the agent.");
  });

  it("Advanced is a collapsed details disclosure by default", () => {
    const html = render(props({ view: base({ enabled: true }) }));
    expect(html).toMatch(/<details class="connection-drawer-advanced sessions-api-advanced">/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain("<summary>Advanced</summary>");
  });

  it("the subtitle is not repeated in the pane body (the Settings header prints it once)", () => {
    const html = render(props({ view: base({ enabled: true }) }));
    expect(html).not.toContain(SESSIONS_API_DESCRIPTION);
    expect(SESSIONS_API_DESCRIPTION).toBe("Let external agents (Claude Code, Codex, scripts) read and message the sessions you choose. Local only.");
  });

  it("one primary Copy config button is disabled unless listening; the agent picker is always usable", () => {
    const off = render(props({ view: base({ enabled: true }) }));
    expect(buttonTag(off, "Copy config")).toContain("disabled");
    expect(buttonTag(off, "Claude Code")).not.toContain("disabled");
    const listening = render(props({ view: base({ enabled: true, status: listeningStatus() }) }));
    expect(buttonTag(listening, "Copy config")).not.toContain("disabled");
    expect(listening).toContain("Needs Node 22+ where the agent runs.");
  });

  it("the copied feedback names the client and never carries a token", () => {
    const html = render(props({ view: base({ enabled: true, status: listeningStatus() }), copied: { label: "Codex", note: '[mcp_servers.anycode-sessions]\ncommand = "node"' } }));
    expect(html).toContain("Copied the Codex config to the clipboard");
    expect(html).not.toContain(TOKEN);
  });

  it("folders render as escaped text, never as markup", () => {
    const html = render(props({ view: base({ workspaces: ['/x/<img src=x onerror=1>/"q"'] }) }));
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("the folder hint says an empty list means any folder", () => {
    const html = render(props({ view: base({ enabled: true }) }));
    expect(html).toContain(SESSIONS_API_FOLDER_HINT);
    expect(html).not.toContain('role="alert"');
  });

  it("regenerate asks for confirmation first and states the restart requirement", () => {
    const idle = render(props({ view: base({ enabled: true, status: listeningStatus() }) }));
    expect(idle).not.toContain("Regenerate now");
    expect(idle).toContain("Disconnects running clients; copy the config again afterwards.");
    const asked = render(props({ confirmingRegenerate: true }));
    expect(asked).toContain("Regenerate now");
    expect(asked).toMatch(/restart the external client/);
  });

  it("the footer line is printed once and states where the token lives", () => {
    const html = render(props());
    expect(html).toContain("The token is stored only in a private file on this computer");
  });

  it("no token-shaped text appears in any rendered state", () => {
    const states = [
      props(),
      props({ envControlled: true }),
      props({ view: base({ enabled: true, workspaces: ["/a"], port: 4310, status: listeningStatus(2) }) }),
      props({ copied: { label: "Codex", note: '[mcp_servers.anycode-sessions]\ncommand = "node"' }, error: "The change could not be made." }),
      props({ confirmingRegenerate: true }),
    ];
    for (const state of states) {
      const html = render(state);
      expect(html).not.toContain(TOKEN);
      expect(html).not.toMatch(/[0-9a-f]{48,}/);
    }
  });

  it("the new-sessions default switch reflects the saved value", () => {
    expect(render(props({ view: base({ defaultSessionAccess: "on" }) }))).toMatch(/aria-checked="true"[^>]*aria-labelledby="sessions-api-default-caption"/);
    expect(render(props())).toMatch(/aria-checked="false"[^>]*aria-labelledby="sessions-api-default-caption"/);
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
