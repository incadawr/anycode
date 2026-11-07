import { dirname, isAbsolute, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { BuiltinSnapshotLease } from "../../skills/builtin-snapshot.js";

/** Only skill RPCs; no body reads through foreign catalog paths. */
export interface CodexBuiltinPort {
  request<T>(method: "skills/list" | "skills/extraRoots/set", params: unknown): Promise<T>;
}
export interface CodexBuiltinPreparation {
  /** A factory that throws after creating a lease must abort it before throwing. */
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
    try { this.prepared = await callback?.(); }
    catch (error) { if (!this.current()) throw error; }
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

/** Exact metadata only. Native bodies are never opened through catalog paths. */
export async function installCodexBuiltins(port: CodexBuiltinPort, cwd: string, root: string, names: readonly string[]): Promise<void> {
  type Skill = { name: string; path: string; enabled: boolean; scope: string };
  const list = async (): Promise<Skill[]> => {
    const r = await port.request<{ data: { cwd: string; errors: unknown[]; skills: Skill[] }[] }>("skills/list", { cwds: [cwd], forceReload: true });
    const row = r?.data?.[0];
    if (!Array.isArray(r?.data) || r.data.length !== 1 || row?.cwd !== cwd || !Array.isArray(row.errors) || row.errors.length ||
        !Array.isArray(row.skills) || row.skills.length > 4096 || row.skills.some(s => !s || typeof s.name !== "string" || !s.name ||
          typeof s.path !== "string" || !isAbsolute(s.path) || typeof s.enabled !== "boolean" || !["user", "repo", "system", "admin"].includes(s.scope))) throw new Error("Incomplete skill catalog");
    return row.skills;
  };
  const key = (s: Skill) => JSON.stringify([s.name, s.path, s.enabled, s.scope]);
  const same = (a: Skill[], b: Skill[]) => JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort());
  let native: Skill[];
  try { native = await list(); } catch { return; } // No mutation: ordinary native catalog.
  const selected = names.filter(name => !native.some(s => s.name === name));
  if (!selected.length) return;
  const expected = selected.map(name => ({ name, path: join(root, "skills", name, "SKILL.md") }));
  // Per-skill directories allow collision omission without mutating sealed bytes.
  // A failed/timed-out set has unknown ordering: restart rather than race a reset.
  await port.request("skills/extraRoots/set", { extraRoots: expected.map(s => dirname(s.path)) });
  try {
    const rows = await list();
    const app = rows.filter(s => expected.some(e => e.path === s.path));
    if (app.length !== expected.length || expected.some(e => app.filter(s => s.name === e.name && s.path === e.path && s.enabled).length !== 1) ||
        !same(rows.filter(s => !expected.some(e => e.path === s.path)), native)) throw new Error("Wrong app skill readback");
    return;
  } catch { /* Reset only after acknowledged set; never continue with unknown roots. */ }
  await port.request("skills/extraRoots/set", { extraRoots: [] });
  if (!same(await list(), native)) throw new Error("Skill reset not verified");
}
