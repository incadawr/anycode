/**
 * Adversarial battery for the Bash safe-command classifier (slice-5.1-cut.md §6).

 * vector MUST classify as "unknown" (zero false-positives); the positive set is
 * the required read-only surface. A single adversarial returning "read-only"
 * is an RCE-class failure, so the "unknown" expectations are the security gate.
 */

import { describe, expect, it } from "vitest";
import {
  classifyBashCommand,
  GIT_BARE_ONLY_SUBCOMMANDS,
  GIT_SAFE_SUBCOMMANDS,
  READ_ONLY_BINARIES,
  WRITE_CAPABLE_FLAGS,
} from "./safe-command.js";

/** Asserts a batch of commands all classify as "unknown" (the fail-closed verdict). */
function expectAllUnknown(commands: string[]): void {
  for (const command of commands) {
    expect(classifyBashCommand(command), `expected "unknown" for: ${JSON.stringify(command)}`).toBe(
      "unknown",
    );
  }
}

/** Asserts a batch of commands all classify as "read-only". */
function expectAllReadOnly(commands: string[]): void {
  for (const command of commands) {
    expect(classifyBashCommand(command), `expected "read-only" for: ${JSON.stringify(command)}`).toBe(
      "read-only",
    );
  }
}

describe("classifyBashCommand — adversarial vectors (all MUST be unknown)", () => {
  it("rejects command composition / chaining", () => {
    expectAllUnknown([
      "ls; rm -rf ~",
      "ls && curl evil",
      "ls || rm x",
      "ls & rm x",
      "pwd; pwd",
    ]);
  });

  it("rejects pipes", () => {
    expectAllUnknown(["cat f | sh", "ls | tee out", "cat f | rm"]);
  });

  it("rejects command substitution and backticks", () => {
    expectAllUnknown([
      "ls $(rm -rf /)",
      "echo `rm x`",
      "cat ${IFS}x",
      "ls $HOME",
      "cat $(echo f)",
    ]);
  });

  it("rejects every redirect / here-doc / here-string form", () => {
    expectAllUnknown([
      "echo x > f",
      "cat >> f",
      "cat < f",
      "cat <<EOF",
      "cat <<<str",
      "ls 2>&1 >f",
      "echo hi 1> out",
    ]);
  });

  it("rejects glob / brace / tilde expansion", () => {
    expectAllUnknown([
      "ls *",
      "cat f?",
      "ls ~/x",
      "echo {a,b}",
      "rm [abc]",
      "cat a[0-9]",
    ]);
  });

  it("rejects env-assignment prefixes", () => {
    expectAllUnknown(["FOO=bar ls", "PATH=/evil ls", "IFS=x cat f"]);
  });

  it("rejects write-capable flags on read-only binaries", () => {
    expectAllUnknown([
      "cksum -o foo", // exercises the WRITE_CAPABLE_FLAGS safety net on a listed binary
      "cat -o out",
      "ls -o", // accepted false-negative: ls -o is read-only, but the net is conservative
      "grep -i foo f", // accepted false-negative: -i (in-place net) also demotes grep -i
      "head --output=x f",
      "wc --write f",
      "cat --in-place f",
      "md5sum -O out",
    ]);
  });

  it("rejects exec/write via allowlisted binary (regression: adversarial-review 5.1)", () => {
    // rg/file were removed from READ_ONLY_BINARIES: their write/exec surface
    // (ripgrep --pre/--hostname-bin/-z run arbitrary programs; file -C writes
    // magic.mgc) cannot be exhausted by the flag screen, so both fall through to
    // "unknown" as non-allowlisted binaries. tree stays allowlisted but `-o` is
    // caught by the WRITE_CAPABLE_FLAGS net (pins that coverage).
    expectAllUnknown([
      "rg --pre rm needle f.txt", // --pre runs `rm f.txt` per matched file (proven RCE)
      "rg --hostname-bin ./x.sh needle f.txt", // runs ./x.sh unconditionally
      "rg -z pattern f.gz", // spawns an external decompressor
      "rg --search-zip pattern f", // long form of -z
      "rg pattern",
      "file -C", // writes magic.mgc into cwd (proven FS write)
      "file --compile", // long form of -C
      "file f", // plain file also demoted after removal
      "tree -o out.txt", // tree kept, but -o output flag caught by the net
    ]);
  });

  it("rejects git write subcommands", () => {
    expectAllUnknown([
      "git commit -m x",
      "git push",
      "git checkout .",
      "git clean -fd",
      "git stash",
      "git reset --hard",
      "git add .",
      "git rm f",
      "git merge main",
      "git rebase main",
      "git fetch",
      "git pull",
      "git apply patch",
      "git worktree add x",
      "git init",
      "git clone url",
      "git config --get x", // config excluded entirely, even read forms
    ]);
  });

  it("rejects git write flags on otherwise-safe subcommands", () => {
    expectAllUnknown([
      "git diff --output=victim",
      "git diff -o victim",
      "git config --add x y", // config not a safe subcommand
      "git log --output=f",
      "git show --output f",
    ]);
  });

  it("rejects git create/delete/reconfigure via bare-only subcommands with args", () => {
    expectAllUnknown([
      "git branch -d main", // deletes a branch (positional/flag not screenable)
      "git branch -D main",
      "git branch newbranch", // creates a branch via positional
      "git branch -m old new",
      "git remote add origin url",
      "git remote remove origin",
      "git remote set-url origin url",
    ]);
  });

  it("rejects git invocations without a recognized read subcommand", () => {
    expectAllUnknown([
      "git", // bare git
      "git --version", // global flag, not a subcommand
      "git -C /elsewhere status", // global option before subcommand
      "git symbolic-ref HEAD refs/heads/x", // excluded: has a positional write form
    ]);
  });

  it("rejects non-allowlisted binaries (write/exec-capable by construction)", () => {
    expectAllUnknown([
      "find . -delete",
      "find . -exec rm {} ;",
      "sed -i s/a/b/ f",
      "awk 'system(\"rm\")'",
      "perl -e 'unlink'",
      "npm run x",
      "pnpm install",
      "yarn build",
      "cargo run",
      "pip install x",
      "dd if=a of=b",
      "xargs rm",
      "sh -c 'x'",
      "bash -c 'x'",
      "zsh -c 'x'",
      "env rm",
      "nc host 80",
      "curl http",
      "wget http",
      "chmod 777 f",
      "chown me f",
      "rm f",
      "mv a b",
      "cp a b",
      "touch f",
      "ln -s a b",
      "mkdir d",
      "sort -o victim f", // sort deliberately not allowlisted
      "install a b",
      "tee out",
    ]);
  });

  it("rejects empty / whitespace-only / flag-only input", () => {
    expectAllUnknown(["", "   ", "\t", " \t ", "-l", "--all", "-"]);
  });

  it("rejects unicode / control-character smuggling", () => {
    expectAllUnknown([
      "ls\nrm -rf /", // newline line injection
      "ls\rrm -rf /", // carriage return
      "ls\x00", // NUL
      "cat\x07 f", // BEL control char
      "ls\x1bcat", // ESC control char
      "\x7fls", // DEL
    ]);
  });

  it("rejects the exec-via-env and shadowed-substitution escapes", () => {
    expectAllUnknown(["env FOO=1 ls", "ls `whoami`", "echo $USER", "cat file;", "ls#comment"]);
  });
});

