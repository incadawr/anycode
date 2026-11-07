import { Worker } from "node:worker_threads";
import { isAbsolute, basename, dirname } from "node:path";
import { ENGINE_BUILTIN_SKILLS, type EngineBuiltinSkillId } from "../../shared/engine-skills.js";

export type BuiltinPolicyReason = "enabled" | "disabled" | "invalid-config" | "unsafe-file" |
  "too-large" | "too-deep" | "io-error" | "timeout" | "worker-error" | "unsupported";
export type BuiltinPolicy = Record<EngineBuiltinSkillId, { enabled: boolean; reason: BuiltinPolicyReason }>;
export interface BuiltinPolicyInput {
  /** Host-resolved .anycode/config.json locations only; never renderer input. */
  userConfigPath: string;
  projectConfigPath: string;
  projectTrusted: boolean;
  ids: readonly EngineBuiltinSkillId[];
}
const ids = ENGINE_BUILTIN_SKILLS.map(entry => entry.id);
const failures = ["invalid-config", "unsafe-file", "too-large", "too-deep", "io-error", "unsupported"] as const;
function denied(reason: BuiltinPolicyReason): BuiltinPolicy {
  return Object.fromEntries(ids.map(id => [id, { enabled: false, reason }])) as BuiltinPolicy;
}

/** Fresh launch decision only. No discovery, config bytes or raw errors leave the worker.
 * Leaf checks do not prove ancestor containment or protect against same-UID writers.
 */
export async function readBuiltinPolicy(input: BuiltinPolicyInput): Promise<BuiltinPolicy> {
  if (process.platform === "win32") return denied("unsupported");
  const paths = [...new Set([input.userConfigPath, ...(input.projectTrusted ? [input.projectConfigPath] : [])])];
  if (input.ids.length !== ids.length || ids.some(id => !input.ids.includes(id)) ||
      paths.some(path => !isAbsolute(path) || basename(path) !== "config.json" || basename(dirname(path)) !== ".anycode")) {
    return denied("invalid-config");
  }
  return new Promise(resolve => {
    let worker: Worker | undefined;
    let finished = false;
    const finish = (result: BuiltinPolicy) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Do not wait for an OS-stalled filesystem operation to complete.
      void worker?.terminate().catch(() => {});
      resolve(result);
    };
    const timer = setTimeout(() => finish(denied("timeout")), 5000);
    try {
      worker = new Worker(new URL("./builtin-policy-worker.js", import.meta.url), {
        workerData: { paths, ids }, stdout: true, stderr: true,
      });
      // Discard output; never forward a worker's raw diagnostic or config field.
      worker.stdout?.resume(); worker.stderr?.resume();
      worker.once("error", () => finish(denied("worker-error")));
      worker.once("exit", () => finish(denied("worker-error")));
      worker.once("message", (message: unknown) => {
        if (!message || typeof message !== "object") return finish(denied("worker-error"));
        const value = message as { error?: unknown; disabled?: unknown };
        if (failures.includes(value.error as typeof failures[number])) {
          return finish(denied(value.error as BuiltinPolicyReason));
        }
        if (!Array.isArray(value.disabled) || value.disabled.some(id => !ids.includes(id))) {
          return finish(denied("worker-error"));
        }
        const disabled = value.disabled;
        finish(Object.fromEntries(ids.map(id => [id, {
          enabled: !disabled.includes(id), reason: disabled.includes(id) ? "disabled" : "enabled",
        }])) as BuiltinPolicy);
      });
    } catch { finish(denied("worker-error")); }
  });
}
