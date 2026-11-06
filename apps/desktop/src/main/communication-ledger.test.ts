import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommunicationLedger, writePrivateFile, type CommunicationRecord } from "./communication-ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "communication-ledger-"));
  roots.push(root);
  return join(root, "communication.json.messages");
}
const record = (id: string, state: CommunicationRecord["state"] = "acknowledged"): CommunicationRecord => ({
  envelope: { messageId: id, sender: "authenticated-local-supervisor", recipientSessionId: "recipient", payload: "hello", mode: "next_turn", kind: "agent_message", createdAt: "2026-01-01T00:00:00.000Z" },
  state, detail: "transport accepted", idempotencyKey: `key-${id}`, workspace: "/workspace", hostPid: 42,
});

describe("communication ledger", () => {
  it("serializes two clients' snapshots behind the same durability barrier", async () => {
    const path = await fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const writer = vi.fn(async (file: string, text: string) => {
      if (JSON.parse(text).length === 1) { entered(); await held; }
      await writePrivateFile(file, text);
    });
    const ledger = await createCommunicationLedger(path, writer);
    const firstClient = ledger.persist;
    const secondClient = ledger.persist;
    ledger.messages.set("one", record("one"));
    const first = firstClient();
    await writing;
    ledger.messages.set("two", record("two"));
    const second = secondClient();
    let flushed = false;
    const flush = ledger.flush().then(() => { flushed = true; });
    try {
      await Promise.resolve();
      expect(writer).toHaveBeenCalledTimes(2); // initial empty ledger, then the held snapshot
      expect(flushed).toBe(false);
      expect(await readFile(path, "utf8")).toBe("[]");
    } finally { release(); }
    await Promise.all([first, second, flush]);
    expect(writer.mock.calls.map(([, text]) => JSON.parse(text).length)).toEqual([0, 1, 2]);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify([record("one"), record("two")]));
  });

  it("rejects the acceptance barrier on write failure and lets later writes recover", async () => {
    const path = await fixture();
    const writer = vi.fn(writePrivateFile);
    const ledger = await createCommunicationLedger(path, writer);
    ledger.messages.set("one", record("one"));
    writer.mockRejectedValueOnce(new Error("disk unavailable"));
    const dispatch = vi.fn();
    await expect(ledger.persist().then(dispatch)).rejects.toThrow("disk unavailable");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(ledger.flush()).rejects.toThrow("disk unavailable");
    expect(await readFile(path, "utf8")).toBe("[]");
    await ledger.persist();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([record("one")]);
  });

  it.each(["{broken", '{"not":"an array"}'])("does not overwrite malformed legacy input: %s", async (text) => {
    const path = await fixture();
    await writeFile(path, text);
    const writer = vi.fn(writePrivateFile);
    await expect(createCommunicationLedger(path, writer)).rejects.toThrow();
    expect(writer).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("preserves legacy bytes and settled ACKs; only pending dispatch becomes unknown", async () => {
    const path = await fixture();
    const records = [record("ack"), record("reject", "rejected"), record("unknown", "unknown"), record("queue", "queued")];
    const text = JSON.stringify(records);
    await writeFile(path, text);
    const ledger = await createCommunicationLedger(path);
    expect(await readFile(path, "utf8")).toBe(text);
    expect(ledger.findByIdempotencyKey("key-ack")).toEqual(records[0]);
    expect(ledger.findByIdempotencyKey("missing")).toBeUndefined();
    ledger.messages.set("pending", { ...record("pending"), detail: "Dispatch pending" });
    await ledger.persist();
    const reopened = await createCommunicationLedger(path);
    expect(reopened.messages.get("pending")).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
    expect([...reopened.messages.values()].slice(0, 4)).toEqual(records);
  });

  it("keeps the legacy capacity boundary without evicting settled records", async () => {
    const ledger = await createCommunicationLedger(await fixture());
    for (let i = 0; i < 9999; i++) ledger.messages.set(String(i), record(String(i)));
    expect(ledger.isFull()).toBe(false);
    ledger.messages.set("last", record("last"));
    expect(ledger.isFull()).toBe(true);
    expect(ledger.messages.get("0")).toEqual(record("0"));
  });
});
