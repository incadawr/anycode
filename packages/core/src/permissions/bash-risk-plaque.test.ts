/**
 * Taskana 4070: the shared classification-to-plaque mapping, born in the
 * desktop PermissionModal (7d633a64, hardened by 4ebfbe12) and moved VERBATIM
 * to core so the CLI terminal broker, the desktop modal and the Codex
 * commandExecution approvals render the SAME note. These pins hold the move to
 * behaviour-identical: the exact copies, the three-way split, the fail-closed
 * input discipline, and the basename/wrapper hardening from 4ebfbe12.
 */
import { describe, expect, it } from "vitest";
import {
  BASH_RISK_PLAQUE,
  WRITE_CAPABLE_BINARIES,
  bashRiskFacts,
  bashRiskPlaque,
  bashWriteCapablePlaque,
  isPlaqueCommandLineTool,
} from "./bash-risk-plaque.js";

describe("bash-risk-plaque — copy pins (moved verbatim from the desktop modal)", () => {
  it("the three plaque strings are byte-identical to the desktop originals", () => {
    expect(BASH_RISK_PLAQUE.readOnly).toBe(
      "This exact command line is provably read-only — every segment passed the same classifier that auto-allows in Auto mode. It asks only because of the session mode, a hook, or an engine bridge.",
    );
    expect(bashWriteCapablePlaque("rm")).toBe(
      "This command runs rm, which can write or execute — the classifier cannot prove it read-only. Allow only if you intended this exact command.",
    );
    expect(BASH_RISK_PLAQUE.unknownBinary).toBe(
      "This command's binary is not on AnyCode's read-only list, so it asks. Not-on-the-list is not a verdict of danger; review the exact command before allowing.",
    );
  });

  it("the write-capable set keeps the 4ebfbe12 wrappers/shells/privilege-escalator hardening", () => {
    for (const binary of ["sudo", "doas", "env", "bash", "sh", "docker", "kubectl", "rm", "pnpm"]) {
      expect(WRITE_CAPABLE_BINARIES.has(binary)).toBe(true);
    }
  });
});

describe("bash-risk-plaque — the three-way split", () => {
  it("proven read-only line → readOnly plaque (single command and pipeline alike)", () => {
    expect(bashRiskPlaque("Bash", { command: "git status" })).toBe(BASH_RISK_PLAQUE.readOnly);
    expect(bashRiskPlaque("Bash", { command: "ls | wc -l" })).toBe(BASH_RISK_PLAQUE.readOnly);
  });

  it("unknown single command with a named write-capable binary → plaque naming that binary", () => {
    const facts = bashRiskFacts("Bash", { command: "pnpm install" });
    expect(facts).toMatchObject({ applies: true, binary: "pnpm" });
    expect(facts.plaque).toBe(bashWriteCapablePlaque("pnpm"));
  });

  it("unknown single command with any other binary → unknownBinary plaque", () => {
    expect(bashRiskPlaque("Bash", { command: "mytool build ." })).toBe(BASH_RISK_PLAQUE.unknownBinary);
  });

  it("unknown shell expression → no plaque (the TASK.35 shell hint's case alone)", () => {
    expect(bashRiskPlaque("Bash", { command: "cat f | tee out" })).toBeNull();
  });
});

describe("bash-risk-plaque — 4ebfbe12 hardening: wrappers, shells, absolute paths", () => {
  it("basename lookup names `/bin/rm` like the wrapper it is, never softened", () => {
    expect(bashRiskPlaque("Bash", { command: "/bin/rm -rf /" })).toBe(bashWriteCapablePlaque("/bin/rm"));
  });

  it("sudo, bash -c and env get the write-capable plaque naming the wrapper", () => {
    for (const [command, binary] of [
      ["sudo rm -rf /", "sudo"],
      ["bash -c 'rm -rf /'", "bash"],
      ["env rm x", "env"],
    ] as const) {
      expect(bashRiskPlaque("Bash", { command })).toBe(bashWriteCapablePlaque(binary));
    }
  });
});

describe("bash-risk-plaque — fail-closed input discipline", () => {
  it("only command-line tools apply (Bash, CodexExec)", () => {
    expect(isPlaqueCommandLineTool("Bash")).toBe(true);
    expect(isPlaqueCommandLineTool("CodexExec")).toBe(true);
    expect(isPlaqueCommandLineTool("Write")).toBe(false);
    expect(isPlaqueCommandLineTool("CodexApplyPatch")).toBe(false);
  });

  it("a non-command tool, a missing command or a non-string command gets nothing", () => {
    expect(bashRiskPlaque("Write", { file_path: "/x" })).toBeNull();
    expect(bashRiskPlaque("Bash", {})).toBeNull();
    expect(bashRiskPlaque("Bash", null)).toBeNull();
    expect(bashRiskPlaque("Bash", { command: 42 })).toBeNull();
  });
});
