/**
 * Codex binary installer (codex-profiles cut §7.2/§7.3, amended §A4, TASK.53):
 * downloads the platform artifact of `@openai/codex` DIRECTLY from the npm
 * registry — npm itself is never executed (no lifecycle scripts, no shell) —
 * verifies the registry's own `dist.integrity` sha512 BEFORE a single byte is
 * extracted, unpacks the `vendor/<triple>/` subtree with per-entry
 * sanitization, and lands it under `~/.anycode/codex/bin/<version>/` with an
 * atomic directory rename.
 *
 * Supply-chain posture (cut §12): the artifact origin (`CODEX_NPM_PACKAGE` on
 * `CODEX_NPM_REGISTRY`) is a compile-time constant from shared/codex-support.ts
 * — nothing fetched from the network (manifest included) can redirect the
 * download. Integrity comes from the per-version registry metadata, never
 * from our manifest and never from a latest-alias. Nothing downloaded is ever
 * executed, or even made executable, before the sha512 check passes.
 */
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { ipcMain } from "electron";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import {
  CODEX_NPM_PACKAGE,
  CODEX_NPM_REGISTRY,
  CODEX_TRIPLE_BY_PLATFORM,
  codexBinaryRelPath,
  codexPlatformSuffix,
} from "../shared/codex-support.js";
import { checkCodexBinaryPathTrust } from "./codex-binary.js";
import { runCodexDoctor, type RunCodexDoctorOptions } from "./codex-doctor.js";
import {
  activeCodexVersionPolicy,
  codexVersionVerdict,
  parseCodexSemver,
  refreshCodexManifest,
  setActiveCodexVersionPolicy,
} from "./codex-manifest.js";
import { codexProfilesRoot } from "./codex-profiles.js";

// ── caps (amended §A4.3 п.4 — fail-closed on breach; live artifact: ~115 MiB compressed / 311 MB unpacked / 7 entries) ──

export interface CodexInstallCaps {
  maxTarballBytes: number;
  maxUnpackedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
}

export const DEFAULT_CODEX_INSTALL_CAPS: CodexInstallCaps = {
  maxTarballBytes: 600 * 1024 * 1024,
  maxUnpackedBytes: 1024 * 1024 * 1024,
  maxEntries: 4096,
  maxEntryBytes: 512 * 1024 * 1024,
};

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

// ── artifact resolution (amended §A4.1: version-suffix of the SAME package, one request, strict validation) ──

export interface ResolvedCodexArtifact {
  tarballUrl: string;
  integrity: string;
}

export interface ResolveCodexArtifactOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `GET {registry}/@openai/codex/<version>-<platform-suffix>` -> validated
 * `{dist.tarball, dist.integrity}`. Every mismatch — name echo, version echo,
 * `os`/`cpu` gate, missing/non-sha512 integrity, tarball not on the pinned
 * registry host over https — is a refusal, never a heuristic (§A4.1 п.3).
 */
