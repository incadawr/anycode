#!/usr/bin/env node
/**
 * Test-only double for the `claude` CLI, driven by main/claude-doctor.test.ts.
 * Never shipped, never invoked by product code — argv flags select a scripted
 * behavior. Speaks exactly the two surfaces main/claude-doctor.ts touches:
 * `--version` (a single stdout line) and the auth-probe's ONE
 * `control_request{subtype:"initialize"}` -> `control_response` exchange over
 * stream-json NDJSON on stdin/stdout. Never writes anything under a
 * `projects/**` directory (it has no model to talk to) — this is itself part
 * of the test-hazard (a) discriminator: a real doctor run against this stub
 * cannot possibly create a `.jsonl`, so that assertion is only meaningful
 * against the REAL system binary (see main/claude-doctor.test.ts's live-gated
 * block).
 */
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

if (args[0] === "--version") {
  if (flag("--hang-version")) {
    setInterval(() => {}, 1_000);
  } else if (flag("--bad-version")) {
    process.stdout.write("2.1.100 (Claude Code)\n");
    process.exit(0);
  } else if (flag("--malformed-version")) {
    process.stdout.write("not-a-version\n");
    process.exit(0);
  } else if (flag("--nonzero-exit")) {
    process.exit(1);
  } else {
    process.stdout.write("2.1.212 (Claude Code)\n");
    process.exit(0);
  }
} else {
  // Auth-probe mode (`-p --input-format stream-json ...`): read exactly one
  // control_request{subtype:"initialize"}, answer with a scripted account.
  const signedOut = flag("--signed-out");
  const noResponse = flag("--no-response");
  const badRequestId = flag("--bad-request-id");
  const rejectInit = flag("--reject-init");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "control_request" && msg.request && msg.request.subtype === "initialize") {
      if (noResponse) return; // never answer -> the doctor's init-handshake timeout fires
      const requestId = badRequestId ? "00000000-0000-0000-0000-000000000000" : msg.request_id;
      if (rejectInit) {
        process.stdout.write(
          `${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "simulated initialize rejection" } })}\n`,
        );
        return;
      }
      // Live shape (w0-13-authprobe-signedin.jsonl): un-gated email/organization/
      // subscriptionType alongside tokenSource. These sentinel strings are what
      // main/claude-doctor.test.ts's sentinel-leak PoC asserts are PRESENT here
      // and ABSENT from the doctor's returned report.
      const account = signedOut
        ? { tokenSource: "none", apiProvider: "firstParty" }
        : {
            email: "sentinel-custody@example.com",
            organization: "Sentinel Org",
            subscriptionType: "Claude Max",
            tokenSource: "oauth",
            apiProvider: "firstParty",
          };
      process.stdout.write(
        `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { account } } })}\n`,
      );
    }
  });
}
