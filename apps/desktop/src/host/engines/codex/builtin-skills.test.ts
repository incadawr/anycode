import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
else if(q.method==='skills/extraRoots/set') {if(!initialized)process.exit(4);roots=q.params.extraRoots;}
else if(q.method==='skills/list') {if(process.argv.includes('--timeout'))return;if(process.argv.includes('--refuse')){console.log(JSON.stringify({id:q.id,error:{code:-32601,message:'unsupported'}}));return;}result={roots,home:process.env.CODEX_HOME,skills:roots.flatMap(root=>fs.readdirSync(root).map(name=>({name,path:path.join(root,name,'SKILL.md'),body:fs.readFileSync(path.join(root,name,'SKILL.md'),'utf8')})))};}
else if(q.method==='account/read')result={account:{id:'synthetic'},requiresOpenaiAuth:false};
else if(q.method==='model/list')result={data:[],nextCursor:null};
else if(q.method==='config/read')result={config,layers:[]};
else if(q.method==='thread/read')result={thread:{id:'thread',turns:[]}};
else if(q.method==='thread/start'||q.method==='thread/resume') {if(!calls.includes('skills/list'))process.exit(5);result={thread:{id:'thread',turns:[]},model:'synthetic',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};}
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
it.each(["--refuse", "--timeout"])("post-initialize %s never reaches thread/start", async flag => {
  const roots: string[] = [];
  await expect(startCodexEngine({ ...options(), binaryArgs: [fake, flag], timeouts: { bootRpcMs: 500 },
    bootstrap: { id: "codex", adopt: () => {}, dispose: async () => {} }, workspace: join(home, "workspace"), broker: new IpcPermissionBroker(() => {}),
    prepareBuiltinSkills: async () => preparation(roots) })).rejects.toThrow();
  expect(fs.readFileSync(join(home, "requests"), "utf8")).not.toContain("thread/start");
  await vi.waitFor(() => expect(fs.existsSync(roots[0]!)).toBe(false));
});
it("close during preparation aborts the never-spawned lease", async () => {
  const roots: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); await gate; return p; } });
  const started = c.start(); await vi.waitFor(() => expect(roots).toHaveLength(1)); await c.close(); release();
  await expect(started).rejects.toThrow(); expect(c.pid).toBeNull(); expect(fs.existsSync(roots[0]!)).toBe(false);
});
it("a stale post-initialize callback cannot attach its root after close", async () => {
  const roots: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); return { ...p, afterInitialize: async (port: Parameters<typeof p.afterInitialize>[0]) => { await gate; await p.afterInitialize(port); } }; } });
  await c.start(); const init = initializeAndVerifyAccount(c, 1000).then(() => false, () => true);
  await c.request("test/calls"); await c.close(); release(); expect(await init).toBe(true);
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
it("an expired callback cannot send late RPCs on a still-live child", async () => {
  const roots: string[] = []; let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let late!: Promise<void>;
  const c = client({ prepareBuiltinSkills: async () => { const p = preparation(roots); return { ...p, afterInitialize: port => {
    late = gate.then(() => p.afterInitialize(port)); return late;
  } }; } });
  await c.start(); await c.request("initialize", {}, { timeoutMs: 1000 }); c.notify("initialized");
  await expect(c.afterInitializeBuiltinSkills(30)).rejects.toThrow("timed out");
  const failed = late.then(() => false, () => true); release(); expect(await failed).toBe(true);
  expect(await c.request("test/calls")).not.toContain("skills/extraRoots/set");
});
it("a real spawn error with no PID releases its unbound snapshot", async () => {
  const roots: string[] = [], c = client({ prepareBuiltinSkills: async () => preparation(roots), spawnImpl: (cmd, args, opts) => spawn(args.includes("app-server") ? join(home, "missing") : cmd, args, opts) });
  await expect(c.start()).rejects.toThrow();
  await vi.waitFor(() => expect(fs.existsSync(roots[0]!)).toBe(false));
});

it("preparation refusal stops before main spawn, and no callback means ordinary Codex", async () => {
  const spawnImpl = vi.fn((cmd: string, args: readonly string[], opts: import("node:child_process").SpawnOptions) => spawn(cmd, args, opts));
  const refused = client({ spawnImpl, prepareBuiltinSkills: async () => { throw new Error("policy refusal"); } });
  await expect(refused.start()).rejects.toThrow("policy refusal");
  expect(spawnImpl.mock.calls.every(([, args]) => !args.includes("app-server"))).toBe(true);
  const ordinary = client(); await ordinary.start(); await initializeAndVerifyAccount(ordinary, 1000);
  expect(await ordinary.request("test/calls")).toEqual(["initialize", "initialized", "account/read", "test/calls"]);
});
