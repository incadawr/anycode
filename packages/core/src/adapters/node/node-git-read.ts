import { isAbsolute, relative, resolve, sep } from "node:path";
import { devNull } from "node:os";
import type { ExecutionPort, ExecResult } from "../../ports/execution.js";
import type { GitReadOutput, GitReadPort } from "../../ports/git-read.js";
import type { GitInput } from "../../tools/schemas.js";
import { realpathExistingAncestor } from "../../util/path-containment.js";
import { NodeFileSystemAdapter } from "./node-file-system.js";

const CAPTURE = 80_000;
const LIMIT = 12_000;
const NOTICE = "Output truncated; narrow the revision range, paths, or requested view.";
const safeRevision = (s: string): boolean => /^[A-Za-z0-9_./@{}^~+\-]+$/.test(s) && !s.startsWith("-") && !s.includes("..") && !s.includes("//");
const contained = (root: string, path: string): boolean => {
  const r = relative(root, path);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
};

/** Read-only Git subprocesses, using a fresh safety configuration for every call. */
export class NodeGitReadAdapter implements GitReadPort {
  private readonly fs = new NodeFileSystemAdapter();
  constructor(private readonly exec: ExecutionPort) {}

  async read(input: GitInput, cwd: string, signal: AbortSignal): Promise<GitReadOutput> {
    if (!this.exec.runBinary) throw new Error("Git execution is unavailable");
    const runBinary = this.exec.runBinary.bind(this.exec);
    const env: Record<string, string | undefined> = {};
    for (const key of Object.keys(process.env)) env[key] = undefined;
    for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
      GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
      // This allowlist takes precedence over every protocol.<name>.allow setting,
      // including on Git versions that do not support GIT_NO_LAZY_FETCH.
      GIT_ALLOW_PROTOCOL: "",
      GIT_PAGER: "cat", PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C",
    });
    const fixed = ["--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false",
      "-c", `core.hooksPath=${devNull}`, "-c", `core.attributesFile=${devNull}`,
      "-c", "commit.gpgSign=false", "-c", "log.showSignature=false", "-c", "format.pretty=medium", "-c", "tag.gpgSign=false",
      "-c", "protocol.allow=never", "-c", "protocol.file.allow=never",
      "-c", "submodule.recurse=false", "-c", "diff.external=", "-c", "maintenance.auto=false",
      "-c", "gc.auto=0", "-c", "color.ui=false"];
    const run = (args: string[], config: string[] = []): Promise<ExecResult> => runBinary({
      file: "git", args: [...fixed, ...config, ...args], cwd, env, abortSignal: signal,
      timeoutMs: 30_000, maxOutputBytes: CAPTURE,
    });
    const must = async (args: string[], config: string[] = []): Promise<string> => {
      const result = await run(args, config);
      if (result.status !== "completed" || result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error(`Git safety check failed (${result.status}): ${result.stderr.trim().slice(0, 1000)}`);
      }
      return result.stdout;
    };
    // Reject malformed requests before even repository discovery.
    const ranges = input.revision && input.operation === "log" ? input.revision.split(/(\.\.\.?)/) : input.revision ? [input.revision] : [];
    if (ranges.length !== 0 && ranges.length !== 1 && ranges.length !== 3) throw new Error("Invalid revision range");
    for (const revision of [ranges[0], ranges[2], input.endRevision]) {
      if (revision !== undefined && !safeRevision(revision)) throw new Error("Invalid revision");
    }
    if (ranges.length === 3 && (!ranges[0] || !ranges[2])) throw new Error("Invalid revision range");
    const requestedPaths = [...(input.path ? [input.path] : []), ...(input.paths ?? [])];
    for (const path of requestedPaths) {
      if (path.startsWith("-") || path.startsWith(":") || /[\x00-\x1f\x7f]/.test(path) || path.split(/[\\/]/).some(p => p === "." || p === "..")) throw new Error("Invalid path");
    }
    const workspace = await this.fs.realpath(cwd);
    const resolvedPaths: string[] = [];
    for (const path of requestedPaths) {
      const absolute = resolve(cwd, path);
      const real = await realpathExistingAncestor(this.fs, absolute);
      if (!contained(resolve(cwd), absolute) || !real || !contained(workspace, real)) throw new Error("Path is outside the workspace or cannot be resolved safely");
      resolvedPaths.push(absolute);
    }
    const rootText = await must(["rev-parse", "--show-toplevel"]);
    const root = await this.fs.realpath(rootText.replace(/\n$/, ""));
    if (!isAbsolute(root) || !contained(root, workspace)) throw new Error("Cannot establish repository root");
    const literal = resolvedPaths.map(p => relative(root, resolve(workspace, relative(resolve(cwd), p))).split(sep).join("/"));
    const verified = async (revision: string): Promise<string> => {
      const oid = (await must(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).trim();
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error("Invalid Git object ID");
      return oid;
    };
    const first = ranges[0] ? await verified(ranges[0]) : undefined;
    const second = ranges[2] ? await verified(ranges[2]) : input.endRevision ? await verified(input.endRevision) : undefined;
    const spec = first && second && input.operation === "log" ? `${first}${ranges[1]}${second}` : first;

    // Local attribute filters can execute programs during worktree comparisons.
    // Discover and override every configured filter each time; truncated discovery fails closed.
    const discovered = await run(["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
    if (!["completed", "failed"].includes(discovered.status) || (discovered.exitCode !== 0 && discovered.exitCode !== 1) || discovered.stdoutTruncated || discovered.stderrTruncated || discovered.stderr.trim() !== "") throw new Error("Cannot safely discover Git filters");
    const filterNames = new Set<string>();
    for (const key of discovered.stdout.split("\0").filter(Boolean)) {
      const match = /^filter\.([a-zA-Z0-9_-]+)\.(?:clean|smudge|process|required)$/i.exec(key);
      if (!match) throw new Error("Cannot safely neutralize Git filter configuration");
      filterNames.add(match[1]!);
    }
    const config = [...filterNames].flatMap(name => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]);
    let args: string[];
    const scoped = literal.length ? literal : [relative(root, workspace).split(sep).join("/") || "."];
    switch (input.operation) {
      case "show": args = input.path ? ["show", `${first}:${literal[0]}`] : ["show", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(input.format === "stat" ? ["--stat"] : []), first!, "--", ...scoped]; break;
      case "log": args = ["log", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", `--max-count=${input.maxCount ?? 20}`, ...(input.format === "oneline" ? ["--oneline"] : input.format === "stat" ? ["--stat"] : []), ...(spec ? [spec] : []), ...(literal.length ? ["--", ...literal] : input.format === "stat" ? ["--full-history", "--sparse", "--", ...scoped] : [])]; break;
      case "diff": args = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", ...(input.format === "stat" ? ["--stat"] : input.format === "name-only" ? ["--name-only"] : []), first!, ...(second ? [second] : []), "--", ...scoped]; break;
      case "blame": args = ["blame", "--no-textconv", ...(input.startLine ? ["-L", `${input.startLine},${input.endLine}`] : []), ...(first ? [first] : []), "--", literal[0]!]; break;
      case "ls-tree": {
        const workspacePath = relative(root, workspace).split(sep).join("/");
        args = literal.length ? ["ls-tree", first!, "--", ...literal] : ["ls-tree", workspacePath ? `${first}:${workspacePath}` : first!];
        break;
      }
      case "rev-parse": return { status: "completed", exitCode: 0, stdoutTruncated: false, stderrTruncated: false, stdout: `${first}\n`, stderr: "" };
      case "branch": args = ["branch", "--list", "--no-color"]; break;
      case "status": args = ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all", "--", ...scoped]; break;
    }
    // Pathspecs above are repo-root relative; run from the root, after discovery.
    const result = await runBinary({ file: "git", args: [...fixed, ...config, "-C", root, ...args], cwd, env, abortSignal: signal, timeoutMs: 30_000, maxOutputBytes: CAPTURE });
    if (input.operation === "show" && input.path && result.stdout.includes("\0")) throw new Error("Historical blob appears to be binary; Git output is text-oriented");
    const stdoutChars = Array.from(result.stdout);
    const stderrChars = Array.from(result.stderr);
    const stdout = stdoutChars.slice(0, LIMIT).join("");
    const stderr = stderrChars.slice(0, Math.max(0, LIMIT - Array.from(stdout).length)).join("");
    const stdoutTruncated = result.stdoutTruncated || stdoutChars.length > LIMIT;
    const stderrTruncated = result.stderrTruncated || stderrChars.length > Math.max(0, LIMIT - Array.from(stdout).length);
    return { ...(stdoutTruncated || stderrTruncated ? { notice: NOTICE } : {}), status: result.status, exitCode: result.exitCode, stdoutTruncated, stderrTruncated, stdout, stderr };
  }
}
