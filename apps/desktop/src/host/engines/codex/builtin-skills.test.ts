import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installCodexBuiltins } from "./builtin-skills.js";
import { AppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { startCodexEngine, resumeCodexEngine, initializeAndVerifyAccount } from "./codex-engine.js";
import { prepareBuiltinSnapshot } from "../../skills/builtin-snapshot.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { OrchestrationController } from "../../orchestration-policy.js";
import { ENV_CODEX_SUPPORT_POLICY, encodeCodexSupportPolicy } from "../../../shared/codex-version-policy.js";

let home: string, fake: string;
const clients: AppServerClient[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "codex-builtins-")); fake = join(home, "fake.mjs");
  fs.mkdirSync(join(home, "workspace")); fs.mkdirSync(join(home, "codex"));
  fs.writeFileSync(fake, `import fs from 'node:fs'; import readline from 'node:readline'; import path from 'node:path';
if(process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
let roots=[], calls=[], initialized=false;
const on=process.argv.includes('features.multi_agent=false');
const config=on?{mcp_servers:{},features:{multi_agent:false,remote_plugin:false},apps:{_default:{enabled:false}},sandbox_mode:'read-only',approval_policy:'never'}:{mcp_servers:{},features:{multi_agent:true},sandbox_mode:'workspace-write',approval_policy:'on-request'};
readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);calls.push(q.method);fs.appendFileSync(path.join(process.env.HOME,'requests'),q.method+'\\n');let result={};
if(q.method==='initialize') result={};
else if(q.method==='initialized') {initialized=true;return;}
else if(q.method==='skills/extraRoots/set') {if(!initialized)process.exit(4);if(process.argv.includes('--set-refuse')){console.log(JSON.stringify({id:q.id,error:{code:-32601,message:'unsupported'}}));return;}if(process.argv.includes('--reset-fail')&&!q.params.extraRoots.length){console.log(JSON.stringify({id:q.id,error:{code:-32601,message:'unsupported'}}));return;}roots=q.params.extraRoots;}
else if(q.method==='skills/list') {if(process.argv.includes('--timeout'))return;if(process.argv.includes('--refuse')){console.log(JSON.stringify({id:q.id,error:{code:-32601,message:'unsupported'}}));return;}result={roots,home:process.env.CODEX_HOME,skills:roots.flatMap(root=>(fs.existsSync(path.join(root,'SKILL.md'))?[root]:fs.readdirSync(root).map(name=>path.join(root,name))).map(dir=>({name:path.basename(dir),path:path.join(dir,'SKILL.md'),enabled:true,scope:'user',body:fs.readFileSync(path.join(dir,'SKILL.md'),'utf8')})))};result.data=[{cwd:process.cwd(),errors:[],skills:result.skills.map(s=>({...s,path:process.argv.includes('--bad-readback')?'/foreign/wrong':s.path}))}];}
else if(q.method==='account/read')result={account:{id:'synthetic'},requiresOpenaiAuth:false};
else if(q.method==='model/list')result={data:[],nextCursor:null};
else if(q.method==='config/read')result={config,layers:[]};
else if(q.method==='thread/read')result={thread:{id:'thread',turns:[]}};
else if(q.method==='thread/start'||q.method==='thread/resume') {if(roots.length&&!calls.includes('skills/list'))process.exit(5);result={thread:{id:'thread',turns:[]},model:'synthetic',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};}
else if(q.method==='test/notify'){console.log(JSON.stringify({method:'test/notification'}));return;}
else if(q.method==='test/calls')result=calls;
if(q.id!==undefined)console.log(JSON.stringify({id:q.id,result}));});`);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  const unseal = (dir: string) => { if (!fs.lstatSync(dir).isDirectory()) return; fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) unseal(join(dir, name)); };
  unseal(home); fs.rmSync(home, { recursive: true, force: true });
});
function options(): AppServerClientOptions {
  return { binaryPath: process.execPath, binaryArgs: [fake], cwd: join(home, "workspace"), codexHome: join(home, "codex"),
    sourceEnv: { HOME: home, [ENV_CODEX_SUPPORT_POLICY]: encodeCodexSupportPolicy({ ranges: [">=0.166.0 <0.167.0"], riskAcceptedVersions: [] }) }, binaryTrust: () => null };
}
function client(extra: Partial<AppServerClientOptions> = {}) { const c = new AppServerClient({ ...options(), ...extra }); clients.push(c); return c; }
function preparation(roots: string[]) {
  const lease = prepareBuiltinSnapshot({ engine: "codex", hostProfileHome: home, workspace: join(home, "workspace"), excludedRoots: [join(home, "codex")] });
  roots.push(lease.root);
  return { lease, afterInitialize: async (port: { request<T>(method: "skills/list" | "skills/extraRoots/set", params: unknown): Promise<T> }) => {
    await port.request("skills/extraRoots/set", { extraRoots: [join(lease.root, "skills")] });
    await port.request("skills/list", { forceReload: true });
  } };
}
it("binds two real children to different sealed generations with one synthetic home", async () => {
  const roots: string[] = [], bound: number[] = [];
  const prepare = vi.fn(async () => {
    const p = preparation(roots), bind = p.lease.bindChild;
    p.lease.bindChild = (child, group) => { expect(child.listenerCount("exit")).toBe(0); bound.push(child.pid!); bind(child, group); };
    return p;
  });
  const a = client({ prepareBuiltinSkills: prepare }), b = client({ prepareBuiltinSkills: prepare });
  await a.start(); await b.start(); await initializeAndVerifyAccount(a, 1000); await initializeAndVerifyAccount(b, 1000);
  expect(bound).toEqual([a.pid, b.pid]); expect(prepare).toHaveBeenCalledTimes(2);
  for (const [i, c] of [a, b].entries()) {
    const catalog = await c.request<{ roots: string[]; home: string; skills: { path: string; body: string }[] }>("skills/list", {});
    expect(catalog.roots).toEqual([join(roots[i]!, "skills")]); expect(catalog.home).toBe(join(home, "codex"));
    expect(catalog.skills[0]!.path).toContain(roots[i]!); expect(catalog.skills[0]!.body).toContain("AnyCode");
    expect(fs.statSync(catalog.skills[0]!.path).mode & 0o777).toBe(0o400);
  }
  await a.close(); await b.close();
  await vi.waitFor(() => { for (const root of roots) expect(fs.existsSync(root)).toBe(false); });
});
it.each([false, true])("fresh/resume (%s) and real ON/OFF replacements prepare once per child", async resume => {
  const roots: string[] = [], seen: string[][] = [];
  const opts = { ...options(), bootstrap: { id: "codex" as const, adopt: () => {}, dispose: async () => {} }, workspace: join(home, "workspace"), broker: new IpcPermissionBroker(() => {}), persistOrchestrationThreadId: async () => {},
    prepareBuiltinSkills: async () => { const p = preparation(roots); return { ...p, afterInitialize: async (port: Parameters<typeof p.afterInitialize>[0]) => { await p.afterInitialize(port); seen.push([p.lease.root]); } }; } };
  const connected = resume ? await resumeCodexEngine({ ...opts, externalSessionRef: "thread" }) : await startCodexEngine(opts);
  try {
    const controller = new OrchestrationController(connected.engine.orchestrationPolicy);
    expect(await controller.apply(true, { preset: "ask" })).toBe(true);
    expect(await controller.apply(false, { preset: "ask" })).toBe(true);
    expect(roots).toHaveLength(3); expect(seen).toEqual(roots.map(root => [root]));
  } finally { await connected.engine.dispose("session-close"); }
  await vi.waitFor(() => { for (const root of roots) expect(fs.existsSync(root)).toBe(false); });
});
it.each(["--refuse", "--timeout"])("post-initialize %s falls back to ordinary thread/start", async flag => {
  const roots: string[] = [];
  const connected = await startCodexEngine({ ...options(), binaryArgs: [fake, flag], timeouts: { bootRpcMs: 500 },
    bootstrap: { id: "codex", adopt: () => {}, dispose: async () => {} }, workspace: join(home, "workspace"), broker: new IpcPermissionBroker(() => {}),
    prepareBuiltinSkills: async () => preparation(roots) });
  expect(fs.readFileSync(join(home, "requests"), "utf8")).toContain("thread/start");
  await connected.engine.dispose("session-close");
  await vi.waitFor(() => expect(fs.existsSync(roots[0]!)).toBe(false));
});
it("close during preparation aborts the never-spawned lease", async () => {
  const roots: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); await gate; return p; } });
  const started = c.start(); await vi.waitFor(() => expect(roots).toHaveLength(1)); await c.close(); release();
  await expect(started).rejects.toThrow(); expect(c.pid).toBeNull(); expect(fs.existsSync(roots[0]!)).toBe(false);
});
it("a stale post-initialize callback cannot attach its root after close", async () => {
  const roots: string[] = []; let entered = false; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); return { ...p, afterInitialize: async (port: Parameters<typeof p.afterInitialize>[0]) => { entered = true; await gate; await p.afterInitialize(port); } }; } });
  await c.start(); const init = initializeAndVerifyAccount(c, 1000).then(() => "resolved", e => e.message);
  await vi.waitFor(() => expect(entered).toBe(true)); await c.close(); release(); expect(await init).toBe("Codex builtin callback invalidated");
  const fresh = client(); await fresh.start(); await initializeAndVerifyAccount(fresh, 1000);
  expect(await fresh.request("skills/list", {})).toMatchObject({ roots: [] });
});
it("trust revocation and synchronous spawn failure abort only the unbound lease", async () => {
  for (const kind of ["trust", "spawn"] as const) {
    const roots: string[] = []; let revoked = false;
    const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); revoked = kind === "trust"; return p; },
      binaryTrust: () => revoked ? "revoked" : null, spawnImpl: (cmd, args, opts) => { if (kind === "spawn" && args.includes("app-server")) throw new Error("spawn failed"); return spawn(cmd, args, opts); } });
    await expect(c.start()).rejects.toThrow(); expect(fs.existsSync(roots[0]!)).toBe(false);
  }
});

