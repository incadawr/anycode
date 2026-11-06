import { describe, expect, it } from "vitest";
import { parseSessionPeerRequest } from "./session-peers.js";

const requests = [
  { requestId: "r", operation: "list", input: { limit: 20 } },
  { requestId: "r", operation: "open", input: { firstMessage: "hello", engine: "core" } },
  { requestId: "r", operation: "send", input: { sessionId: "peer", payload: "hello", reply: "on_turn_end" } },
  { requestId: "r", operation: "who_edits", input: { path: "src/main.ts" } },
];

describe("session peer request parser", () => {
  it.each(requests)("accepts a narrow $operation request", request => {
    expect(parseSessionPeerRequest(request)).toEqual(request);
  });
  it.each(requests)("rejects forged authority in $operation", request => {
    for (const key of ["sender", "principal", "chainId", "hop", "bypassApproval", "unknown"]) {
      expect(parseSessionPeerRequest({ ...request, [key]: "forged" })).toBeNull();
      expect(parseSessionPeerRequest({ ...request, input: { ...request.input, [key]: "forged" } })).toBeNull();
    }
  });
  it.each([
    null, [], {}, { requestId: "r", operation: "unknown", input: {} },
    { requestId: "", operation: "list", input: {} },
    { requestId: "r", operation: "list", input: { limit: 51 } },
    { requestId: "r", operation: "list", input: { limit: 1.5 } },
    { requestId: "r", operation: "send", input: { payload: "" } },
    { requestId: "r", operation: "send", input: { payload: "x".repeat(32001) } },
    { requestId: "r", operation: "open", input: { engine: "shell" } },
    { requestId: "r", operation: "who_edits", input: { path: "" } },
  ])("rejects invalid wire input", request => {
    expect(parseSessionPeerRequest(request)).toBeNull();
  });
  it("accepts an explicit reply without a caller-selected target", () => {
    const request = { requestId: "r", operation: "send", input: { replyTo: "m", payload: "answer" } };
    expect(parseSessionPeerRequest(request)).toEqual(request);
    expect(parseSessionPeerRequest({ ...request, input: { payload: "answer" } })).toBeNull();
  });
});
