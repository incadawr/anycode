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
import {
  SESSIONS_API_AGENT_PROJECT_ON,
  SESSIONS_API_AGENT_PROJECT_TURN_OFF,
  SESSIONS_API_DESCRIPTION,
  SESSIONS_API_FOLDER_HINT,
} from "./sessions-api-model.js";
import type { CommunicationView } from "../../../shared/communication-config.js";

const TOKEN = "deadbeef".repeat(8);
const base = (over: Partial<CommunicationView> = {}): CommunicationView => ({
  enabled: false,
  workspaces: [],
  port: null,
  defaultSessionAccess: "off",
  status: { state: "off", workspaces: 0, sessions: 0 },
  tabs: [],
  agentProjects: [],
  missingWorkspaces: [],
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
    onAgentProjectOff: noop, onDefaultAccess: noop, onCopyClient: noop, onCopy: noop, onRegenerateAsk: noop, onRegenerateConfirm: noop, onRegenerateCancel: noop,
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

  it("a listed folder that is missing on disk is marked Missing with wording that explains the effect", () => {
    const html = render(props({ view: base({ enabled: true, workspaces: ["/gone", "/kept"], missingWorkspaces: ["/gone"], status: listeningStatus() }) }));
    const rows = html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? [];
    const gone = rows.find((row) => row.includes("/gone"));
    const kept = rows.find((row) => row.includes("/kept"));
    expect(gone).toBeDefined();
    expect(kept).toBeDefined();
    // The missing row states the problem in plain words (not a bare chip word).
    expect(gone).toContain("Missing on disk");
    expect(gone).toContain("grants nothing until the folder is back");
    // A present folder carries no mark.
    expect(kept).not.toContain("Missing on disk");
  });

  it("the missing mark disappears once the folder is back (no missingWorkspaces entry)", () => {
    const html = render(props({ view: base({ enabled: true, workspaces: ["/back"], missingWorkspaces: [], status: listeningStatus() }) }));
    expect(html).not.toContain("Missing on disk");
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

describe("SessionsApiPaneView agent projects (Taskana 4768)", () => {
  it("Advanced lists agent-allowed projects with working Off buttons", () => {
    const empty = render(props());
    expect(empty).toContain("No project allows agents to open tasks yet");
    const html = render(props({ view: base({ agentProjects: [{ key: "/Users/me/app", name: "app", displayPath: "~/app" }, { key: "/srv/api", name: "api", displayPath: "/srv/api" }] }) }));
    expect(html).toContain("Agents may open tasks here");
    expect(html).toContain("~/app");
    expect(html).toContain("/srv/api");
    expect(html).not.toContain("No project allows agents");
    expect((html.match(/aria-label="Turn off agents opening tasks in [^"]*"/g) ?? [])).toHaveLength(2);
    expect(render(props({ envControlled: true, view: base({ agentProjects: [{ key: "/srv/api", name: "api", displayPath: "/srv/api" }] }) }))).toMatch(/<button[^>]*aria-label="Turn off agents opening tasks in api"[^>]*disabled=""/);
    const source = readFileSync(new URL("./SessionsApiPane.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/bridge\.agentProjectsOff\(key\)/);
  });

  it("an allowed project reads as ON with a Turn off action — never a button labelled with a state", () => {
    const html = render(props({ view: base({ agentProjects: [{ key: "/srv/api", name: "api", displayPath: "/srv/api" }] }) }));
    const row = html.match(/<li><span class="sessions-api-folder-path"[^>]*>[\s\S]*?<\/li>/)![0];
    // The state is stated, and it is the ON state (every listed project is allowed).
    expect(row).toContain(SESSIONS_API_AGENT_PROJECT_ON);
    expect(row).toMatch(/class="settings-secret-status settings-secret-status-ok sessions-api-agent-project-state">On</);
    // The button is an ACTION with its own words, not a bare "Off" that reads as state.
    expect(buttonTag(row, SESSIONS_API_AGENT_PROJECT_TURN_OFF)).toContain('aria-label="Turn off agents opening tasks in api"');
    expect(row).not.toMatch(/>Off</);
  });
});

describe("SessionsApiPane Advanced layout (regression: state labels and spacing)", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

  it("the port field's label shares one control group with its input (it used to sit at the far edge of the row)", () => {
    const html = render(props({ view: base({ enabled: true }) }));
    const group = html.match(/<div class="sessions-api-row-control">(?:(?!<\/div>)[\s\S])*?id="sessions-api-port"[\s\S]*?<\/div>/)![0];
    expect(group).toContain('<label class="settings-field-label" for="sessions-api-port">Port</label>');
    // Immediate siblings: label, then the input (no wrapper container in between).
    expect(group).toMatch(/for="sessions-api-port">Port<\/label><input id="sessions-api-port"/);
    expect(buttonTag(group, "Apply")).toContain("settings-button");
  });

  it("adjacent Advanced rows are separated by an explicit row rhythm", () => {
    expect(cssRule(css, ".sessions-api-advanced > .sessions-api-row + .sessions-api-row")).toMatch(/margin-top:\s*var\(--sp-4\)/);
  });

  it("a row's hint hugs its heading (no UA paragraph margin inside the row)", () => {
    expect(cssRule(css, ".sessions-api-row .settings-field-hint")).toMatch(/margin:\s*0;/);
  });
});

/** The declared body of `selector` in `css` (comments stripped); throws when absent. */
function cssRule(css: string, selector: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = clean.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no CSS rule ${selector}`);
  return match[1] ?? "";
}

describe("SessionsApiPane step layout (Taskana 4897)", () => {
  // Regression: after "Copy config", the notice was the step's 4th grid child. The
  // step was `grid-template-columns: auto 1fr` and `::before` spanned exactly 3
  // rows, so that 4th child auto-placed into column 1 — under the step number —
  // and its long `<pre>` inflated the `auto` column, pushing the whole content
  // column (title, segmented control, button, hint, notice) off the right edge.
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

  it("every step wraps ALL of its content in one `.sessions-api-step-body`, so the column count never depends on the child count", () => {
    const html = render(props({
      view: base({ enabled: true, port: 4310, status: listeningStatus() }),
      copied: { label: "Claude Code", note: "claude mcp add anycode-sessions -- node /very/long/path/to/the/adapter/script.js --config /very/long/path/to/discovery.json" },
    }));
    const steps = html.match(/<li class="sessions-api-step">[\s\S]*?<\/li>/g) ?? [];
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      const bodies = step.match(/<div class="sessions-api-step-body">/g) ?? [];
      expect(bodies).toHaveLength(1);
      // The body is the li's ONLY direct child: nothing else can auto-place in column 1.
      expect(step).toMatch(/^<li class="sessions-api-step"><div class="sessions-api-step-body">[\s\S]*<\/div><\/li>$/);
    }
    // The copy notice lives inside the content column, after the node hint.
    const step2 = steps[1] ?? "";
    const hintAt = step2.indexOf("Needs Node 22+");
    const noticeAt = step2.indexOf("sessions-api-copied");
    expect(hintAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeGreaterThan(hintAt);
    expect(step2.slice(noticeAt)).toContain("claude mcp add anycode-sessions");
  });

  it("the step number occupies a fixed narrow column and no longer spans a magic row count", () => {
    expect(cssRule(css, ".sessions-api-step")).toMatch(/grid-template-columns:\s*1\.5rem\s+minmax\(0,\s*1fr\)/);
    const number = cssRule(css, ".sessions-api-step::before");
    expect(number).toMatch(/grid-column:\s*1/);
    expect(number).not.toMatch(/grid-row:\s*span/);
    const body = cssRule(css, ".sessions-api-step-body");
    expect(body).toMatch(/grid-column:\s*2/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it("a long command scrolls inside its own `<pre>` and cannot widen the pane", () => {
    const pre = cssRule(css, ".sessions-api-copied pre");
    expect(pre).toMatch(/overflow-x:\s*auto/);
    expect(pre).toMatch(/min-width:\s*0/);
    expect(pre).toMatch(/white-space:\s*pre;/);
    expect(cssRule(css, ".sessions-api-copied")).toMatch(/min-width:\s*0/);
  });
});
