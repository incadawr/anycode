/**
 * In-house `.tgz` extractor (Taskana 4732 S1-B, design §4): ustar reader over
 * `zlib.gunzipSync`, NO new npm deps, with the full extraction-hardening cap
 * set. The threat model is a malicious archive: every structural surprise is
 * a REFUSAL, never a best-effort skip.
 *
 * Rules (design §4 verbatim):
 *  - regular files and directories ONLY — symlink/hardlink/device/FIFO type
 *    flags reject the whole archive;
 *  - normalized contained paths — absolute, `..`-escape and drive-letter
 *    names reject;
 *  - caps: 20 MB compressed, 50 MB uncompressed total, 2,000 entries,
 *    5 MB per file — any overflow rejects (`too_large`);
 *  - files 0644, dirs 0755;
 *  - optional single top-level dir stripped (npm-style packaging);
 *  - the manifest must be at `.anycode-plugin/plugin.json`.
 *
 * Pure byte-in/byte-out: `extractTgz(buffer, options)` works over an
 * in-memory Buffer and an injected writer, so tests build fixture tars with
 * `makeTarball` (below) and never touch the disk/network.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import {
  PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_ARCHIVE_MAX_FILE_BYTES,
  PLUGIN_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
} from "../../shared/plugin-trust.js";

export type ArchiveRefusal =
  | "invalid" // not gzip, not tar, malformed header
  | "too_large" // any cap overflow
  | "unsupported_type" // symlink/hardlink/device/FIFO
  | "unsafe_path"; // absolute, `..`, drive letter

export interface ArchiveEntry {
  /** Normalized RELATIVE path (posix separators), top-level dir already stripped. */
  path: string;
  /** File mode REQUESTED by the extractor: 0644 files, 0755 dirs (design §4). */
  mode: number;
  type: "file" | "dir";
  /** File bytes (files only). */
  data?: Buffer;
}

export interface ExtractResult {
  ok: boolean;
  entries?: ArchiveEntry[];
  refusal?: ArchiveRefusal;
  detail?: string;
}

// ── ustar parsing ──

/** GNU/ustar header field offsets (512-byte header blocks). */
const BLOCK = 512;

/** Octal header field → number; null/undefined when malformed. */
function octal(field: Buffer): number | undefined {
  const raw = field.toString("utf8").replace(/\0.*$/s, "").trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) return undefined;
  return parseInt(raw, 8);
}

/** A parsed tar member header. */
interface TarHeader {
  name: string;
  size: number;
  typeflag: string;
  prefix: string;
  mode: number;
}

function parseHeader(block: Buffer): TarHeader | undefined {
  const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const mode = octal(block.subarray(100, 108));
  const size = octal(block.subarray(124, 136));
  if (mode === undefined || size === undefined) {
    return undefined;
  }
  const typeflag = String.fromCharCode(block[156] ?? 0);
  const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
  return { name, size, typeflag, prefix, mode };
}

/**
 * True when a normalized member name is CONTAINED and safe: relative, no
 * `..` segment, no leading `/`, no Windows drive letter (`C:` at the start
 * or after any separator), no empty `//` weirdness. Syntactic only — the
 * extractor never writes to disk, so containment is about the OUTPUT path.
 */
