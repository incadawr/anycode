import { verifiedAutomationRequest } from "./verified-automation-http.mjs";
import { openVerifiedWebSocket } from "./verified-websocket.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Only the browser process from this launcher may own the debugging listener. */
export function verifyCdpOwner({ listenerPids, browserPid, launcherPid, parentOf }) {
  if (!Number.isSafeInteger(browserPid) || browserPid <= 0 || !Number.isSafeInteger(launcherPid) || launcherPid <= 0 || browserPid === launcherPid) throw new Error("Invalid automation process identity");
  const owners = listenerPids.trim().split(/\s+/).filter(Boolean);
  if (!owners.length || owners.some(pid => !/^\d+$/.test(pid) || Number(pid) !== browserPid)) throw new Error("Debug listener belongs to another process");
  const visited = new Set();
  let current = browserPid;
  while (current !== launcherPid) {
    if (current <= 1 || visited.has(current) || visited.size >= 64) throw new Error("Browser is not a child of the launcher");
    visited.add(current);
    current = parentOf(current);
    if (!Number.isSafeInteger(current)) throw new Error("Cannot verify automation process ancestry");
  }
}

export function readCdpEndpoint(content) {
  const [portText, browserPath, ...rest] = content.trim().split(/\r?\n/);
  if (rest.length || !/^[1-9]\d{0,4}$/.test(portText ?? "") || Number(portText) > 65535 || !/^\/devtools\/browser\/[0-9a-f-]{36}$/i.test(browserPath ?? "")) throw new Error("Invalid debugging endpoint");
  return { port: Number(portText), browserPath };
}


/** Confirm the server side of this exact established TCP connection. */
export function verifyCdpPeer({ records, browserPid, port, localPort }) {
  const expected = `127.0.0.1:${port}->127.0.0.1:${localPort}`;
  let pid = null, found = false;
  for (const line of records.split(/\r?\n/)) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("n") && line.slice(1).split(" ")[0] === expected) {
      if (pid !== browserPid) throw new Error("Connected debug socket belongs to another process");
      found = true;
    }
  }
  if (!found) throw new Error("Cannot verify connected debug socket");
}

/** A private DevToolsActivePort plus process ownership ties the browser socket to this launch. */
export async function connectIsolatedCdp({ profile, env, launcher, wait, openSocket = openVerifiedWebSocket, run = execFileSync }) {
  if (env.REMOTE_DEBUGGING_PORT !== "0") throw new Error("A dynamically allocated debugging port is required");
  if (process.platform !== "darwin") throw new Error("Isolated CDP ownership verification is unavailable on this platform");
  const identity = await wait(() => { try { return JSON.parse(readFileSync(join(profile, "identity.json"), "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } });
  if (identity.nonce !== env.ANYCODE_SMOKE_IDENTITY || identity.desktopRoot !== realpathSync(env.ANYCODE_EXPECTED_DESKTOP_ROOT) || identity.userData !== realpathSync(join(profile, "user-data")) || identity.sessionData !== realpathSync(join(profile, "session-data"))) throw new Error("Automation identity mismatch");
  const endpoint = await wait(() => { try { return readCdpEndpoint(readFileSync(join(identity.sessionData, "DevToolsActivePort"), "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } });
  const listenerPids = run("/usr/sbin/lsof", ["-nP", `-iTCP:${endpoint.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout:5000 });
  verifyCdpOwner({ listenerPids, browserPid: identity.pid, launcherPid: launcher.pid, parentOf: pid => Number(run("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding:"utf8", timeout:5000 }).trim()) });
  const ws = await openSocket({ port: endpoint.port, path: endpoint.browserPath, verifyPeer: localPort => {
    const records = run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${endpoint.port}`, "-sTCP:ESTABLISHED", "-Fpn"], { encoding:"utf8", timeout:5000 });
    verifyCdpPeer({records, browserPid:identity.pid, port:endpoint.port, localPort});
  } });
  let nextId = 0;
  let sessionId;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error("Browser automation command failed")) : entry.resolve(message.result);
  };
  function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Browser automation command timed out")); }, 10000);
      pending.set(id, {resolve, reject, timer});
      ws.send(JSON.stringify({id, method, params, ...(!method.startsWith("Target.") && !method.startsWith("Browser.") && sessionId ? {sessionId} : {})}));
    });
  }
  try {
    const target = await wait(async () => (await call("Target.getTargets")).targetInfos.find(item => item.type === "page" && !item.url.startsWith("devtools://")));
    sessionId = (await call("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId;
    if (!sessionId) throw new Error("Cannot attach to the verified page");
    const automation = (info, path, method = "GET", body) => verifiedAutomationRequest({port:info.port, token:info.token, path, method, body, verifyPeer: localPort => {
      const records = run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${info.port}`, "-sTCP:ESTABLISHED", "-Fpn"], { encoding:"utf8", timeout:5000 });
      verifyCdpPeer({records, browserPid:identity.pid, port:info.port, localPort});
    }});
    return { ws, call, automation, pid:identity.pid };
  } catch (error) { ws.close(); throw error; }
}
