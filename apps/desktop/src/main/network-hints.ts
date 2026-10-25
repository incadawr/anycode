/**
 * OS connectivity hints for the host processes (Taskana 4772). The main process
 * turns three OS signals into one parentPort message: net `online` (the network
 * came back, e.g. Wi-Fi on), power `resume` (the lid opened), and screen
 * `unlock-screen`. Each listener is persistent and registered once, so every
 * hint reaches the tabs. The host turns the hint into an immediate reachability
 * probe. Pure and dependency-injected so the wiring is testable without Electron.
 */

import { NETWORK_HINT_HOST_MESSAGE_TYPE } from "../shared/network-hints.js";

type HintListener = () => void;

/**
 * The `net` slice used here: `online` only. Electron 43's typings do not declare
 * the event on the `net` module (it is an EventEmitter at runtime), so the
 * methods are optional and guarded: a missing one just means no net hint.
 */
export interface NetHintSource {
  on?(event: "online", listener: HintListener): unknown;
  removeListener?(event: "online", listener: HintListener): unknown;
}

/** The `powerMonitor` slice used here: `resume` and `unlock-screen`. */
export interface PowerHintSource {
  on(event: "resume" | "unlock-screen", listener: HintListener): unknown;
  removeListener(event: "resume" | "unlock-screen", listener: HintListener): unknown;
}

export interface NetworkHintDeps {
  net: NetHintSource;
  powerMonitor: PowerHintSource;
  /** Posts one message to every live tab host. */
  postAll(message: { type: string }): void;
}

/** Attaches the forwarders; returns a detach function that removes all three listeners. */
export function attachNetworkHintForwarders(deps: NetworkHintDeps): () => void {
  const hint: HintListener = () => deps.postAll({ type: NETWORK_HINT_HOST_MESSAGE_TYPE });
  deps.net.on?.("online", hint);
  deps.powerMonitor.on("resume", hint);
  deps.powerMonitor.on("unlock-screen", hint);
  return () => {
    deps.net.removeListener?.("online", hint);
    deps.powerMonitor.removeListener("resume", hint);
    deps.powerMonitor.removeListener("unlock-screen", hint);
  };
}
