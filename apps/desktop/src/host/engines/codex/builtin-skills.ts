import type { ChildProcess } from "node:child_process";
import type { BuiltinSnapshotLease } from "../../skills/builtin-snapshot.js";

/** Only skill RPCs; no body reads through foreign catalog paths. */
export interface CodexBuiltinPort {
  request<T>(method: "skills/list" | "skills/extraRoots/set", params: unknown): Promise<T>;
}
export interface CodexBuiltinPreparation {
  readonly lease: BuiltinSnapshotLease;
  /** Inventory, collision omission and verified installation belong here.
   * A callback failure must stop boot until the caller proves reset or restarts.
   */
  afterInitialize(port: CodexBuiltinPort): Promise<void>;
}

/** One instance per concrete transport, never shared with a replacement. */
export class CodexBuiltinSkills {
  private preparing = false;
  private prepared?: CodexBuiltinPreparation;
  private applied?: Promise<void>;
  constructor(private readonly current: () => boolean) {}

  async prepare(callback?: () => Promise<CodexBuiltinPreparation | undefined>): Promise<void> {
    if (this.preparing) throw new Error("Codex builtin preparation already started");
    this.preparing = true;
    this.prepared = await callback?.();
    if (!this.current()) { this.prepared?.lease.abortNeverSpawned(); throw new Error("Codex builtin preparation invalidated"); }
  }
  abortNeverSpawned(): void { this.prepared?.lease.abortNeverSpawned(); }
  bind(child: ChildProcess, dedicatedGroup: boolean): void {
    if (!child.pid) { child.once("error", () => this.abortNeverSpawned()); return; }
    this.prepared?.lease.bindChild(child, dedicatedGroup);
  }
  afterInitialize(port: CodexBuiltinPort, timeoutMs: number): Promise<void> {
    return this.applied ??= this.apply(port, timeoutMs);
  }
  private async apply(port: CodexBuiltinPort, timeoutMs: number): Promise<void> {
    if (!this.prepared) return;
    let active = true;
    const check = () => { if (!active || !this.current()) throw new Error("Codex builtin callback invalidated"); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      check();
      await Promise.race([
        this.prepared.afterInitialize({ request: (method, params) => { check(); return port.request(method, params); } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { active = false; reject(new Error("Codex builtin callback timed out")); }, timeoutMs); }),
      ]);
      check();
    } finally { active = false; clearTimeout(timer); }
  }
}
