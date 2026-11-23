import { parentPort, workerData } from "node:worker_threads";
import { loadCodeModeRuntime, runInQuickJS } from "./runtime.js";
import type { ScriptReply, WorkerCommand, WorkerEvent } from "./runtime.js";

const port = parentPort;
if (!port) throw new Error("Code Mode worker requires a parent port");

const emit = (event: WorkerEvent) => port.postMessage(event);

let controller: AbortController | undefined;
let pending: {
  resolve: (reply: ScriptReply) => void;
  reject: (error: Error) => void;
} | undefined;

async function execute(source: string, cwd: string) {
  controller = new AbortController();
  try {
    const result = await runInQuickJS(source, cwd, {
      signal: controller.signal,
      dispatch: (tool, input) => new Promise((resolve, reject) => {
        pending = { resolve, reject };
        emit({ type: "dispatch", tool, input });
      }),
    }, workerData as BigInt64Array);
    emit({ type: "result", result });
  } catch {
    emit({ type: "failed" });
  } finally {
    pending = undefined;
    controller = undefined;
  }
}

port.on("message", (command: WorkerCommand) => {
  switch (command.type) {
    case "run":
      void execute(command.source, command.cwd);
      break;
    case "reply":
      pending?.resolve(command.reply);
      pending = undefined;
      break;
    case "dispatch_failed":
      pending?.reject(new Error(command.message));
      pending = undefined;
      break;
    case "abort":
      controller?.abort();
      break;
  }
});

try {
  await loadCodeModeRuntime();
  emit({ type: "ready" });
} catch {
  emit({ type: "failed" });
}
