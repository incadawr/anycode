import { describe, expect, it } from "vitest";
import {
  copyConfigEnabled,
  folderScopeHint,
  mutationRefusalText,
  parsePortInput,
  portFieldValue,
  regenerateEnabled,
  sessionSwitchDisabledReason,
  sessionSwitchLabel,
  sessionsApiStatusLine,
  settingsEditable,
  SESSIONS_API_LABEL,
  SESSIONS_API_NOTICES,
  SESSIONS_API_PANE_ID,
  SESSIONS_API_REGENERATE_CONFIRM,
} from "./sessions-api-model.js";
import type { CommunicationMutationReason, CommunicationStatus } from "../../../shared/communication-config.js";

const listening: CommunicationStatus = { state: "listening", url: "http://127.0.0.1:4310/mcp", port: 4310, workspaces: 0, sessions: 1 };
const off: CommunicationStatus = { state: "off", workspaces: 0, sessions: 0 };

describe("Sessions API pane model (Taskana 4747)", () => {
  it("exposes the pane id and label the search and rail use", () => {
    expect(SESSIONS_API_PANE_ID).toBe("sessions-api");
    expect(SESSIONS_API_LABEL).toBe("Sessions API");
  });

  it("renders the four status lines, with env winning over everything", () => {
    expect(sessionsApiStatusLine(listening, false)).toBe("Listening on 127.0.0.1:4310");
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

  it("explains the open folder scope only when enabled with no folders", () => {
    expect(folderScopeHint({ enabled: true, workspaces: [] })).toMatch(/No folder restriction/);
    expect(folderScopeHint({ enabled: true, workspaces: ["/a"] })).toBeNull();
    expect(folderScopeHint({ enabled: false, workspaces: [] })).toBeNull();
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
    expect(sessionSwitchLabel(true)).toMatch(/shared/);
    expect(sessionSwitchLabel(false)).toMatch(/not shared/);
    expect(sessionSwitchDisabledReason(true, true)).toMatch(/ANYCODE_COMMUNICATION_CONFIG/);
    expect(sessionSwitchDisabledReason(false, false)).toMatch(/Open a session/);
    expect(sessionSwitchDisabledReason(false, true)).toBeNull();
  });

  it("static notices and the regenerate confirm are plain sentences about the real behaviour", () => {
    expect(SESSIONS_API_NOTICES.join(" ")).toMatch(/127\.0\.0\.1/);
    expect(SESSIONS_API_NOTICES.join(" ")).toMatch(/Node 22/);
    expect(SESSIONS_API_REGENERATE_CONFIRM).toMatch(/restart the external client's MCP connection/);
  });
});