it("a hook runs once, after initialized and before account/read", async () => {
  const roots: string[] = [], c = client({ prepareBuiltinSkills: async () => preparation(roots) });
  await c.start(); await initializeAndVerifyAccount(c, 1000); await c.afterInitializeBuiltinSkills(1000);
  expect(await c.request("test/calls")).toEqual(["initialize", "initialized", "skills/extraRoots/set", "skills/list", "account/read", "test/calls"]);
});
it("an expired callback cannot send late RPCs after child replacement", async () => {
  const roots: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let late!: Promise<void>;
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); return { ...p, afterInitialize: port => {
    late = gate.then(() => p.afterInitialize(port)); return late;
  } }; } });
  await c.start(); await c.request("initialize", {}, { timeoutMs: 1000 }); c.notify("initialized");
  const originalPid = c.pid!;
  // This budget also covers the replacement child's initialize handshake.
  await c.afterInitializeBuiltinSkills(1000);
  expect(c.pid).not.toBe(originalPid);
  expect(() => process.kill(originalPid, 0)).toThrow();
  const failed = expect(late).rejects.toThrow("Codex builtin callback invalidated"); release(); await failed;
  expect(await c.request("test/calls")).not.toContain("skills/extraRoots/set");
  // Both children append here; a late RPC must reach neither generation.
  expect(fs.readFileSync(join(home, "requests"), "utf8")).not.toContain("skills/extraRoots/set");
});
it("a real spawn error with no PID releases its unbound snapshot", async () => {
  const roots: string[] = [], c = client({ prepareBuiltinSkills: async () => preparation(roots), spawnImpl: (cmd, args, opts) => spawn(args.includes("app-server") ? join(home, "missing") : cmd, args, opts) });
  await expect(c.start()).rejects.toThrow();
  await vi.waitFor(() => expect(fs.existsSync(roots[0]!)).toBe(false));
});

