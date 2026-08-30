/**
 * IPC registration ONLY for the Vision panel's "Probe" button (TASK.198 срез
 * E2). This file owns the one `ipcMain` import the feature needs and does
 * NOTHING else — no request validation, no candidate resolution, no error
 * classification, no try/catch. Every branch of that logic lives in
 * recognizer-probe.ts's `handleRecognizerProbeRequest`, tested there without
 * mocking Electron, exactly the split main/network-ipc.ts's own
 * `registerNetworkIpc` established for the proxy-check probe (TASK.141 §6) —
 * this file is stricter still: `registerNetworkIpc` keeps its own request
 * parser and handler function; here even those live in the pure module, so
 * this registrator really is a literal pass-through and would gain nothing
 * from its own test.
 */

import { ipcMain } from "electron";
import { RECOGNIZER_PROBE_CHANNEL } from "../shared/recognizer.js";
import { handleRecognizerProbeRequest, type RecognizerProbeDeps } from "./recognizer-probe.js";

export type { RecognizerProbeDeps };

export function registerRecognizerProbeIpc(deps: RecognizerProbeDeps): void {
  ipcMain.handle(RECOGNIZER_PROBE_CHANNEL, (_event, raw: unknown) => handleRecognizerProbeRequest(deps, raw));
}