export async function resolveCodexArtifact(version: string, options: ResolveCodexArtifactOptions = {}): Promise<Result<ResolvedCodexArtifact>> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (parseCodexSemver(version) === null) {
    return { ok: false, error: `not a release version: ${JSON.stringify(version)}` };
  }
  const suffix = codexPlatformSuffix(platform, arch);
  if (suffix === null) {
    return { ok: false, error: `unsupported platform: ${platform}-${arch}` };
  }
  const wireVersion = `${version}-${suffix}`;
  let raw: unknown;
  try {
    const response = await fetchImpl(`${CODEX_NPM_REGISTRY}/${CODEX_NPM_PACKAGE}/${wireVersion}`, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (response.status !== 200) {
      return { ok: false, error: `registry answered ${response.status} for ${CODEX_NPM_PACKAGE}@${wireVersion}` };
    }
    raw = JSON.parse(await response.text());
  } catch (error) {
    return { ok: false, error: `registry metadata fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "registry metadata is not an object" };
  const meta = raw as { name?: unknown; version?: unknown; os?: unknown; cpu?: unknown; dist?: unknown };
  if (meta.name !== CODEX_NPM_PACKAGE) return { ok: false, error: "registry metadata names a different package" };
  if (meta.version !== wireVersion) return { ok: false, error: "registry metadata echoes a different version" };
  if (!Array.isArray(meta.os) || !meta.os.includes(platform)) return { ok: false, error: "artifact os gate does not match this platform" };
  if (!Array.isArray(meta.cpu) || !meta.cpu.includes(arch)) return { ok: false, error: "artifact cpu gate does not match this arch" };
  const dist = meta.dist as { tarball?: unknown; integrity?: unknown } | undefined;
  const integrity = dist?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    return { ok: false, error: "registry metadata carries no sha512 integrity" };
  }
  const tarball = dist?.tarball;
  if (typeof tarball !== "string") return { ok: false, error: "registry metadata carries no tarball URL" };
  let tarballUrl: URL;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    return { ok: false, error: "tarball URL is unparsable" };
  }
  const registryHost = new URL(CODEX_NPM_REGISTRY).host;
  if (tarballUrl.protocol !== "https:" || tarballUrl.host !== registryHost) {
    return { ok: false, error: `tarball URL is not on ${registryHost} over https` };
  }
  return { ok: true, tarballUrl: tarballUrl.toString(), integrity };
}

// ── download + integrity (cut §7.2 п.3-4: verify BEFORE unpack; the file never becomes executable) ──

export interface DownloadCodexTarballOptions {
  integrity: string;
  destFile: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Streams the tarball to `destFile` (mode 0600 — data, never a program),
 * hashing as it writes. A size-cap breach, a redirect (refused, not followed
 * — cross-host redirect defense, §A4.1 п.4), a non-200, or an integrity
 * mismatch deletes the file: a failed download leaves NOTHING behind.
 */
export async function downloadCodexTarball(url: string, options: DownloadCodexTarballOptions): Promise<Result> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_CODEX_INSTALL_CAPS.maxTarballBytes;
  let handle: FileHandle | null = null;
  const cleanup = async (): Promise<void> => {
    try {
      await handle?.close();
    } catch {
      // already closed
    }
    handle = null;
    rmSync(options.destFile, { force: true });
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200 || response.body === null) {
      return { ok: false, error: `tarball download answered ${response.status}` };
    }
    await mkdir(dirname(options.destFile), { recursive: true });
    handle = await open(options.destFile, "wx", 0o600);
    const hash = createHash("sha512");
    let written = 0;
    for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      if (written > maxBytes) {
        await cleanup();
        return { ok: false, error: `tarball exceeds the ${maxBytes}-byte cap` };
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    const digest = `sha512-${hash.digest("base64")}`;
    if (digest !== options.integrity) {
      // The mismatch deletes the artifact — it must not survive on disk, and
      // it was created 0600 so it was never executable at any point.
      rmSync(options.destFile, { force: true });
      return { ok: false, error: "tarball sha512 does not match the registry integrity — download refused and deleted" };
    }
    return { ok: true };
  } catch (error) {
    await cleanup();
    return { ok: false, error: `tarball download failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ── streaming tar reader (own, minimal: ustar + pax path/size + GNU longname; anything else fails closed) ──
//
// Written against node primitives on purpose: the desktop package carries no
// tar dependency, and this loader is the most supply-chain-sensitive code in
// the app — a small auditable reader beats a hoisted transitive dep. The
// sha512 gate above has already proven the bytes are exactly what the
// registry published; the sanitization below is defense-in-depth against a
// hostile PUBLISHED artifact (traversal, links, device nodes).

class TarByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(iterable: AsyncIterable<Buffer>) {
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  /** Exactly `n` bytes, or null on a CLEAN end-of-stream at a record boundary; a mid-record EOF throws (truncated archive). */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffered < n) {
      const { value, done } = await this.iterator.next();
      if (done) {
        if (this.buffered === 0) return null;
        throw new Error("archive is truncated");
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return Buffer.from(out);
  }

  /** Consumes `n` bytes in bounded pieces, passing each to `sink` (null sink = discard). Streams — never holds a whole entry in memory. */
  async consume(n: number, sink: ((chunk: Buffer) => Promise<void>) | null): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      const piece = await this.read(Math.min(remaining, 1024 * 1024));
      if (piece === null) throw new Error("archive is truncated");
      remaining -= piece.length;
      if (sink !== null) await sink(piece);
    }
  }
}

function parseTarNumeric(header: Buffer, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  // GNU base-256 encoding (high bit set on the first byte) — sizes past the octal limit.
  if ((field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!;
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new Error("archive header carries an unparsable numeric field");
  return value;
}

function tarHeaderChecksumValid(header: Buffer): boolean {
  const declared = parseTarNumeric(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
  return sum === declared;
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

/** pax extended-header body: `"<len> <key>=<value>\n"` records; only `path` and `size` are consumed. */
function parsePaxRecords(body: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  const text = body.toString("utf8");
  let cursor = 0;
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space === -1) break;
    const recordLength = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isInteger(recordLength) || recordLength <= 0) break;
    const record = text.slice(cursor, cursor + recordLength);
    const eq = record.indexOf("=");
    if (eq !== -1) {
      const key = record.slice(space - cursor + 1, eq);
      const value = record.slice(eq + 1).replace(/\n$/, "");
      if (key === "path") out.path = value;
      if (key === "size") {
        const size = Number.parseInt(value, 10);
        if (Number.isInteger(size) && size >= 0) out.size = size;
      }
    }
    cursor += recordLength;
  }
  return out;
}

/**
 * Splits a tar entry name into path components, refusing every traversal
 * shape: NUL, backslash separators, absolute paths, drive letters, and any
 * `..` component (amended §A4.3 п.2). `.` components and empty segments are
 * dropped, not refused (harmless artifacts of `./package/...` naming).
 */
function safeEntryComponents(name: string): string[] | null {
  if (name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const components = name.split("/").filter((part) => part !== "" && part !== ".");
  if (components.some((part) => part === "..")) return null;
  return components;
}

/**
 * Extracts `package/vendor/<triple>/**` from `tgzPath` into `destDir`
 * (prefix stripped), enforcing the full §A4.3 discipline: only regular files
 * and directories anywhere in the archive (a link/device/fifo entry refuses
 * the WHOLE install, not the entry), per-entry path sanitization, caps, and
 * `mode & 0o755`. Entries outside the subtree (`package/package.json`,
 * `README.md`) are the shim wrapper — skipped silently, their bytes still
 * counted against the caps. Any refusal removes everything extracted so far;
 * `destDir` simply does not exist on a failed return.
 */
export async function extractCodexVendorSubtree(
  tgzPath: string,
  destDir: string,
  triple: string,
  caps: Partial<CodexInstallCaps> = {},
): Promise<Result> {
  const limits = { ...DEFAULT_CODEX_INSTALL_CAPS, ...caps };
  const subtree = ["package", "vendor", triple];
  const destRoot = resolve(destDir);
  const stream = createReadStream(tgzPath);
  const gunzip = createGunzip();
  stream.pipe(gunzip);
  // An fs read error surfaces through the gunzip iterator only if forwarded.
  stream.on("error", (error) => gunzip.destroy(error));
  const reader = new TarByteReader(gunzip as AsyncIterable<Buffer>);

  let entries = 0;
  let unpackedTotal = 0;
  let pendingLongName: string | null = null;
  let pendingPax: { path?: string; size?: number } | null = null;

  try {
    await mkdir(destRoot, { recursive: true });
    for (;;) {
      const header = await reader.read(512);
      if (header === null) break; // clean EOF without terminator blocks — tolerated
      if (header.every((byte) => byte === 0)) break; // end-of-archive marker
      if (!tarHeaderChecksumValid(header)) throw new Error("archive header checksum mismatch");

      const typeflag = String.fromCharCode(header[156]!);
      const declaredSize = parseTarNumeric(header, 124, 12);
      const padded = Math.ceil(declaredSize / 512) * 512;

      entries += 1;
      if (entries > limits.maxEntries) throw new Error(`archive exceeds the ${limits.maxEntries}-entry cap`);
      if (declaredSize > limits.maxEntryBytes) throw new Error(`an archive entry exceeds the ${limits.maxEntryBytes}-byte cap`);
      unpackedTotal += declaredSize;
      if (unpackedTotal > limits.maxUnpackedBytes) throw new Error(`archive exceeds the ${limits.maxUnpackedBytes}-byte unpacked cap`);

      // Metadata entries first: they carry overrides for the NEXT real entry.
      if (typeflag === "x") {
        const body = Buffer.alloc(declaredSize);
        let offset = 0;
        await reader.consume(padded, async (chunk) => {
          const usable = Math.min(chunk.length, declaredSize - offset);
          if (usable > 0) chunk.copy(body, offset, 0, usable);
          offset += chunk.length;
        });
        pendingPax = parsePaxRecords(body);
        continue;
      }
      if (typeflag === "g") {
        await reader.consume(padded, null); // global pax — no per-entry overrides taken from it
        continue;
      }
      if (typeflag === "L") {
        const body = Buffer.alloc(declaredSize);
        let offset = 0;
        await reader.consume(padded, async (chunk) => {
          const usable = Math.min(chunk.length, declaredSize - offset);
          if (usable > 0) chunk.copy(body, offset, 0, usable);
          offset += chunk.length;
        });
        pendingLongName = body.toString("utf8").replace(/\0.*$/, "");
        continue;
      }

      const isFile = typeflag === "0" || typeflag === "\0";
      const isDirectory = typeflag === "5";
      if (!isFile && !isDirectory) {
        // Symlink ('2'), hardlink ('1'), char/block device, fifo, GNU longlink
        // ('K'), anything unknown: an anomalous artifact — refuse the WHOLE
        // install (§A4.3 п.1; the live archive has none of these).
        throw new Error(`archive carries a forbidden entry type '${typeflag}' — install refused`);
      }

      const rawName = pendingPax?.path ?? pendingLongName ?? tarPathFromHeader(header);
      const effectiveSize = pendingPax?.size ?? declaredSize;
      pendingLongName = null;
      pendingPax = null;
      if (effectiveSize !== declaredSize) throw new Error("pax size override disagrees with the header");

      const components = safeEntryComponents(rawName);
      if (components === null) throw new Error(`archive entry has an unsafe path — install refused`);

      const inSubtree =
        components.length >= subtree.length && subtree.every((part, index) => components[index] === part);
      const relComponents = inSubtree ? components.slice(subtree.length) : null;

      if (relComponents === null || relComponents.length === 0) {
        // Shim wrapper files / the subtree root itself: skip, bytes already capped.
        await reader.consume(padded, null);
        continue;
      }

      const target = resolve(destRoot, ...relComponents);
      if (target !== destRoot && !target.startsWith(destRoot + sep)) {
        throw new Error("archive entry escapes the destination — install refused");
      }
      const mode = (parseTarNumeric(header, 100, 8) & 0o755) || (isDirectory ? 0o755 : 0o644);

      if (isDirectory) {
        await mkdir(target, { recursive: true });
        await chmod(target, mode | 0o700); // our own tree must stay traversable by us
        await reader.consume(padded, null);
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      const handle = await open(target, "wx", 0o600);
      try {
        let bodyRemaining = declaredSize;
        await reader.consume(padded, async (chunk) => {
          const usable = Math.min(chunk.length, bodyRemaining);
          if (usable > 0) {
            await handle.write(chunk.subarray(0, usable));
            bodyRemaining -= usable;
          }
        });
      } finally {
        await handle.close();
      }
      await chmod(target, mode);
    }
    return { ok: true };
  } catch (error) {
    rmSync(destRoot, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    stream.destroy();
    gunzip.destroy();
  }
}

function tarPathFromHeader(header: Buffer): string {
  const name = tarString(header, 0, 100);
  const prefix = tarString(header, 345, 155);
  return prefix !== "" ? `${prefix}/${name}` : name;
}

// ── install orchestration (atomic dir-rename + codex-package.json cross-check) ──

export interface InstallCodexVersionOptions {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  caps?: Partial<CodexInstallCaps>;
}

export type CodexInstallOutcome =
  | { ok: true; version: string; installDir: string; binaryPath: string; alreadyInstalled?: true }
  | { ok: false; error: string };

/**
 * The full §7.2 pipeline for one version: resolve -> download -> verify ->
 * extract (into `bin/.tmp-*`) -> cross-check `codex-package.json`
 * (`layoutVersion === 1`, `entrypoint === "bin/codex"` — fail-closed against
 * a future layout change, §A4.3 п.6) -> atomic `rename` to
 * `bin/<version>/`. A failure at ANY stage leaves no partial directory under
 * the final name and no temp litter. Never throws.
 */
export async function installCodexVersion(version: string, options: InstallCodexVersionOptions = {}): Promise<CodexInstallOutcome> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (parseCodexSemver(version) === null) {
    return { ok: false, error: `not a release version: ${JSON.stringify(version)}` };
  }
  const suffix = codexPlatformSuffix(platform, arch);
  const triple = suffix !== null ? CODEX_TRIPLE_BY_PLATFORM[suffix] : undefined;
  if (suffix === null || triple === undefined) {
    return { ok: false, error: `unsupported platform: ${platform}-${arch}` };
  }
  const binRoot = join(codexProfilesRoot(options.home ?? homedir()), "bin");
  const installDir = join(binRoot, version);
  const binaryPath = join(installDir, codexBinaryRelPath(triple));

  if (existsSync(installDir)) {
    if (existsSync(binaryPath)) {
      return { ok: true, version, installDir, binaryPath, alreadyInstalled: true };
    }
    return { ok: false, error: `an existing install at ${installDir} is missing its binary — remove it and retry` };
  }

  const nonce = randomBytes(6).toString("hex");
  const tarballPath = join(binRoot, `.download-${version}-${nonce}.tgz`);
  const stagingRoot = join(binRoot, `.tmp-${version}-${nonce}`);
  const cleanup = (): void => {
    rmSync(tarballPath, { force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
  };

  try {
    mkdirSync(binRoot, { recursive: true });
    const resolved = await resolveCodexArtifact(version, {
      platform,
      arch,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (!resolved.ok) return resolved;

    const downloaded = await downloadCodexTarball(resolved.tarballUrl, {
      integrity: resolved.integrity,
      destFile: tarballPath,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.caps?.maxTarballBytes !== undefined ? { maxBytes: options.caps.maxTarballBytes } : {}),
    });
    if (!downloaded.ok) return downloaded;

    const vendorDest = join(stagingRoot, "vendor", triple);
    const extracted = await extractCodexVendorSubtree(tarballPath, vendorDest, triple, options.caps ?? {});
    if (!extracted.ok) return extracted;

    // Cross-check the layout manifest the artifact itself ships (§A4.3 п.6).
    let layout: { layoutVersion?: unknown; entrypoint?: unknown };
    try {
      layout = JSON.parse(await readFile(join(vendorDest, "codex-package.json"), "utf8")) as typeof layout;
    } catch {
      return { ok: false, error: "artifact carries no readable codex-package.json — layout unknown, install refused" };
    }
    if (layout.layoutVersion !== 1 || layout.entrypoint !== "bin/codex") {
      return { ok: false, error: "artifact layout changed (layoutVersion/entrypoint mismatch) — wait for a manifest update" };
    }
    const stagedBinary = join(stagingRoot, codexBinaryRelPath(triple));
    try {
      const binaryStat = await stat(stagedBinary);
      if (!binaryStat.isFile()) throw new Error("not a file");
    } catch {
      return { ok: false, error: "artifact carries no main binary at its declared entrypoint — install refused" };
    }
    // The integrity gate passed long before this point; the entrypoint may now
    // become executable (cut §7.2 п.6 ordering).
    await chmod(stagedBinary, 0o755);

    await rename(stagingRoot, installDir);
    await rm(tarballPath, { force: true });
    return { ok: true, version, installDir, binaryPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    cleanup();
  }
}

/** Removes one installed version tree (used when the post-install trust/doctor gate refuses it). */
export function removeCodexInstall(installDir: string): void {
  rmSync(installDir, { recursive: true, force: true });
}

// ── IPC surface (lane-B owned; main/index.ts wires registerCodexInstallIpc — see the lane report for the snippet) ──

export const CODEX_INSTALL_CHANNEL = "anycode:codex-install";
export const CODEX_RISK_ACCEPT_CHANNEL = "anycode:codex-risk-accept";
export const CODEX_SUPPORT_STATUS_CHANNEL = "anycode:codex-support-status";
export const CODEX_MANIFEST_REFRESH_CHANNEL = "anycode:codex-manifest-refresh";

export interface CodexInstallControllerDeps {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  caps?: Partial<CodexInstallCaps>;
  /** Reads `settings.codex.riskAcceptedVersions` fresh every call. */
  readRiskAcceptedVersions: () => Promise<string[]>;
  /** Persists through the settings-set pipeline (same custody as codex-ipc: only a path/version list, никогда account material). */
  writeCodexSettings: (patch: { binaryPath?: string; riskAcceptedVersions?: string[] }) => Promise<unknown>;
  /** Fired after a successful install / risk acceptance so main pushes ENGINES_CHANGED and rechecks. */
  onChanged?: () => void;
  /** DI seams; production = the real trust gate + doctor. */
  trust?: (binaryPath: string) => string | null;
  runDoctor?: (binaryPath: string, options?: RunCodexDoctorOptions) => Promise<CodexDoctorReport>;
}

export type CodexInstallControllerResult =
  | { ok: true; version: string; binaryPath: string; report: CodexDoctorReport }
  | { ok: false; error: string };

export interface CodexInstallController {
  /** Installs `version` (default: the active manifest's `recommended`), gated by the version policy, the trust check, and a post-install doctor pass. */
  install(version?: string): Promise<CodexInstallControllerResult>;
  /** §7.4 "use anyway": records per-version consent and updates the active policy so the next doctor pass honors it. */
  acceptRisk(version: string): Promise<{ ok: boolean; error?: string }>;
  /** The current policy facts for the Settings pane (range string, recommended, acceptances). */
  supportStatus(): Promise<{ supportedRange: string; recommended: string; riskAcceptedVersions: string[] }>;
  /** Explicit "Refresh" button: force-refreshes the git manifest and applies it to the active policy. */
  refreshManifest(): Promise<{ source: string; supportedRange: string }>;
}

export function createCodexInstallController(deps: CodexInstallControllerDeps): CodexInstallController {
  const trust = deps.trust ?? ((binaryPath: string) => checkCodexBinaryPathTrust(binaryPath, undefined, deps.platform ?? process.platform));
  const runDoctor = deps.runDoctor ?? runCodexDoctor;
  const manifestCacheFile = join(codexProfilesRoot(deps.home ?? homedir()), "manifest.json");
  let inFlight = false;

  async function installGated(requested: string | undefined): Promise<CodexInstallControllerResult> {
    const policy = activeCodexVersionPolicy();
    const version = requested ?? policy.manifest.recommended;
    const verdict = codexVersionVerdict(version, policy);
    if (!verdict.allowed) {
      return { ok: false, error: `version ${version} is outside the supported range (${verdict.supportedRange}) and has no risk acceptance` };
    }
    const installed = await installCodexVersion(version, {
      ...(deps.home !== undefined ? { home: deps.home } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.arch !== undefined ? { arch: deps.arch } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.caps !== undefined ? { caps: deps.caps } : {}),
    });
    if (!installed.ok) return installed;
    const fresh = installed.alreadyInstalled !== true;
    const refuse = (error: string): CodexInstallControllerResult => {
      // A freshly installed tree that failed its gate is removed (cut §7.2
      // п.7); a pre-existing install is refused but left in place — deleting
      // a tree the user may be running from is not this handler's call.
      if (fresh) removeCodexInstall(installed.installDir);
      return { ok: false, error };
    };
    const untrusted = trust(installed.binaryPath);
    if (untrusted !== null) return refuse(untrusted);
    const report = await runDoctor(installed.binaryPath);
    if (report.status === "error" || report.status === "update_required" || report.status === "not_installed") {
      return refuse(report.error ?? `installed binary failed its doctor pass (${report.status})`);
    }
    await deps.writeCodexSettings({ binaryPath: installed.binaryPath });
    deps.onChanged?.();
    return { ok: true, version: installed.version, binaryPath: installed.binaryPath, report };
  }

  return {
    install(version?: string): Promise<CodexInstallControllerResult> {
      if (inFlight) return Promise.resolve({ ok: false, error: "a codex install is already in progress" });
      inFlight = true;
      return installGated(version).finally(() => {
        inFlight = false;
      });
    },

    async acceptRisk(version: string): Promise<{ ok: boolean; error?: string }> {
      const policy = activeCodexVersionPolicy();
      const verdict = codexVersionVerdict(version, { manifest: policy.manifest, riskAcceptedVersions: [version] });
      // The one-element acceptance probe above says "allowed" for anything at
      // or above the floor; a refusal here is exactly malformed-or-below-floor.
      if (!verdict.allowed) {
        return { ok: false, error: `version ${version} cannot be risk-accepted (below the compiled floor or malformed)` };
      }
      const current = await deps.readRiskAcceptedVersions();
      const next = current.includes(version) ? current : [...current, version];
      await deps.writeCodexSettings({ riskAcceptedVersions: next });
      setActiveCodexVersionPolicy({ riskAcceptedVersions: next });
      deps.onChanged?.();
      return { ok: true };
    },

    async supportStatus() {
      const policy = activeCodexVersionPolicy();
      return {
        supportedRange: policy.manifest.supported.map((entry) => entry.range).join(" || "),
        recommended: policy.manifest.recommended,
        riskAcceptedVersions: [...policy.riskAcceptedVersions],
      };
    },

    async refreshManifest() {
      const result = await refreshCodexManifest({ cacheFile: manifestCacheFile, force: true, ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}) });
      setActiveCodexVersionPolicy({ manifest: result.manifest });
      deps.onChanged?.();
      return { source: result.source, supportedRange: result.manifest.supported.map((entry) => entry.range).join(" || ") };
    },
  };
}

/** ipcMain wiring for the controller above — called from main/index.ts (the register call is the ONLY index.ts delta this lane needs; snippet in the lane report). */
export function registerCodexInstallIpc(deps: CodexInstallControllerDeps): CodexInstallController {
  const controller = createCodexInstallController(deps);
  ipcMain.handle(CODEX_INSTALL_CHANNEL, (_event, args?: unknown) => {
    const version = (args as { version?: unknown } | undefined)?.version;
    return controller.install(typeof version === "string" ? version : undefined);
  });
  ipcMain.handle(CODEX_RISK_ACCEPT_CHANNEL, (_event, args?: unknown) => {
    const version = (args as { version?: unknown } | undefined)?.version;
    if (typeof version !== "string") return { ok: false, error: "a version string is required" };
    return controller.acceptRisk(version);
  });
  ipcMain.handle(CODEX_SUPPORT_STATUS_CHANNEL, () => controller.supportStatus());
  ipcMain.handle(CODEX_MANIFEST_REFRESH_CHANNEL, () => controller.refreshManifest());
  return controller;
}
