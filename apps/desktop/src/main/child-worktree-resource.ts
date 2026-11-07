import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { NodeGitAdapter } from "@anycode/core/node-git";
import { NodeExecutionAdapter } from "@anycode/core/node-execution";

type ResourceGit = Pick<NodeGitAdapter,
  "status" | "worktreeList" | "worktreeAdd" | "ensureWorktreeNamespaceIgnored">;
type ResourceFs = Pick<typeof nodeFs, "mkdir" | "open" | "rename" | "readFile"> & {
  realpath(target: string): Promise<string>;
};

export interface ChildWorktreeSnapshot {
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly projectRoot: string;
  readonly baseSha: string;
}

export interface ChildWorktreeReceipt extends ChildWorktreeSnapshot {
  version: 1;
  id: string;
  appRunId: string;
  parentSessionId: string;
  childSessionId: string;
  path: string;
  branch: string;
  phase: "intent" | "active" | "unknown" | "retained" | "removed" | "not-created";
  reason: string | null;
}

interface Options {
  userData: string;
  appRunId: string;
  gitForWorkspace?: (cwd: string) => ResourceGit;
  fs?: ResourceFs;
}

/** Main-owned allocation journal, independent of session rows and legacy cleanup. */
export class ChildWorktreeResources {
  private readonly fs: ResourceFs;
  private readonly gitForWorkspace: (cwd: string) => ResourceGit;
  private readonly directory: string;

  constructor(private readonly options: Options) {
    this.fs = options.fs ?? nodeFs;
    this.gitForWorkspace = options.gitForWorkspace ?? ((cwd) =>
      new NodeGitAdapter({ cwd, exec: new NodeExecutionAdapter() }));
    this.directory = path.join(options.userData, "child-worktrees");
  }

  /** Capture at admission; allocation must never resolve HEAD again for its base. */
  async snapshot(source: string, projectRoot: string): Promise<ChildWorktreeSnapshot> {
    const sourceRoot = await this.fs.realpath(source);
    const git = this.gitForWorkspace(sourceRoot);
    const status = await git.status();
    if (!status.ok) throw new Error("Child worktree requires a readable Git repository");
    if (!status.value.head.sha) throw new Error("Child worktree cannot start from an unborn HEAD");
    const listed = await git.worktreeList();
    if (!listed.ok) throw new Error("Child worktree registrations could not be read");
    const identities = await Promise.all(listed.value.map(async (item) => ({
      ...item, canonical: await this.fs.realpath(item.path),
    })));
    const sourceEntry = identities.find((item) => item.canonical === sourceRoot);
    if (!sourceEntry) throw new Error("Child worktree source must be a checkout root, not a workspace subdirectory");
    const main = identities.filter((item) => item.isMain);
    if (main.length !== 1) throw new Error("Child worktree main checkout could not be identified");
    return Object.freeze({ sourceRoot, storageRoot: main[0]!.canonical,
      projectRoot: await this.fs.realpath(projectRoot), baseSha: status.value.head.sha });
  }

