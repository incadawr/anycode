/**
 * "Network may be back" hint contract (Taskana 4772): the parentPort message
 * type the main process posts to a host when the OS reports connectivity
 * (net `online`, power `resume`, screen `unlock`), and the Retry-now control
 * the renderer sends. ZERO imports by construction, like shared/browser-access.ts:
 * the sandboxed preload bundles this module, so it may not pull anything in.
 */

/** parentPort message type main -> host: wake any turn parked in "waiting for network". */
export const NETWORK_HINT_HOST_MESSAGE_TYPE = "anycode:network-hint";