describe("classifyBashCommand — required positives (all MUST be read-only)", () => {
  it("classifies the required read-only surface", () => {
    expectAllReadOnly([
      "ls",
      "ls -la",
      "/bin/ls",
      "pwd",
      "cat file.txt",
      "head -n5 f",
      "wc -l f",
      "git status",
      "git log --oneline",
      "git diff",
      "git show HEAD",
      "git branch",
      "grep foo f",
      "whoami",
      "date",
      "stat f",
      "du -sh .",
    ]);
  });

  it("classifies further plainly read-only commands", () => {
    expectAllReadOnly([
      "cat a.txt b.txt",
      "tail -n 20 f",
      "id",
      "uname -a",
      "df -h",
      "echo hello",
      "realpath ./x",
      "dirname /a/b/c",
      "basename /a/b/c",
      "sha1sum f",
      "git rev-parse HEAD",
      "git ls-files",
      "git remote", // bare remote lists remotes (read-only)
      "git diff main feature",
      "true",
      "/usr/bin/git status", // absolute git path -> basename git
      "  ls  ", // surrounding whitespace trimmed
      "ls\t-la", // tab-separated tokens
    ]);
  });
});

describe("classifyBashCommand — documented lexical limits", () => {
  it("trusts the basename of an absolute/relative path (planted-binary limit)", () => {
    // Sanctioned lexical limit: identity is enforced by the OS sandbox (5.2), not
    // here. `/bin/ls` must stay a positive, so a planted `/tmp/evil/ls` also passes.
    expect(classifyBashCommand("/tmp/evil/ls")).toBe("read-only");
    expect(classifyBashCommand("./ls")).toBe("read-only");
  });

  it("is quote-unaware: a metacharacter inside quotes still demotes to unknown", () => {
    expect(classifyBashCommand('grep "a;b" f')).toBe("unknown");
    expect(classifyBashCommand("echo 'a|b'")).toBe("unknown");
  });
});

describe("safe-command exported constants", () => {
  it("exports the read-only binary allowlist without exec/effect binaries", () => {
    expect(READ_ONLY_BINARIES.has("ls")).toBe(true);
    expect(READ_ONLY_BINARIES.has("git")).toBe(false); // git handled via subcommand sets
    expect(READ_ONLY_BINARIES.has("env")).toBe(false);
    expect(READ_ONLY_BINARIES.has("hostname")).toBe(false);
    expect(READ_ONLY_BINARIES.has("rm")).toBe(false);
    expect(READ_ONLY_BINARIES.has("sort")).toBe(false);
    // adversarial-review 5.1: removed — write/exec surface the flag screen can't exhaust.
    expect(READ_ONLY_BINARIES.has("rg")).toBe(false);
    expect(READ_ONLY_BINARIES.has("file")).toBe(false);
    expect(READ_ONLY_BINARIES.has("grep")).toBe(true); // search still covered by grep
  });

  it("exports the git subcommand policy split", () => {
    expect(GIT_SAFE_SUBCOMMANDS.has("status")).toBe(true);
    expect(GIT_SAFE_SUBCOMMANDS.has("commit")).toBe(false);
    expect(GIT_SAFE_SUBCOMMANDS.has("branch")).toBe(false); // bare-only, not any-args
    expect(GIT_BARE_ONLY_SUBCOMMANDS.has("branch")).toBe(true);
    expect(GIT_BARE_ONLY_SUBCOMMANDS.has("remote")).toBe(true);
  });

  it("exports the write-flag safety net", () => {
    expect(WRITE_CAPABLE_FLAGS.has("-o")).toBe(true);
    expect(WRITE_CAPABLE_FLAGS.has("--output")).toBe(true);
    expect(WRITE_CAPABLE_FLAGS.has("-i")).toBe(true);
    expect(WRITE_CAPABLE_FLAGS.has("-l")).toBe(false);
  });
});