  async allocate(snapshot: ChildWorktreeSnapshot, sessions: {
    parentSessionId: string; childSessionId: string;
  }): Promise<ChildWorktreeReceipt> {
    const id = randomUUID();
    const receipt: ChildWorktreeReceipt = {
      version: 1, id, appRunId: this.options.appRunId,
      sourceRoot: snapshot.sourceRoot, storageRoot: snapshot.storageRoot,
      projectRoot: snapshot.projectRoot, baseSha: snapshot.baseSha,
      parentSessionId: sessions.parentSessionId, childSessionId: sessions.childSessionId,
      path: path.join(snapshot.storageRoot, ".anycode", "worktrees", `child-${id}`),
      branch: `anycode-wt/child-${id}`, phase: "intent", reason: null,
    };
    try {
      await this.fs.mkdir(this.directory, { recursive: true });
      await this.syncDirectory(this.options.userData);
      await this.writeExclusive(this.receiptPath(id), receipt);
      await this.syncDirectory();
    } catch {
      throw new Error("Child worktree intent could not be persisted; allocation refused");
    }
    let addAttempted = false;
    try {
      const git = this.gitForWorkspace(receipt.storageRoot);
      const excluded = await git.ensureWorktreeNamespaceIgnored();
      if (!excluded.ok) throw new Error("namespace exclude failed");
      addAttempted = true;
      const added = await git.worktreeAdd({ path: receipt.path, branch: receipt.branch, baseRef: receipt.baseSha });
      if (!added.ok) throw new Error("worktree add failed");
      const canonical = await this.fs.realpath(receipt.path);
      const listed = await git.worktreeList();
      if (!listed.ok) throw new Error("registration read failed");
      const entries = listed.value.filter((item) => path.resolve(item.path) === receipt.path);
      const entry = entries[0];
      if (canonical !== receipt.path || added.value.path !== receipt.path || entries.length !== 1 ||
          !entry || entry.isMain || entry.locked || entry.prunable || entry.detached ||
          entry.branch !== receipt.branch || entry.head !== receipt.baseSha) {
        throw new Error("created worktree identity could not be verified");
      }
      receipt.phase = "active";
      await this.replace(receipt);
      return receipt;
    } catch {
      // Do not persist Git stderr, prompts or credentials. Even a failed add may
      // leave files or refs; the original intent remains if this update fails.
      receipt.phase = addAttempted ? "unknown" : "not-created";
      receipt.reason = addAttempted
        ? "Allocation did not complete; checkout and branch require manual inspection"
        : "Allocation stopped before checkout creation";
      try { await this.replace(receipt); } catch { /* Durable intent remains authoritative. */ }
      throw new Error(addAttempted
        ? `Child worktree allocation failed; resource retained at ${receipt.path}`
        : "Child worktree allocation failed; checkout creation was not attempted");
    }
  }

  /** Read by journal identity, never by a caller-supplied filesystem path. */
  async read(id: string): Promise<ChildWorktreeReceipt> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid receipt identity");
    const value = JSON.parse(await this.fs.readFile(this.receiptPath(id), "utf8"));
    const strings = ["id", "appRunId", "parentSessionId", "childSessionId", "sourceRoot",
      "storageRoot", "projectRoot", "baseSha", "path", "branch"];
    if (!value || value.version !== 1 || value.id !== id ||
        strings.some((key) => typeof value[key] !== "string" || !value[key]) ||
        !["intent", "active", "unknown", "retained", "removed", "not-created"].includes(value.phase) ||
        !(value.reason === null || typeof value.reason === "string")) {
      throw new Error("Invalid receipt");
    }
    return value;
  }

  /** Refuse stale ownership; only this app run can update its own journal. */
  async update(expected: ChildWorktreeReceipt, phase: ChildWorktreeReceipt["phase"],
    reason: string): Promise<ChildWorktreeReceipt> {
    const current = await this.read(expected.id);
    if (current.appRunId !== this.options.appRunId || !receiptsEqual(current, expected))
      throw new Error("Receipt changed or belongs to another run");
    const next = { ...current, phase, reason };
    await this.replace(next);
    return next;
  }

  private receiptPath(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private async writeExclusive(target: string, receipt: ChildWorktreeReceipt): Promise<void> {
    const file = await this.fs.open(target, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await file.sync();
    } finally { await file.close(); }
  }

  private async syncDirectory(target = this.directory): Promise<void> {
    const directory = await this.fs.open(target, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  private async replace(receipt: ChildWorktreeReceipt): Promise<void> {
    const temporary = path.join(this.directory, `${receipt.id}.${randomUUID()}.tmp`);
    await this.writeExclusive(temporary, receipt);
    await this.fs.rename(temporary, this.receiptPath(receipt.id));
    await this.syncDirectory();
  }
}

export function receiptsEqual(a: ChildWorktreeReceipt, b: ChildWorktreeReceipt): boolean {
  const keys = Object.keys(a) as (keyof ChildWorktreeReceipt)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
