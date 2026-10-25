/**
 * Real child-process adapter for the service supervisor (Taskana 4750a). It
 * wraps `node:child_process.spawn` behind the supervisor's `ServiceProcess`
 * port and owns the tree-kill policy:
 *  - POSIX: the child leads its own process group (`detached: true`); a tree
 *    kill sends SIGTERM to the group, then SIGKILL after SERVICE_KILL_GRACE_MS
 *    if the leader is still alive.
 *  - win32: `taskkill /pid N /T /F` takes the whole tree down.
 * `kill` never throws (an already-gone process is the normal case).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { SERVICE_KILL_GRACE_MS, type ServiceProcess, type ServiceSpawnSpec } from "./service-supervisor.js";

export function spawnServiceProcess(spec: ServiceSpawnSpec): ServiceProcess {
  const child: ChildProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    windowsHide: true,
    stdio: spec.stdio,
    detached: spec.detached,
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // group already gone
    }
  };

  return {
    pid: child.pid,
    onStdout(cb) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => cb(chunk));
    },
    onStderr(cb) {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => cb(chunk));
    },
    onExit(cb) {
      child.on("exit", (code, signal) => {
        if (killTimer !== undefined) clearTimeout(killTimer);
        cb(code, signal);
      });
    },
    onError(cb) {
      child.on("error", (error) => cb(error));
    },
    kill(tree: boolean): void {
      try {
        if (tree && process.platform === "win32" && child.pid !== undefined) {
          execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => undefined);
          return;
        }
        if (tree && spec.detached && child.pid !== undefined) {
          signalGroup("SIGTERM");
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) signalGroup("SIGKILL");
          }, SERVICE_KILL_GRACE_MS);
          killTimer.unref?.();
          return;
        }
        child.kill("SIGTERM");
      } catch {
        // never throws: a dead process is the expected state here
      }
    },
  };
}