it("preparation refusal degrades to ordinary Codex, as does no callback", async () => {
  const spawnImpl = vi.fn((cmd: string, args: readonly string[], opts: import("node:child_process").SpawnOptions) => spawn(cmd, args, opts));
  const refused = client({ spawnImpl, prepareBuiltinSkills: async () => { throw new Error("policy refusal"); } });
  await refused.start(); await initializeAndVerifyAccount(refused, 1000);
  expect(spawnImpl.mock.calls.some(([, args]) => args.includes("app-server"))).toBe(true);
  const ordinary = client(); await ordinary.start(); await initializeAndVerifyAccount(ordinary, 1000);
  expect(await ordinary.request("test/calls")).toEqual(["initialize", "initialized", "account/read", "test/calls"]);
});

it("a throwing post-spawn lease bind closes exactly the new child", async () => {
  let pid = 0;
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation([]); p.lease.abortNeverSpawned(); p.lease.bindChild = child => { pid = child.pid!; throw new Error("lease-bound"); }; return p; } });
  await expect(c.start()).rejects.toThrow("lease-bound");
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
});
function install(lease: ReturnType<typeof prepareBuiltinSnapshot>) {
  return (port: Parameters<typeof installCodexBuiltins>[0]) => installCodexBuiltins(port, join(home, "workspace"), lease.root, ["anycode-app-setup"]);
}
it.each([[false, false], [true, false], [false, true], [true, true]])("installation/recovery survives fresh/resume (%s) and ON/OFF (recovery=%s)", async (resume, recover) => {
  const roots: string[] = [];
  const opts = { ...options(), ...(recover ? { binaryArgs: [fake, "--bad-readback", "--reset-fail"] } : {}), bootstrap: { id: "codex" as const, adopt: () => {}, dispose: async () => {} }, workspace: join(home, "workspace"), broker: new IpcPermissionBroker(() => {}), persistOrchestrationThreadId: async () => {},
    prepareBuiltinSkills: async () => { const p = preparation(roots); return { lease: p.lease, afterInitialize: install(p.lease) }; } };
  const connected = resume ? await resumeCodexEngine({ ...opts, externalSessionRef: "thread" }) : await startCodexEngine(opts);
  try { const ctl = new OrchestrationController(connected.engine.orchestrationPolicy); expect(await ctl.apply(true, { preset: "ask" })).toBe(true); expect(await ctl.apply(false, { preset: "ask" })).toBe(true); expect(roots).toHaveLength(3); }
  finally { await connected.engine.dispose("session-close"); }
});
it.each(["reset", "reset-fail", "set-refuse"])("bad catalog/set recovers once without roots (%s)", async mode => {
  const resetFails = mode !== "reset";
  const roots: string[] = [], spawned: number[] = [];
  const c = client({ binaryArgs: [fake, "--bad-readback", ...(mode === "reset-fail" ? ["--reset-fail"] : mode === "set-refuse" ? ["--set-refuse"] : [])], configOverrides: ["features.multi_agent=false"], prepareBuiltinSkills: async () => { const p = preparation(roots); return { lease: p.lease, afterInitialize: install(p.lease) }; },
    spawnImpl: (cmd, args, opts) => { const child = spawn(cmd, args, opts); if (args.includes("app-server")) spawned.push(child.pid!); return child; } });
  const notice = vi.fn(); const off = c.observeNotifications(notice);
  await c.start(); await initializeAndVerifyAccount(c, 1000); expect(spawned).toHaveLength(resetFails ? 2 : 1);
  expect(await c.request("skills/list", { cwds: [join(home, "workspace")], forceReload: true })).toMatchObject({ roots: [], home: join(home, "codex") });
  expect(await c.request("config/read", {})).toMatchObject({ config: { features: { multi_agent: false } } });
  expect(roots).toHaveLength(1); expect(c.pid).toBe(spawned.at(-1));
  const iterator = c.notifications()[Symbol.asyncIterator](); c.notify("test/notify");
  expect((await iterator.next()).value).toMatchObject({ method: "test/notification" }); expect(notice).toHaveBeenCalledTimes(1);
  off(); c.notify("test/notify"); await iterator.next(); expect(notice).toHaveBeenCalledTimes(1); await c.close();
});
it("catalog validates metadata, omits native names and proves removal on bad readback", async () => {
  const cwd = join(home, "workspace"), root = join(home, "snapshot");
  const native = { name: "anycode-app-setup", path: "/foreign/SKILL.md", scope: "user", enabled: false };
  for (const mode of ["collision", "valid", "wrong", "incomplete", "reset-wrong", "refused-set"] as const) {
    let installed = false, sets = 0;
    const port = { request: vi.fn(async (method: string, params: unknown) => {
      if (method.endsWith("/set")) { sets++; if (mode === "refused-set") throw new Error("unsupported"); installed = (params as { extraRoots: string[] }).extraRoots.length > 0; return {}; }
      const app = { name: "anycode-app-setup", path: join(root, "skills/anycode-app-setup/SKILL.md"), scope: "user", enabled: true };
      return { data: [{ cwd, errors: mode === "incomplete" ? [{}] : [], skills: mode === "collision" ? [native] : (installed || (mode === "reset-wrong" && sets > 0)) ? [{ ...app, enabled: mode === "valid" }] : [] }] };
    }) };
    const run = installCodexBuiltins(port as never, cwd, root, [native.name]);
    if (mode === "reset-wrong" || mode === "refused-set") await expect(run).rejects.toThrow(); else await run;
    expect(sets).toBe(mode === "collision" || mode === "incomplete" ? 0 : mode === "valid" || mode === "refused-set" ? 1 : 2);
  }
});

