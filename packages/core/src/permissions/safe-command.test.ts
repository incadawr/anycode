/**
 * Adversarial battery for the Bash safe-command classifier (slice-5.1-cut.md §6).

 * vector MUST classify as "unknown" (zero false-positives); the positive set is
 * the required read-only surface. A single adversarial returning "read-only"
 * is an RCE-class failure, so the "unknown" expectations are the security gate.
 */

import { describe, expect, it } from "vitest";
import {
  classifyBashCommand,
  classifyBashCommandLine,
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
    // "unknown" as non-allowlisted binaries. tree was removed too (TASK.35 fix
    // wave 1, W1-BLOCKER-1): `-no FILE`/`-o<FILE>` cluster spellings evade the
    // verbatim net, so its `-o` write surface is not exhaustible either.
    expectAllUnknown([
      "rg --pre rm needle f.txt", // --pre runs `rm f.txt` per matched file (proven RCE)
      "rg --hostname-bin ./x.sh needle f.txt", // runs ./x.sh unconditionally
      "rg -z pattern f.gz", // spawns an external decompressor
      "rg --search-zip pattern f", // long form of -z
      "rg pattern",
      "file -C", // writes magic.mgc into cwd (proven FS write)
      "file --compile", // long form of -C
      "file f", // plain file also demoted after removal
      "tree -o out.txt", // tree removed (TASK.35 W1): unknown via allowlist miss
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

/** Asserts a batch of command LINES all classify as "unknown" (classifyBashCommandLine). */
function expectAllLineUnknown(commands: string[]): void {
  for (const command of commands) {
    expect(classifyBashCommandLine(command).class, `expected "unknown" for: ${JSON.stringify(command)}`).toBe(
      "unknown",
    );
  }
}

/** Asserts a batch of command LINES all classify as "read-only" (classifyBashCommandLine). */
function expectAllLineReadOnly(commands: string[]): void {
  for (const command of commands) {
    expect(classifyBashCommandLine(command).class, `expected "read-only" for: ${JSON.stringify(command)}`).toBe(
      "read-only",
    );
  }
}

describe("classifyBashCommandLine — single-command routing (bit-for-bit)", () => {
  it("C1: routes every single-segment command to classifyBashCommand's own verdict, bit-for-bit", () => {
    const commands = [
      "ls",
      "ls -la",
      "/bin/ls",
      "git status",
      "git log --oneline",
      "grep foo f",
      "date",
      "tree -o out.txt",
      "sed -i s/a/b/ f",
      "rm -rf x",
      "echo 'a|b'",
      'grep "a;b" f',
      "ls > f",
      "FOO=bar ls",
      "cat $(echo f)",
      "",
      "   ",
    ];
    for (const command of commands) {
      expect(
        classifyBashCommandLine(command).class,
        `expected classifyBashCommandLine to match classifyBashCommand for: ${JSON.stringify(command)}`,
      ).toBe(classifyBashCommand(command));
    }
  });

  it("C2: bare 'sed -n ...p' with NO pipe still asks in v1 (RES-3 — routing pinned explicitly)", () => {
    expect(classifyBashCommandLine("sed -n '1,5p' f").class).toBe("unknown");
  });
});

describe("classifyBashCommandLine — pipeline positives (DV-5 acceptance, all MUST be read-only)", () => {
  it("P1: the founding owner case", () => {
    expectAllLineReadOnly(["sed -n '420,433p' file | cat -A"]);
  });

  it("P2: grep piped through head", () => {
    expectAllLineReadOnly(["grep -n TODO file | head -20"]);
  });

  it("P3/P4: cat/wc and a three-segment pipeline", () => {
    expectAllLineReadOnly(["cat file.txt | wc -l", "ls -la | grep foo | head -5"]);
  });

  it("P5: sed script quoting variants (double-quoted / unquoted) inside a pipeline", () => {
    expectAllLineReadOnly(["sed -n \"1,5p\" f | cat", "sed -n 1p f | cat"]);
  });

  it("P6: quoted argument containing a space", () => {
    expectAllLineReadOnly(['grep "hello world" f | wc -l']);
  });

  it("P7: basename-trust parity for absolute paths in a pipeline", () => {
    expectAllLineReadOnly(["/bin/cat f | /usr/bin/head -1"]);
  });

  it("P8: bare-only binary, bare, piped", () => {
    expectAllLineReadOnly(["date | cat"]);
  });

  it("P9: printf piped through wc", () => {
    expectAllLineReadOnly(["printf %s x | wc -c"]);
  });
});

describe("classifyBashCommandLine — pipeline adversarial (all MUST be unknown)", () => {
  it("A1: separator confusion with safe-looking neighbors (the discriminators)", () => {
    expectAllLineUnknown([
      "cat f || cat g",
      "cat f && cat g",
      "cat f; cat g",
      "cat f & cat g",
      "cat f\ncat g",
      "cat f |& cat g",
    ]);
  });

  it("A2: blank segments with safe neighbors", () => {
    expectAllLineUnknown(["cat f | | wc -l", "| cat f", "cat f |", "cat f |  | head -1"]);
  });

  it("A3: effectful/unknown segment binaries", () => {
    expectAllLineUnknown([
      "cat f | tee out",
      "cat f | sh",
      "echo x | bash",
      "cat f | xargs rm",
      "cat f | rg pat",
      "cat f | file -",
      "foo | cat",
    ]);
  });

  it("A4: git exclusion in pipelines (examples table wins)", () => {
    expectAllLineUnknown([
      "git status | cat",
      "git log --oneline | head -3",
      "cat f | git status",
      "git diff | wc -l",
    ]);
  });

  it("A5: redirects inside segments (the RCE-class case)", () => {
    expectAllLineUnknown([
      "cat f > x | wc -l",
      "cat f | wc -l > out",
      "cat f | wc 2>&1",
      "cat < f | wc -l",
      "cat f | head -1 >> log",
    ]);
  });

  it("A6: quote-hidden flags (THE DV-5 case)", () => {
    expectAllLineUnknown([
      'tree "-o" x | cat',
      "tree '-o' x | cat",
      'cat f | tree "-o" pwn',
      'tree -"o" x | cat',
      'tree "-"o x | cat',
      'head "--output=x" f | cat',
      'cat "--in-place" f | wc',
    ]);
  });

  it("A7: quoted command word", () => {
    expectAllLineUnknown([
      '"cat" f | wc -l',
      'ca"t" f | wc -l',
      "''ls | cat",
      'cat f | "wc" -l',
      "\"sed\" -n '1p' f | cat",
      // W1 (ARBITRATION-S2-W1 D-W1-3): slash-after-quote vectors — basename()
      // slices at the LAST `/`, so quote characters sitting before that slash
      // are sliced off with the directory prefix and the suffix can land on an
      // allowlist entry. These are the ONLY spellings whose refusal step 3
      // independently carries (MV2's detector).
      '"a"/cat x | wc -l',
      '"/bin"/ls | cat',
    ]);
  });

  it("A8: expansions/assignments inside segments (raw screen)", () => {
    expectAllLineUnknown([
      "cat $x | wc -l",
      "cat ~/f | wc -l",
      "cat f* | wc -l",
      "cat {a,b} | wc -l",
      "cat f | wc -l #c",
      "FOO=1 cat f | wc -l",
      "cat f | env wc",
    ]);
  });

  it("A9: control/unicode smuggling", () => {
    expectAllLineUnknown(["cat f\r| wc -l", "cat f\x00 | wc -l", "сat f | wc -l", "cat f | wс -l"]);
  });

  it("A10: bare-only binary violated in a pipeline", () => {
    expectAllLineUnknown(["date -u | cat", "date +%s | cat"]);
  });

  it("A11: write flags plainly present", () => {
    expectAllLineUnknown(["cat -o out | wc -l", "grep --output=f x | cat", "cat f | md5sum -O out"]);
  });

  it("A12: substitution at line level", () => {
    expectAllLineUnknown(["cat $(x) | wc -l", "cat `x` | wc", "cat <(x) | wc"]);
  });
});

describe("classifyBashCommandLine — sed pipeline subgrammar", () => {
  it("S1-S3: the one accepted sed subgrammar, in and mid-pipeline, quoted path with space", () => {
    expectAllLineReadOnly([
      "sed -n '1p' f | cat",
      "sed -n '7,9p' 'my file.txt' | wc -l",
      "cat f | sed -n '1,5p' g",
    ]);
  });

  it("S5: no -n flag", () => {
    expectAllLineUnknown(["sed '1p' f | cat"]);
  });

  it("S6: bundled / in-place flag in the -n slot", () => {
    expectAllLineUnknown(["sed -ni '1p' f | cat", "sed -i '1p' f | cat"]);
  });

  it("S7: five tokens (-e, or a second file operand)", () => {
    expectAllLineUnknown(["sed -n -e '1p' f | cat", "sed -n '1p' f g | cat"]);
  });

  it("S8: script regex anchoring", () => {
    expectAllLineUnknown(["sed -n '1px' f | cat", "sed -n '1,5pp' f | cat"]);
  });

  it("S9: a write command as the script", () => {
    expectAllLineUnknown(["sed -n 'w out' f | cat"]);
  });

  it("S10: dash-leading operand (option smuggling / stdin)", () => {
    expectAllLineUnknown(["sed -n '1p' -i | cat", "sed -n '1p' - | cat"]);
  });

  it("S11: metacharacters in the script die on the segment raw screen", () => {
    expectAllLineUnknown(["sed -n '$p' f | cat", "sed -n '1~2p' f | cat", "sed -n '1,5p;2d' f | cat"]);
  });

  it("S13: long-form --quiet is refused", () => {
    expectAllLineUnknown(["sed --quiet '1p' f | cat"]);
  });

  it("S14: stdin-only 3-token form is refused (RES-4)", () => {
    expectAllLineUnknown(["cat f | sed -n '1p'"]);
  });
});

describe("classifyBashCommandLine — shellExpression flag", () => {
  it("F1: a plain high-risk single command has no shell-expression flag", () => {
    expect(classifyBashCommandLine("rm -rf /")).toEqual({ class: "unknown", shellExpression: false });
  });

  it("F2: an unknown pipeline IS a shell expression", () => {
    expect(classifyBashCommandLine("git status | cat")).toEqual({ class: "unknown", shellExpression: true });
  });

  it("F3: a single command with a metacharacter is a shell expression", () => {
    expect(classifyBashCommandLine("ls > f")).toEqual({ class: "unknown", shellExpression: true });
  });

  it("F4: a plain safe single command is not a shell expression", () => {
    expect(classifyBashCommandLine("ls -la")).toEqual({ class: "read-only", shellExpression: false });
  });

  it("F5: an accepted pipeline is still honestly a shell expression", () => {
    expect(classifyBashCommandLine("cat f | wc -l")).toEqual({ class: "read-only", shellExpression: true });
  });

  it("F6: a substitution is a shell expression", () => {
    expect(classifyBashCommandLine("cat $(x)")).toEqual({ class: "unknown", shellExpression: true });
  });

  it("F7: a plain unknown binary is not a shell expression — no hint deserved", () => {
    expect(classifyBashCommandLine("npm install")).toEqual({ class: "unknown", shellExpression: false });
  });
});

describe("TASK.35 fix wave 1 — tree removal and divergence pins (V-series)", () => {
  it("V1: single-path tree invocations all ask after the W1 allowlist removal", () => {
    expectAllUnknown([
      "tree",
      "tree x",
      "tree -L 2",
      "tree -no /tmp/pwn",
      "tree -o/tmp/pwn",
      'tree "-o" pwn',
    ]);
  });

  it("V2: pipeline tree invocations all ask — the W1-BLOCKER-1 vectors", () => {
    expectAllLineUnknown([
      "tree -no /tmp/PWN | cat",
      "tree -o/tmp/PWN | cat",
      "cat f | tree -no /tmp/PWN",
      "tree | head -5",
    ]);
  });

  it("V3: allowlist exclusion pins — tree and sed must never be READ_ONLY_BINARIES entries", () => {
    // tree: W1-BLOCKER-1 — its write surface is not exhaustible by the
    // verbatim flag net (`-no FILE` / `-o<FILE>` cluster spellings).
    // sed: legal ONLY via the 4-token pipeline subgrammar; an allowlist entry
    // would silently legalize bare `sed -n '1p' f` and every non-subgrammar
    // single-command form (C2 is the behavioral twin detector, proven by MV4).
    expect(READ_ONLY_BINARIES.has("tree")).toBe(false);
    expect(READ_ONLY_BINARIES.has("sed")).toBe(false);
  });

  it("V4: unbalanced-quote divergence CLOSED for the flag-screened path (TASK.136, was D-S2-4/RES-11)", () => {
    // History: before TASK.136, the single-command path's write-flag screen
    // never looked at quote state at all — `tokenize()` is a plain whitespace
    // split — so `cat 'f` (a /bin/sh syntax error) fell through every check
    // and classified "read-only" there, while the line classifier already
    // refused it (splitter refusal, upstream of this file). That was pinned
    // narrowing-only: the single-command path could be laxer than the line
    // classifier, never stricter.
    // TASK.136 made `classifyBashCommand` reuse `tokenizeSegment` (the
    // pipeline path's quote-aware splitter) for its write-flag screen; an
    // unterminated quote makes that splitter return `undefined`, which the
    // screen now treats as "cannot prove flag-free" and fails closed to
    // "unknown" (see safe-command.ts step 4b). For a command that reaches the
    // flag screen at all (binary allowlisted or `git`, at least one arg —
    // exactly the shape needed to even contain a stray quote), this closes
    // the divergence outright rather than merely narrowing it: both paths now
    // agree on "unknown".
    expect(classifyBashCommand("cat 'f")).toBe("unknown");
    expect(classifyBashCommand('cat "f')).toBe("unknown");
    expect(classifyBashCommandLine("cat 'f").class).toBe("unknown");
    expect(classifyBashCommandLine('cat "f').class).toBe("unknown");
  });
});

describe("TASK.35 fix wave 2 — RES-1 witness pins (GP-series)", () => {
  it("GP1: RES-1's former witness is refused by the `=` screen, NOT the flag net", () => {
    // `git diff "--output=victim"` asks TODAY, but the refusal is carried by
    // the step-1 quote-UNAWARE metacharacter screen (`=` is in
    // SHELL_METACHARACTERS) — the git flag loop never sees the token (and
    // could not catch it: the raw token starts with `"`). The flag-free twin
    // proves the attribution: no write flag anywhere, same verdict. This pin
    // exists so the `=`-form can never again be cited as evidence that the
    // flag net catches quoted write flags — it does not (see GP2). MG2
    // proves this pin load-bearing.
    expect(classifyBashCommand('git diff "--output=victim"')).toBe("unknown");
    expect(classifyBashCommand('git diff "--zzzz=victim"')).toBe("unknown");
  });

  it("GP2: RES-1 CLOSED — quote-hidden git write flags now classify unknown (TASK.136)", () => {
    // Closed-hole acceptance pin (RESIDUALS-S2.md RES-1, closed by TASK.136).
    // History: on the pre-fix single-command path, `isWriteFlag` only ever
    // saw the raw whitespace-split token (`"--output"` starts with `"`, not
    // `-`; `--outp"ut"` normalization only strips a `=value` suffix), so
    // `classifyGit`'s flag loop missed every spelling below and the command
    // classified "read-only". Executed against real git 2.37.1 in an
    // isolated repo (W2): diff/log/show/shortlog WROTE the named file;
    // blame TRUNCATED an existing file to 0 bytes — this was a live
    // auto-approved-write hole, not a hypothetical.
    // The fix: `classifyGit`'s flag loop (and `classifyBashCommand` step 4b)
    // now also check each argument's quote-stripped form via
    // `tokenizeSegment` (the same quote-aware splitter the pipeline path
    // already used), the same dual raw/unquoted check `classifyPipelineSegment`
    // performs. A fix that leaves this test green has not closed the hole.
    expectAllUnknown([
      'git diff "--output" victim',
      'git diff --outp"ut" victim',
      "git diff '--output' victim",
      'git log "--output" victim',
      'git show "--output" victim',
      'git shortlog "--output" victim',
      'git blame "--output" victim f',
    ]);
  });
});

describe("TASK.136 — RES-1 fix, non-git single-command path (classifyBashCommand step 4b)", () => {
  it("quote-hidden write flags on plain allowlisted binaries now ask", () => {
    // Same hole as GP2, on the non-git branch of the single-command path:
    // `isWriteFlag` on the naive whitespace token alone never recognized a
    // quoted flag (`"-o"` starts with `"`, not `-`), so `cat "-o" f` and
    // friends classified "read-only" before this fix. Step 4b now also
    // checks each argument's quote-stripped form (`tokenizeSegment`), so
    // these ask like their unquoted twins.
    expectAllUnknown([
      'cat "-o" f',
      "cat '-o' f",
      'cat "--output" f',
      'head "--output" f',
      'wc --outp"ut" f', // splice form (GP2's `--outp"ut"` twin)
      'cksum "-O" f',
      'md5sum "--write" f',
    ]);
  });

  it("unquoted write flags still ask exactly as before the fix (no regression)", () => {
    expectAllUnknown([
      "cksum -o foo",
      "head --output=x f",
      "cat -o out",
      "wc --write f",
      "git diff --output=victim",
      "git diff -o victim",
      "git log --output=f",
      "git show --output f",
    ]);
  });

  it("an unterminated quote in the argument list is undecidable and fails closed", () => {
    // `tokenizeSegment` returns undefined only when a quote is never closed
    // (its one failure mode once the metacharacter screen has already run).
    // The flag screen cannot prove such a command flag-free, so it refuses
    // rather than falling through to "read-only" (see the updated V4 pin,
    // and classifyGit's mirrored branch for the git case below).
    expectAllUnknown(["cat 'unterminated f", 'head "unterminated f', "git diff 'unterminated victim"]);
  });
});
