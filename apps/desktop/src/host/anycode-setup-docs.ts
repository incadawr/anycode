/**
 * Taskana 4707: where the built-in `anycode-setup` skill reads the user docs.
 * Resolved from the APP's own location, never from the user's workspace cwd,
 * in this order:
 *
 *   1. packaged app — `<Resources>/docs/user/` (electron-builder
 *      `extraResources`, apps/desktop/electron-builder.yml). `<Resources>` is
 *      `process.resourcesPath` when set, else the directory that holds the
 *      `app.asar` this module is loaded from;
 *   2. dev checkout — the nearest ancestor of this module that is the AnyCode
 *      repository (`docs/user/README.md` AND `packages/core/package.json`);
 *   3. otherwise the GitHub raw URL pinned to the app's release tag
 *      `v<version>`; the skill falls back to `master` itself when that tag
 *      does not carry the page (see builtin.ts's anycodeSetupSkill body).
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnycodeSetupDocsLocation } from "@anycode/core";

/** Upper bound on the ancestor walk for a dev checkout; a real repo is never deeper. */
const MAX_ANCESTOR_WALK = 8;

export interface AnycodeSetupDocsProbe {
  /** `process.resourcesPath` in a packaged app; undefined or non-docs in dev. */
  readonly resourcesPath?: string;
  /** Directory of the module doing the resolving (the host bundle's own dir). */
  readonly moduleDir: string;
  /** The app's version (`package.json`), when readable. */
  readonly appVersion?: string;
  /** Filesystem probe; injected so the order is unit-testable without a real tree. */
  readonly exists: (path: string) => boolean;
}

/** Resolves the docs location for the anycode-setup skill. Pure given its probe. */
export function resolveAnycodeSetupDocs(probe: AnycodeSetupDocsProbe): AnycodeSetupDocsLocation {
  const packagedRoots = [probe.resourcesPath, asarHostingResourcesDir(probe.moduleDir)];
  for (const root of packagedRoots) {
    if (root === undefined || root === "") {
      continue;
    }
    const packagedDir = join(root, "docs", "user");
    if (probe.exists(join(packagedDir, "README.md"))) {
      return { kind: "local", dir: packagedDir };
    }
  }

  let current = resolve(probe.moduleDir);
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    const devDocs = join(current, "docs", "user");
    if (
      probe.exists(join(devDocs, "README.md")) &&
      probe.exists(join(current, "packages", "core", "package.json"))
    ) {
      return { kind: "local", dir: devDocs };
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const version = probe.appVersion?.trim() ?? "";
  const ref = /^\d+\.\d+\.\d+/.test(version) ? `v${version}` : "master";
  return { kind: "remote", ref };
}

/**
 * In a packaged app the host bundle lives at `<Resources>/app.asar/out/main/`,
 * so the Resources directory is the parent of the nearest `app.asar` ancestor.
 * Independent of `process.resourcesPath`, which is not verified for utility
 * processes. Undefined outside an asar bundle.
 */
function asarHostingResourcesDir(moduleDir: string): string | undefined {
  let current = resolve(moduleDir);
  for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth += 1) {
    if (basename(current) === "app.asar") {
      return dirname(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

/** The app version from the `package.json` one level above the bundle dir (dev and asar both). */
function readAppVersion(moduleDir: string): string | undefined {
  try {
    const raw = readFileSync(join(moduleDir, "..", "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The host-process binding of {@link resolveAnycodeSetupDocs}: reads the real
 * `process.resourcesPath`, this bundle's location and the app version.
 */
export function anycodeSetupDocsForHost(): AnycodeSetupDocsLocation {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolveAnycodeSetupDocs({
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    moduleDir,
    appVersion: readAppVersion(moduleDir),
    exists: existsSync,
  });
}