it("native same-name suppresses only that app copy, without reading foreign bodies", async () => {
  const cwd = join(home, "workspace"), root = join(home, "sealed"), names = ["anycode-app-setup", "anycode-app-browser-preview"];
  const native = { name: names[0], path: "/foreign/unreadable/SKILL.md", scope: "repo", enabled: false };
  let roots: string[] = [];
  const port = { request: vi.fn(async (method: string, params: unknown) => {
    if (method.endsWith("/set")) { roots = (params as { extraRoots: string[] }).extraRoots; return {}; }
    return { data: [{ cwd, errors: [], skills: [native, ...roots.map(dir => ({ name: "anycode-app-browser-preview", path: join(dir, "SKILL.md"), enabled: true, scope: "user" }))] }] };
  }) };
  const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("no body reads"); });
  await installCodexBuiltins(port as never, cwd, root, names); expect(read).not.toHaveBeenCalled();
  expect(roots).toEqual([join(root, "skills", names[1]!)]);
});
it("closing during recovery retirement cancels the replacement", async () => {
  const spawned: number[] = [];
  const c = client({ prepareBuiltinSkills: async () => ({ ...preparation([]), afterInitialize: async () => { throw new Error("unknown catalog"); } }),
    spawnImpl: (cmd, args, opts) => { const child = spawn(cmd, args, opts); if (args.includes("app-server")) spawned.push(child.pid!); return child; } });
  await c.start(); await c.request("initialize", {}); c.notify("initialized");
  const transport = c as unknown as { teardown(child: unknown): Promise<void> }, original = transport.teardown.bind(c);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  vi.spyOn(transport, "teardown").mockImplementationOnce(async child => { entered(); await gate; await original(child); });
  const pending = c.afterInitializeBuiltinSkills(1000).then(() => "resolved", e => e.message);
  await ready; const closed = c.close(); release(); await closed;
  expect(await pending).toBe("unknown catalog"); expect(spawned).toHaveLength(1);
});
it("an unsupported native skills catalog continues without ever setting roots", async () => {
  const c = client({ binaryArgs: [fake, "--refuse"], prepareBuiltinSkills: async () => { const p = preparation([]); return { lease: p.lease, afterInitialize: install(p.lease) }; } });
  await c.start(); const pid = c.pid; await initializeAndVerifyAccount(c, 1000);
  expect(c.pid).toBe(pid); expect(await c.request("test/calls")).not.toContain("skills/extraRoots/set");
});
it("a reused bound lease kills the rejected child and preserves its original owner", async () => {
  const p = preparation([]), a = client({ prepareBuiltinSkills: async () => p });
  await a.start(); await initializeAndVerifyAccount(a, 1000);
  const b = client({ prepareBuiltinSkills: async () => p });
  await expect(b.start()).rejects.toThrow("lease-bound");
  expect(await a.request("test/calls")).toContain("skills/list"); expect(fs.existsSync(p.lease.root)).toBe(true);
  expect(() => process.kill(b.pid!, 0)).toThrow();
  await a.close(); await vi.waitFor(() => expect(fs.existsSync(p.lease.root)).toBe(false));
});
it.each(["cwd", "scope", "path", "enabled", "shape"])("an incompatible native catalog (%s) never installs app roots", async field => {
  const cwd = join(home, "workspace");
  const skill = { name: "native", path: "/foreign/SKILL.md", enabled: true, scope: "user", [field]: field === "path" ? "relative" : field === "enabled" ? "yes" : "incompatible" };
  const row = { cwd: field === "cwd" ? "/wrong" : cwd, errors: [], skills: [skill] };
  const request = vi.fn(async () => field === "shape" ? { data: [] } : { data: [row] });
  await installCodexBuiltins({ request } as never, cwd, "/sealed", ["anycode-app-setup"]);
  expect(request).toHaveBeenCalledTimes(1);
});
