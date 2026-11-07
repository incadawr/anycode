import { readFileSync } from "node:fs";
import ts from "typescript";
import { ClaudeClient } from "./engines/claude/claude-client.js";
import { expect, it, vi } from "vitest";
import { ENGINE_BUILTIN_SKILLS } from "../shared/engine-skills.js";

// Execute the actual root options initializer without booting the host entrypoint.
const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const boot = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "bootClaudeSession")!;
let initializer: ts.Expression;
function visit(n: ts.Node) {
  if (ts.isVariableDeclaration(n) && n.name.getText(source) === "options") initializer = n.initializer!;
  ts.forEachChild(n, visit);
}
visit(boot);
const executable = ts.transpileModule(`const result = ${initializer!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(child = false, failure = false) {
  const prepareBuiltinSnapshot = vi.fn(() => ({ root: "/sealed" }));
  const readBuiltinPolicy = vi.fn(async () => Object.fromEntries(ENGINE_BUILTIN_SKILLS.map(({ id }) => [id,
    { enabled: !failure, reason: failure ? "worker-error" : "enabled" }])));
  const deps = { bootstrap: {}, args: { child: child ? {} : undefined }, hostProfileHome: () => "/profile",
    ENGINE_BUILTIN_SKILLS, readBuiltinPolicy, prepareBuiltinSnapshot, join: (...p: string[]) => p.join("/"),
    workspace: "/workspace", hostWorkspaceTrust: { projectTrusted: true }, builtinBrowser: {},
    resolveClaudeConfigDir: () => "/cli", process: { env: {} },
    buildClaudeLaunchOptions: () => ({}), claudeClassifierBroker: {}, binaryPath: "/binary",
    claudeCompositionEnabled: false, hostMcpLoginPath: undefined, processOwnership: {},
    resolveMcpForward: undefined, mcpBridge: {}, stamp: {}, agentCatalogNonEmpty: false,
    claudeBrowserToolNames: undefined, claudePeerToolNames: undefined };
  const options = new Function(...Object.keys(deps), `${executable}; return result;`)(...Object.values(deps));
  return { options, readBuiltinPolicy, prepareBuiltinSnapshot };
}
it("prepares only root Claude using host policy and browser capabilities", async () => {
  const f = fixture(); await f.options.prepareBuiltinSkills();
  expect(f.readBuiltinPolicy).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: true, userConfigPath: "/profile/.anycode/config.json" }));
  expect(f.prepareBuiltinSnapshot).toHaveBeenCalledWith(expect.objectContaining({ engine: "claude", browser: {}, disabled: [] }));
  const child = fixture(true); expect(child.options.prepareBuiltinSkills).toBeUndefined();
  expect(child.readBuiltinPolicy).not.toHaveBeenCalled();
});
it("propagates host policy failure to the client's unavailable-notice seam", async () => {
  const f = fixture(false, true);
  await expect(f.options.prepareBuiltinSkills()).rejects.toThrow("worker-error");
  expect(f.prepareBuiltinSnapshot).not.toHaveBeenCalled();
  const notice = vi.fn();
  const client = new ClaudeClient({ ...f.options, binaryPath: "/synthetic/cli", cwd: "/workspace",
    binaryTrust: () => null, sourceEnv: {}, onBuiltinSkillNotice: notice,
    spawnImpl: () => { throw new Error("stop-before-spawn"); } });
  const seams = client as unknown as { preflightVersion(): Promise<void>; supportsPluginDirectory(): Promise<boolean> };
  vi.spyOn(seams, "preflightVersion").mockResolvedValue();
  vi.spyOn(seams, "supportsPluginDirectory").mockResolvedValue(true);
  await expect(client.start()).rejects.toThrow("stop-before-spawn");
  expect(notice).toHaveBeenCalledExactlyOnceWith("worker-error");
});

it("Codex root wiring uses fresh strict policy, trusted app names and registered browser specs", async () => {
  const boot = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "bootCodexSession")!;
  let spread: ts.Expression | undefined;
  const visit = (n: ts.Node) => { if (ts.isSpreadAssignment(n) && n.expression.getText(source).includes("prepareBuiltinSkills")) spread = n.expression; ts.forEachChild(n, visit); };
  visit(boot); expect(spread).toBeDefined();
  const read = vi.fn(async () => Object.fromEntries(ENGINE_BUILTIN_SKILLS.map(({ id }) => [id, { enabled: true, reason: "enabled" }])));
  const snapshot = vi.fn(() => ({ root: "/sealed" })), install = vi.fn();
  const deps = { args: { child: undefined as unknown }, hostProfileHome: () => "/profile", workspace: "/workspace", homedir: () => "/home",
    hostWorkspaceTrust: { projectTrusted: false }, codexProfile: { home: "/cli" }, process: { env: {} }, codexBuiltinBrowser: { specs: [] },
    ENGINE_BUILTIN_SKILLS, readBuiltinPolicy: read, prepareBuiltinSnapshot: snapshot, installCodexBuiltins: install,
    buildEngineBuiltinSkills: vi.fn(() => ENGINE_BUILTIN_SKILLS.map(e => ({ id: e.id, name: e.codex }))), join: (...p: string[]) => p.join("/") };
  const code = ts.transpileModule(`const result = ${spread!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const evaluate = () => new Function(...Object.keys(deps), `${code}; return result;`)(...Object.values(deps));
  const prepared = await evaluate().prepareBuiltinSkills(); await prepared.afterInitialize({});
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: false, userConfigPath: "/profile/.anycode/config.json" }));
  expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ engine: "codex", browser: deps.codexBuiltinBrowser, excludedRoots: expect.arrayContaining(["/cli"]) }));
  expect(install).toHaveBeenCalledWith({}, "/workspace", "/sealed", ENGINE_BUILTIN_SKILLS.map(e => e.codex));
  read.mockResolvedValueOnce(Object.fromEntries(ENGINE_BUILTIN_SKILLS.map(({ id }) => [id, { enabled: id !== "anycode-setup", reason: id === "anycode-setup" ? "disabled" : "enabled" }])));
  await (await evaluate().prepareBuiltinSkills()).afterInitialize({});
  expect(snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: ["anycode-setup"] }));
  expect(install).toHaveBeenLastCalledWith({}, "/workspace", "/sealed", ENGINE_BUILTIN_SKILLS.slice(1).map(e => e.codex));
  read.mockResolvedValueOnce(Object.fromEntries(ENGINE_BUILTIN_SKILLS.map(({ id }) => [id, { enabled: false, reason: "disabled" }])));
  expect(await evaluate().prepareBuiltinSkills()).toBeUndefined();
  read.mockResolvedValueOnce(Object.fromEntries(ENGINE_BUILTIN_SKILLS.map(({ id }) => [id, { enabled: false, reason: "worker-error" }])));
  await expect(evaluate().prepareBuiltinSkills()).rejects.toThrow("worker-error");
  deps.args.child = {}; expect(evaluate().prepareBuiltinSkills).toBeUndefined();
});
