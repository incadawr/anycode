import { describe, expect, it } from "vitest";
import { hostFailure } from "./host-failure.js";

describe("host failure summaries", () => {
  it("keeps only fixed error classes and system codes", () => {
    const secret = "secret-token-/private/credentials-https://example.test";
    for (const stderr of ["", secret, `\u001b[31mTypeError: EACCES ${secret}\u0000`, `${"x".repeat(40000)}\nError: ENOENT ${secret}`]) {
      const failure = hostFailure("per_tab_crash_loop", stderr, 7, "SIGSEGV");
      expect(failure.message.length).toBeLessThanOrEqual(256);
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(failure).toMatchObject({ exitCode: 7, signal: "SIGSEGV" });
    }
    expect(hostFailure("per_tab_crash_loop", `\u001b[31mTypeError: EACCES ${secret}\u001b[0m`).message).toContain("TypeError, EACCES");
    expect(hostFailure("global_storm", "TypeError: EACCES secret").message).toContain("TypeError, EACCES");
    expect(hostFailure("spawn_refused", "", -1, "SIGSECRET")).toEqual({ code: "spawn_refused", message: "Session host could not start." });
  });
});
