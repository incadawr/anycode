import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSmokeEnv } from "../../scripts/model-overrides-smoke-env.mjs";
import { connectIsolatedCdp, readCdpEndpoint, verifyCdpOwner, verifyCdpPeer } from "../../scripts/isolated-cdp.mjs";
import { createRolesSmokeDirs } from "../../scripts/roles-smoke-dirs.mjs";
import { initializeIsolatedSmoke } from "./isolated-smoke.js";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive:true, force:true }); });
const browserPath = "/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";
const parentOf = (pid: number) => ({300:200, 200:100} as Record<number, number>)[pid];

describe("isolated browser ownership", () => {
  it("accepts only the launched browser as the unique listener and child", () => {
    expect(() => verifyCdpOwner({listenerPids:"300\n300\n", browserPid:300, launcherPid:100, parentOf})).not.toThrow();
    expect(() => verifyCdpOwner({listenerPids:"999\n", browserPid:300, launcherPid:100, parentOf})).toThrow();
    expect(() => verifyCdpOwner({listenerPids:"300\n999\n", browserPid:300, launcherPid:100, parentOf})).toThrow();
    expect(() => verifyCdpOwner({listenerPids:"300\n", browserPid:300, launcherPid:100, parentOf:() => 1})).toThrow();
  });
  it("rejects a foreign established peer even after listener ownership passed", () => {
    const base = {browserPid:300, port:54321, localPort:45678};
    expect(() => verifyCdpPeer({...base, records:"p300\nn127.0.0.1:54321->127.0.0.1:45678\n"})).not.toThrow();
    expect(() => verifyCdpPeer({...base, records:"p999\nn127.0.0.1:54321->127.0.0.1:45678\n"})).toThrow("another process");
    expect(() => verifyCdpPeer({...base, records:"p300\nn127.0.0.1:54321->127.0.0.1:11111\n"})).toThrow("Cannot verify");
  });
  it("only accepts a browser endpoint from an allocated port", () => {
    expect(readCdpEndpoint(`54321\n${browserPath}\n`)).toEqual({port:54321, browserPath});
    for (const value of [`0\n${browserPath}`, `9222\n/devtools/page/foreign`, `123\nhttp://elsewhere`, `65536\n${browserPath}`]) expect(() => readCdpEndpoint(value)).toThrow();
  });
  it.runIf(process.platform === "darwin")("does not connect to an occupied port or a foreign endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "anycode-cdp-test-")); roots.push(root);
    mkdirSync(join(root, "user-data")); mkdirSync(join(root, "session-data"));
    const env = buildSmokeEnv({}, root, 0, join(root, "unavailable-engine"));
    writeFileSync(join(root, "identity.json"), JSON.stringify({pid:300, nonce:env.ANYCODE_SMOKE_IDENTITY, desktopRoot:realpathSync(env.ANYCODE_EXPECTED_DESKTOP_ROOT!), userData:realpathSync(join(root,"user-data")), sessionData:realpathSync(join(root,"session-data"))}));
    // Electron writes the endpoint beneath sessionData, independently of userData.
    writeFileSync(join(root, "session-data", "DevToolsActivePort"), `54321\n${browserPath}\n`);
    writeFileSync(join(root, "user-data", "DevToolsActivePort"), "invalid stale endpoint");
    const socket = vi.fn();
    const wait = async (fn: () => unknown) => fn();
    const badIdentity = {...env, ANYCODE_SMOKE_IDENTITY:"wrong-nonce"};
    await expect(connectIsolatedCdp({profile:root, env:badIdentity, launcher:{pid:100}, wait, openSocket:socket, run:vi.fn()})).rejects.toThrow("identity mismatch");
    expect(socket).not.toHaveBeenCalled();
    const run = vi.fn(() => "999\n");
    await expect(connectIsolatedCdp({profile:root, env, launcher:{pid:100}, wait, openSocket:socket, run})).rejects.toThrow("another process");
    expect(socket).not.toHaveBeenCalled();
    writeFileSync(join(root, "session-data", "DevToolsActivePort"), "54321\n/devtools/page/foreign\n");
    await expect(connectIsolatedCdp({profile:root, env, launcher:{pid:100}, wait, openSocket:socket, run})).rejects.toThrow("Invalid debugging endpoint");
    expect(socket).not.toHaveBeenCalled();
    writeFileSync(join(root, "session-data", "DevToolsActivePort"), `54321\n${browserPath}\n`);
    const sent: Array<Record<string, unknown>> = [];
    let connectedUrl = "";
    const openSocket = async ({port, path, verifyPeer}: {port:number; path:string; verifyPeer:(localPort:number)=>void}) => {
      connectedUrl = `ws://127.0.0.1:${port}${path}`;
      verifyPeer(45678);
      return {
        onmessage: undefined as undefined | ((event:{data:string}) => void),
        send(data:string) {
          const message = JSON.parse(data); sent.push(message);
          const result = message.method === "Target.getTargets" ? {targetInfos:[{type:"page", url:"http://localhost", targetId:"page-1"}]} : message.method === "Target.attachToTarget" ? {sessionId:"session-1"} : {ok:true};
          queueMicrotask(() => this.onmessage?.({data:JSON.stringify({id:message.id, result})}));
        },
        close() {},
      };
    };
    const validRun = (command:string, args:string[]) => command === "/usr/sbin/lsof" ? (args.includes("-Fpn") ? "p300\nn127.0.0.1:54321->127.0.0.1:45678\n" : "300\n") : args.at(-1) === "300" ? "200\n" : "100\n";
    const cdp = await connectIsolatedCdp({profile:root, env, launcher:{pid:100}, wait, openSocket, run:validRun});
    await cdp.call("Runtime.evaluate", {expression:"1"});
    expect(connectedUrl).toBe(`ws://127.0.0.1:54321${browserPath}`);
    expect(sent.at(-1)).toMatchObject({method:"Runtime.evaluate", sessionId:"session-1"});
    await cdp.call("Page.captureScreenshot", {format:"png"}, "preview-session");
    expect(sent.at(-1)).toMatchObject({method:"Page.captureScreenshot", sessionId:"preview-session"});
    await cdp.call("Runtime.evaluate", {expression:"2"});
    expect(sent.at(-1)).toMatchObject({method:"Runtime.evaluate", sessionId:"session-1"});
    cdp.ws.close();
    env.REMOTE_DEBUGGING_PORT = "9222";
    await expect(connectIsolatedCdp({profile:root, env, launcher:{pid:100}, wait, openSocket:socket, run})).rejects.toThrow("dynamically allocated");
  });
});

it("places the roles workspace outside its profile and passes the strict startup gate", () => {
  const {profile, workspace} = createRolesSmokeDirs(); roots.push(profile, workspace);
  expect(relative(profile, workspace).startsWith("..")).toBe(true);
  writeFileSync(join(profile, "unavailable-engine"), "#!/bin/sh\nexit 1\n", {mode:0o700});
  writeFileSync(join(profile, "settings.json"), "{}");
  const env = buildSmokeEnv({}, profile, 0, join(profile, "unavailable-engine"));
  const paths: Record<string, string> = {};
  const app = {isPackaged:false, commandLine:{hasSwitch:() => true, getSwitchValue:() => "0"}, getAppPath:() => env.ANYCODE_EXPECTED_DESKTOP_ROOT!, setPath:(name:string, path:string) => { paths[name] = path; }, getPath:(name:string) => paths[name]!};
  expect(initializeIsolatedSmoke(app, env)).toBe(true);
});