export function isSafeMemberPath(name: string): boolean {
  if (name === "" || name === "/" || name === ".") return false;
  if (name.startsWith("/") || name.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return false;
  // A drive letter can also appear after a separator (a/./C: style tricks).
  if (segments.some((segment) => /^[A-Za-z]:/.test(segment))) return false;
  return true;
}

/**
 * Parses + validates a tar BUFFER (already decompressed). Refuses the whole
 * archive on any rule violation; accepts typeflags '0'/'\0' (regular) and
 * '5' (directory) only.
 */
export function parseTar(decompressed: Buffer): { ok: true; members: ArchiveEntry[] } | { ok: false; refusal: ArchiveRefusal; detail: string } {
  const members: ArchiveEntry[] = [];
  let totalUncompressed = 0;
  let offset = 0;

  while (offset + BLOCK <= decompressed.length) {
    const header = decompressed.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks end the archive; a single all-zero block
    // at the very end (a truncated-but-complete tar) also ends it.
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const parsed = parseHeader(header);
    if (parsed === undefined) {
      return { ok: false, refusal: "invalid", detail: `malformed tar header at offset ${offset}` };
    }
    const fullName = parsed.prefix !== "" ? `${parsed.prefix}/${parsed.name}` : parsed.name;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + parsed.size;
    if (dataEnd > decompressed.length) {
      return { ok: false, refusal: "invalid", detail: `member ${fullName} extends past the archive end` };
    }
    const data = decompressed.subarray(dataStart, dataEnd);
    // Advance past the member data, padded to the next block boundary.
    offset = dataStart + Math.ceil(parsed.size / BLOCK) * BLOCK;

    if (members.length >= PLUGIN_ARCHIVE_MAX_ENTRIES) {
      return { ok: false, refusal: "too_large", detail: `more than ${PLUGIN_ARCHIVE_MAX_ENTRIES} entries` };
    }

    const isRegular = parsed.typeflag === "0" || parsed.typeflag === "\0";
    const isDir = parsed.typeflag === "5";
    if (!isRegular && !isDir) {
      return { ok: false, refusal: "unsupported_type", detail: `member ${fullName} has unsupported typeflag ${JSON.stringify(parsed.typeflag)} (only regular files and directories allowed)` };
    }

    const normalized = fullName.replace(/\/+$/, ""); // dirs often carry a trailing /
    if (!isSafeMemberPath(normalized)) {
      return { ok: false, refusal: "unsafe_path", detail: `member path ${JSON.stringify(fullName)} is not a contained relative path` };
    }

    if (isRegular) {
      totalUncompressed += parsed.size;
      if (parsed.size > PLUGIN_ARCHIVE_MAX_FILE_BYTES) {
        return { ok: false, refusal: "too_large", detail: `file ${normalized} is ${parsed.size} bytes (cap ${PLUGIN_ARCHIVE_MAX_FILE_BYTES})` };
      }
      if (totalUncompressed > PLUGIN_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
        return { ok: false, refusal: "too_large", detail: `archive uncompressed total exceeds ${PLUGIN_ARCHIVE_MAX_UNCOMPRESSED_BYTES} bytes` };
      }
      members.push({ path: normalized, mode: 0o644, type: "file", data: Buffer.from(data) });
    } else {
      members.push({ path: normalized, mode: 0o755, type: "dir" });
    }
  }

  if (members.length === 0) {
    return { ok: false, refusal: "invalid", detail: "archive holds no members" };
  }
  return { ok: true, members };
}

/** The manifest location every archive must carry (design §4). */
export const MANIFEST_PATH = ".anycode-plugin/plugin.json";

/**
 * The default top-level dir stripping: `pkg-1.0.0/<rest>` → `<rest>`. When
 * the archive has NO wrapper (the manifest sits at the root as
 * `.anycode-plugin/plugin.json`) or has multiple roots, nothing is stripped
 * — the strip is only applied when it would expose exactly one manifest at
 * the expected depth.
 */
function stripSingleTopDir(members: ArchiveEntry[]): ArchiveEntry[] {
  const tops = new Set(members.map((m) => m.path.split("/")[0]));
  if (tops.size !== 1) {
    return members; // multiple roots or a rootless flat archive: no strip
  }
  const only = [...tops][0]!;
  const stripped = members.map((m) => ({ ...m, path: m.path === only ? only : m.path.slice(only.length + 1) }));
  // Strip only when it yields the manifest at its canonical root position
  // (`.anycode-plugin/plugin.json`) — a wrapper dir plus manifest inside it.
  if (stripped.some((m) => m.path === MANIFEST_PATH)) {
    // The wrapper dir itself collapses to "" (the archive root).
    return stripped.filter((m) => m.path !== "").map((m) => (m.path === only ? m : m));
  }
  return members;
}

/**
 * Full pipeline: cap the compressed bytes → gunzip → parse tar → strip an
 * optional single top-level dir → verify the manifest member exists.
 */
export function extractTgz(
  compressed: Buffer,
  options: { stripTopDir?: boolean } = {},
): { ok: true; entries: ArchiveEntry[] } | { ok: false; refusal: ArchiveRefusal; detail: string } {
  if (compressed.length > PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES) {
    return { ok: false, refusal: "too_large", detail: `compressed archive is ${compressed.length} bytes (cap ${PLUGIN_ARCHIVE_MAX_COMPRESSED_BYTES})` };
  }
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(compressed);
  } catch (error) {
    return { ok: false, refusal: "invalid", detail: `not a gzip stream: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (decompressed.length > PLUGIN_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
    return { ok: false, refusal: "too_large", detail: `uncompressed archive is ${decompressed.length} bytes (cap ${PLUGIN_ARCHIVE_MAX_UNCOMPRESSED_BYTES})` };
  }
  const parsed = parseTar(decompressed);
  if (!parsed.ok) {
    return parsed;
  }
  const entries = options.stripTopDir === false ? parsed.members : stripSingleTopDir(parsed.members);
  const hasManifest = entries.some(
    (entry) => entry.type === "file" && (entry.path === MANIFEST_PATH || entry.path.endsWith(`/${MANIFEST_PATH}`)),
  );
  if (!hasManifest) {
    return { ok: false, refusal: "invalid", detail: `archive does not carry ${MANIFEST_PATH}` };
  }
  return { ok: true, entries };
}

// ── test/authoring helper: build a ustar tarball in memory ──

/** One member spec for `makeTarball`. */
export interface TarballMember {
  path: string;
  type?: "file" | "dir";
  data?: Buffer | string;
  /** Overrides the typeflag (test-only: '1' hardlink, '2' symlink, ...). */
  typeflagOverride?: string;
  /** Overrides the encoded size (test-only: bomb padding). */
  sizeOverride?: number;
}

function writeOctal(block: Buffer, offset: number, length: number, value: number, base = 8): void {
  const text = value.toString(base).padStart(length - 1, "0");
  block.write(text, offset, length - 1, "utf8");
  block[offset + length - 1] = 0;
}

/**
 * Builds a (gzipped by default) ustar tarball from member specs. Used by
 * the tests here AND by `scripts/plugins/sign-index.mjs`'s companion
 * packaging flow — one implementation of the format on both sides.
 */
export function makeTarball(members: TarballMember[], options: { gzip?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const header = Buffer.alloc(BLOCK, 0);
    const typeflag = member.typeflagOverride ?? (member.type === "dir" ? "5" : "0");
    const data = member.type === "dir" || member.typeflagOverride !== undefined ? Buffer.alloc(0) : Buffer.isBuffer(member.data) ? member.data : Buffer.from(member.data ?? "", "utf8");
    const size = member.sizeOverride ?? data.length;
    const name = member.path;
    if (Buffer.byteLength(name) <= 100) {
      header.write(name, 0, 100, "utf8");
    } else {
      // split into prefix/name at the last '/'
      const split = name.lastIndexOf("/", Math.max(0, name.length - 101));
      header.write(name.slice(split + 1), 0, 100, "utf8");
      header.write(name.slice(0, split), 345, 155, "utf8");
    }
    writeOctal(header, 100, 8, member.type === "dir" ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0); // uid
    writeOctal(header, 116, 8, 0); // gid
    writeOctal(header, 124, 12, size); // SIZE (ustar offset 124 — 136 is mtime!)
    writeOctal(header, 136, 12, 0); // mtime
    writeOctal(header, 148, 8, 0); // checksum placeholder
    header[156] = typeflag.charCodeAt(0);
    header.write("ustar", 257, 6, "utf8"); // magic
    header.write("00", 263, 2, "utf8"); // version
    // checksum: spaces during computation
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeOctal(header, 148, 8, checksum);
    header[148 + 7] = 0x20; // standard: "NNNNNN\0 " forms; this reader accepts trimmed octal
    chunks.push(header, data);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive
  const tar = Buffer.concat(chunks);
  return options.gzip === false ? tar : gzipSync(tar);
}
