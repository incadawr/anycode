import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCounts, assertLossless, assertMcpRow, observeToolCatalog, assertLayout, assertNativeUnavailable, assertConsentPending, assertPluginConsentRows } from "./extensions-ui-smoke.mjs";

const connected = "Connected in this session";
const failed = "Connection failed";
const unknown = "Status not reported in this session";
const fixtureRows = () => [
  { name: "healthy", source: "Project · Saved: disabled", enabled: false, status: connected },
  { name: "healthy", source: "User · Saved: disabled", enabled: false, status: "Shadowed by another scope" },
  { name: "broken", source: "Project · Saved: disabled", enabled: false, status: failed },
];

test("count assertions reject shadowed or compat entries counted as configured", () => {
  assertCounts([4, 1, 1, 1], [4, 1, 1, 1]);
  assert.throws(() => assertCounts([6, 1, 1, 1], [4, 1, 1, 1]));
  assert.throws(() => assertCounts([4, 0, 1, 1], [4, 1, 1, 1]));
});

test("runtime checks distinguish duplicate names across scopes", () => {
  assertMcpRow(fixtureRows(), "healthy", "Project", false, connected);
  assert.throws(() => assertMcpRow(fixtureRows(), "healthy", "User", false, connected));
  assert.throws(() => assertMcpRow(fixtureRows(), "absent", "Project", false, connected));
});

test("saving disabled must preserve the current host failure", () => {
  assertMcpRow(fixtureRows(), "broken", "Project", false, failed);
  const masked = fixtureRows().map(row => row.name === "broken" ? { ...row, status: unknown } : row);
  assert.throws(() => assertMcpRow(masked, "broken", "Project", false, failed));
});

test("a new host must not claim that a disabled fixture is connected", () => {
  const fresh = [{ name: "healthy", source: "Project", enabled: false, status: unknown }];
  assertMcpRow(fresh, "healthy", "Project", false, unknown);
  assert.throws(() => assertMcpRow(fixtureRows(), "healthy", "Project", false, unknown));
});

test("saved switches are checked independently from current runtime status", () => {
  const unsaved = fixtureRows().map(row => ({ ...row, enabled: true }));
  assert.throws(() => assertMcpRow(unsaved, "healthy", "Project", false, connected));
});

const config = () => ({
  mcpServers: {
    healthy: { command: "fixture-node", args: ["fixture-server"], cwd: "workspace", env: { KEEP: "sentinel" }, enabled: true },
    broken: { command: "missing", enabled: true },
    off: { command: "unused", enabled: false },
  },
  telemetry: { enabled: false, marker: "keep" },
});

test("lossless assertion accepts only the requested changes", () => {
  const before = config(), after = config();
  after.mcpServers.healthy.enabled = false;
  after.mcpServers.broken.enabled = false;
  assertLossless(before, after, ["healthy", "broken"]);
  assert.equal(before.mcpServers.healthy.enabled, true);
});

test("lossless assertion rejects config collateral changes", () => {
  const before = config();
  for (const mutate of [
    after => { delete after.mcpServers.healthy.env; },
    after => { after.mcpServers.healthy.args = []; },
    after => { after.mcpServers.healthy.cwd = "other"; },
    after => { delete after.telemetry; },
    after => { after.mcpServers.off.enabled = true; },
  ]) {
    const after = config();
    after.mcpServers.healthy.enabled = false;
    mutate(after);
    assert.throws(() => assertLossless(before, after, ["healthy"]));
  }
});


test("background title requests cannot overwrite the observed agent catalog", () => {
  const enabled = { tools: [{ function: { name: "mcp__healthy__echo" } }] };
  const disabled = { tools: [{ function: { name: "read_file" } }] };
  assert.deepEqual(observeToolCatalog(enabled), { echo: true });
  assert.deepEqual(observeToolCatalog(disabled), { echo: false });
  assert.equal(observeToolCatalog({}), null);
  assert.equal(observeToolCatalog({ tools: [] }), null);
});

const layout = () => ({ width: 720, height: 850, left: 8, right: 712, top: 50, bottom: 830,
  overflow: false, triggerVisible: true, warning: true });
test("layout assertion accepts both themes and rejects clipping, overflow and lost warnings", () => {
  assertLayout(layout());
  for (const mutation of [
    { left: -1 }, { right: 721 }, { top: -1 }, { bottom: 851 },
    { overflow: true }, { triggerVisible: false }, { warning: false },
  ]) assert.throws(() => assertLayout({ ...layout(), ...mutation }));
});

const unavailable = () => ({ text: "These language servers are saved for Core sessions. This engine does not use AnyCode LSP.", switches: 0, details: false, restart: false });
test("native assertion rejects false capability, missing reason and actionable unsupported controls", () => {
  assertNativeUnavailable(unavailable());
  for (const mutation of [
    { text: "No configured entries." }, { text: "Connected" },
    { switches: 1 }, { details: true }, { restart: true }, { restart: undefined }, { switches: undefined },
  ]) assert.throws(() => assertNativeUnavailable({ ...unavailable(), ...mutation }));
});

test("consent-pending assertion rejects an absent row, missing reason and writable plugin MCP", () => {
  assertConsentPending({ reason: true, switches: 0 });
  for (const state of [
    {}, { reason: false, switches: 0 }, { reason: true, switches: 1 },
    { reason: true }, { switches: 0 },
  ]) assert.throws(() => assertConsentPending(state));
});


test("plugin consent assertions distinguish workspace trust from missing user MCP consent", () => {
  const rows = [
    { name: "plugin_b-plugin_api", source: "Plugin", note: "Read-only; manage in Plugins", switches: 0 },
    { name: "plugin_pending-user_api", source: "Plugin", note: "Needs approval in Plugins", switches: 0 },
  ];
  assertPluginConsentRows(rows);
  for (const index of [0, 1]) {
    assert.throws(() => assertPluginConsentRows(rows.filter((_, i) => i !== index)));
    assert.throws(() => assertPluginConsentRows(rows.map((row, i) => i === index ? { ...row, switches: 1 } : row)));
    assert.throws(() => assertPluginConsentRows(rows.map((row, i) => ({ ...row, note: rows[1 - i].note }))));
  }
});
