/**
 * The R5 comparison method (contract §3/§4), reused as CC-B's drift-gate
 * primitive: extract every nested key path from a JSON value — arrays fully
 * traversed but collapsed to a single `[]` segment (order/count vary
 * legitimately run to run), leaves reduced to their JS type — and diff the
 * resulting SETS. This ignores live-varying values (timestamps, quotas,
 * request counters) entirely, which is exactly why it caught zero drift
 * 2.1.212->2.1.214 on real payloads full of exactly that kind of noise.
 *
 * Subset semantics, never equality (contract §4): a pinned path missing from
 * a live payload is drift; a live payload carrying EXTRA paths the pin never
 * claimed is not — the CLI is free to add optional fields between versions.
 */
export function typedKeyPaths(value: unknown, prefix = ""): Set<string> {
  const paths = new Set<string>();
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      if (node.length === 0) {
        paths.add(`${path}[]`);
        return;
      }
      for (const item of node) visit(item, `${path}[]`);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        visit(val, path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    paths.add(`${path}:${node === null ? "null" : typeof node}`);
  };
  visit(value, prefix);
  return paths;
}

/** Every path in `pinned` missing from `live` — empty means `pinned ⊆ live`. */
export function missingFromLive(pinned: ReadonlySet<string> | readonly string[], live: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  for (const path of pinned) if (!live.has(path)) missing.push(path);
  return missing;
}
