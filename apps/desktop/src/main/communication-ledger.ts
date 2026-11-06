import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { CommunicationPrincipal } from "./communication-dispatch.js";
import type { AgentDelivery } from "../shared/communication.js";

export type CommunicationRecord = AgentDelivery & { idempotencyKey?: string; principal?: CommunicationPrincipal; workspace?: string; hostPid?: number | null };

/** Atomic private write (mode 0600, temp file + rename); the default ledger and discovery writer. */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** One legacy record store and write queue, shared by its callers. */
export async function createCommunicationLedger(
  ledgerFile: string,
  writeLedger: (path: string, text: string) => Promise<void> = writePrivateFile,
) {
  const messages = new Map<string, CommunicationRecord>();
  try {
    const prior = JSON.parse(await readFile(ledgerFile, "utf8")) as CommunicationRecord[];
    for (const record of prior) {
      // GitHub #19: a renderer reload never restarts this server, and an app
      // restart must NOT downgrade a settled delivery merely because the
      // runtime restarted — acknowledged/rejected/unknown (and their detail)
      // survive unchanged. Only a LOST host generation downgrades a still-
      // queued record later, in `reconcile` (no automatic model replay).
      if (record.envelope?.messageId) {
        if (record.detail === "Dispatch pending") { record.state = "unknown"; record.detail = "Host response unavailable; do not blindly resend"; }
        messages.set(record.envelope.messageId, record);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(ledgerFile), { recursive: true, mode: 0o700 });
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify([...messages.values()]);
    writes = writes.catch(() => {}).then(async () => {
      await writeLedger(ledgerFile, snapshot);
    });
    return writes;
  };
  await persist();
  return {
    messages,
    persist,
    flush: () => writes,
    findByIdempotencyKey: (key: string) => [...messages.values()].find((record) => record.idempotencyKey === key),
    isFull: () => messages.size >= 10000,
  };
}
