import { describe, expect, it } from "vitest";
import {
  copyConfigEnabled,
  handleErrorText,
  mutationRefusalText,
  parsePortInput,
  portFieldValue,
  regenerateEnabled,
  sessionSwitchDisabledReason,
  sessionSwitchDetail,
  sessionsApiStatusLine,
  sessionsApiStatusTone,
  settingsEditable,
  SESSIONS_API_DESCRIPTION,
  SESSIONS_API_FOOTER,
  SESSIONS_API_LABEL,
  SESSIONS_API_NODE_HINT,
  SESSIONS_API_PANE_ID,
  SESSIONS_API_REGENERATE_CONFIRM,
  SESSIONS_API_AGENT_PROJECTS_HINT,
  SESSIONS_API_AGENT_PROJECTS_EMPTY,
  SESSIONS_API_SHARE_HINT,
} from "./sessions-api-model.js";
import type { CommunicationMutationReason, CommunicationStatus } from "../../../shared/communication-config.js";

const listening: CommunicationStatus = { state: "listening", url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 0, sessions: 1 };
const off: CommunicationStatus = { state: "off", workspaces: 0, sessions: 0 };

describe("Sessions API pane model (Taskana 4747)", () => {
  it("exposes the pane id and label the search and rail use", () => {
    expect(SESSIONS_API_PANE_ID).toBe("sessions-api");
    expect(SESSIONS_API_LABEL).toBe("Sessions API");
  });

  it("renders the four status chip texts, with env winning over everything", () => {
    expect(sessionsApiStatusLine(listening, false)).toBe("Listening · 127.0.0.1:4310 · 1 shared");
    expect(sessionsApiStatusLine(off, false)).toBe("Off");
    expect(sessionsApiStatusLine({ state: "error", reason: "start_failed", detail: "port in use", workspaces: 0, sessions: 0 }, false)).toMatch(/^Error: the port is already in use/);
    expect(sessionsApiStatusLine(listening, true)).toBe("Controlled by environment");
    expect(sessionsApiStatusLine({ state: "env", workspaces: 0, sessions: 0 }, false)).toBe("Controlled by environment");
  });

  it("error detail text never echoes a path or a secret (fixed vocabulary only)", () => {
    const text = sessionsApiStatusLine({ state: "error", reason: "start_failed", detail: "folder not found", workspaces: 1, sessions: 0 }, false);
    expect(text).toMatch(/no longer available/);
    expect(text).not.toMatch(/\//);
  });

  it("copy buttons and regenerate need a listening, non-env server", () => {
    expect(copyConfigEnabled(listening, false)).toBe(true);
    expect(copyConfigEnabled(off, false)).toBe(false);
    expect(copyConfigEnabled(listening, true)).toBe(false);
    expect(regenerateEnabled(listening, false)).toBe(true);
    expect(regenerateEnabled(off, false)).toBe(false);
  });

  it("the env override makes settings read-only", () => {
    expect(settingsEditable(true)).toBe(false);
    expect(settingsEditable(false)).toBe(true);
  });

  it("chip tone: ok when listening, danger on error, muted when off or env-controlled", () => {
    expect(sessionsApiStatusTone(listening, false)).toBe("ok");
    expect(sessionsApiStatusTone(off, false)).toBe("muted");
    expect(sessionsApiStatusTone({ state: "error", reason: "start_failed", detail: "port in use", workspaces: 0, sessions: 0 }, false)).toBe("danger");
    expect(sessionsApiStatusTone(listening, true)).toBe("muted");
  });

  it("parses the port field: blank is random, integers 0..65535 are valid, the rest is invalid", () => {
    expect(parsePortInput("")).toBeNull();
    expect(parsePortInput("  ")).toBeNull();
    expect(parsePortInput("0")).toBe(0);
    expect(parsePortInput("65535")).toBe(65535);
    expect(parsePortInput("65536")).toBeUndefined();
    expect(parsePortInput("-1")).toBeUndefined();
    expect(parsePortInput("80.5")).toBeUndefined();
    expect(parsePortInput("8e3")).toBeUndefined();
    expect(portFieldValue(null)).toBe("");
    expect(portFieldValue(4310)).toBe("4310");
  });

  it("refusal wording covers every reason and never empty except for a cancelled dialog", () => {
    const reasons: CommunicationMutationReason[] = ["read_only", "invalid", "io_error", "env_controlled", "not_a_directory", "duplicate", "too_many", "not_found", "not_running"];
    for (const reason of reasons) expect(mutationRefusalText(reason).length).toBeGreaterThan(0);
    expect(mutationRefusalText("cancelled")).toBe("");
  });

  it("per-tab switch: label wording and disabled reasons", () => {
    expect(sessionSwitchDetail(true)).toBe("Shared with external agents");
    expect(sessionSwitchDetail(false)).toBe("Not shared");
    expect(sessionSwitchDisabledReason(true, true)).toMatch(/ANYCODE_COMMUNICATION_CONFIG/);
    expect(sessionSwitchDisabledReason(false, false)).toMatch(/Open a session/);
    expect(sessionSwitchDisabledReason(false, true)).toBeNull();
  });

  it("the footer, the Node hint and the regenerate confirm are plain sentences about the real behaviour", () => {
    expect(SESSIONS_API_FOOTER).toMatch(/never shown here/);
    expect(SESSIONS_API_NODE_HINT).toMatch(/Node 22\+/);
    expect(SESSIONS_API_DESCRIPTION).toMatch(/Local only\.$/);
    expect(SESSIONS_API_REGENERATE_CONFIRM).toMatch(/restart the external client's MCP connection/);
  });
});

describe("Sessions API pane discoverability copy (audit D9)", () => {
  it("the project switch is named where it lives: the sidebar project ⋯ menu", () => {
    expect(SESSIONS_API_AGENT_PROJECTS_HINT).toMatch(/sidebar project ⋯ menu|project ⋯ menu in the sidebar/);
    expect(SESSIONS_API_AGENT_PROJECTS_EMPTY).toMatch(/sidebar project ⋯ menu|project ⋯ menu in the sidebar/);
  });

  it("the shared-sessions hint says how a session is shared, not only how many are", () => {
    expect(SESSIONS_API_SHARE_HINT).toMatch(/session's ⋯ environment menu/);
    expect(SESSIONS_API_SHARE_HINT).toMatch(/Currently shared/);
  });

  it("the pane subtitle mentions the per-session switch (sharing is opt-in per session)", () => {
    expect(SESSIONS_API_DESCRIPTION).toMatch(/sessions you choose/i);
  });
});

describe("session handle wording (Taskana 4750b)", () => {
  it("invalid and duplicate handles show their inline message", () => {
    expect(handleErrorText("invalid")).toBe("Use lowercase letters, digits and - _ . @, up to 64.");
    expect(handleErrorText("duplicate")).toBe("Another live session already uses this handle.");
  });
  it("other failures have plain wording and success shows nothing", () => {
    expect(handleErrorText("unknown_tab")).toBe("That session is no longer open.");
    expect(handleErrorText("io_error")).toBe("The handle could not be saved.");
    expect(handleErrorText(undefined)).toBeNull();
  });
});
