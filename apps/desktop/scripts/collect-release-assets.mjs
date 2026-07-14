/**
 * Flattens the per-platform build artifacts into ONE directory to upload to ONE
 * draft release, and refuses to do it silently wrong.
 *
 * WHY THIS EXISTS. The four `package` jobs used to each publish themselves
 * (`electron-builder --publish always`). GitHub does not key DRAFT releases by
 * tag, so four concurrent jobs created SEVERAL drafts for the same tag and the
 * artifacts scattered across them — observed on the v0.0.1 run: three drafts,
 * none of them complete. Publishing is therefore done exactly once, by a single
 * job, from the uploaded artifacts — and this script is what assembles them.
 *
 * THE COLLISION THAT MATTERS. Both macOS jobs emit a file called
 * `latest-mac.yml` — the auto-update feed electron-updater reads. They are NOT
 * duplicates: each lists only its OWN architecture. Copying them into one
 * directory would let one silently overwrite the other, and half of macOS users
 * would then be offered a build for the wrong architecture. They are merged
 * instead: the union of their `files:` entries, which is exactly the feed a
 * single electron-builder run emits when it packages both arches at once.
 *
 * Every OTHER same-named file is a hard error, never an overwrite: a collision
 * we have not reasoned about is a defect, not a formatting detail.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const MAC_FEED = "latest-mac.yml";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/**
 * A deliberately STRICT reader for the one YAML shape electron-builder emits
 * here — not a general parser. Anything it does not recognize is a hard failure
 * naming the line: a feed we merged by guesswork is worse than a red build.
 */
function parseMacFeed(path) {
  const lines = readFileSync(path, "utf8").split("\n");
  const feed = { version: null, files: [], path: null, sha512: null, releaseDate: null };
  let entry = null;
  let inFiles = false;

  for (const raw of lines) {
    if (raw.trim() === "") continue;
    const line = raw.replace(/\s+$/, "");

    const top = /^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line);
    if (top !== null) {
      const [, key, value] = top;
      inFiles = key === "files";
      if (inFiles) {
        if (value !== "") fail(`${path}: expected a block sequence under 'files:', got '${value}'`);
        continue;
      }
      if (!(key in feed)) fail(`${path}: unexpected top-level key '${key}'`);
      feed[key] = value.replace(/^'(.*)'$/, "$1");
      continue;
    }

    if (!inFiles) fail(`${path}: unexpected line outside 'files:': ${line}`);

    const item = /^\s+-\s+url:\s*(.+)$/.exec(line);
    if (item !== null) {
      entry = { url: item[1], sha512: null, size: null };
      feed.files.push(entry);
      continue;
    }

    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field === null || entry === null) fail(`${path}: unrecognized 'files:' line: ${line}`);
    entry[field[1]] = field[2];
  }

  if (feed.version === null || feed.files.length === 0 || feed.path === null) {
    fail(`${path}: missing version/files/path — not a latest-mac.yml this script understands`);
  }
  for (const file of feed.files) {
    if (file.sha512 === null || file.size === null) fail(`${path}: entry '${file.url}' is missing sha512/size`);
  }
  return feed;
}

/**
 * The union of both arches' feeds. `path`/`sha512` (the legacy single-artifact
 * pointer an older electron-updater falls back to when it ignores `files`) is
 * pinned to the x64 zip on purpose: an Intel Mac cannot run an arm64 build,
 * while an Apple Silicon Mac can run the x64 one under Rosetta. The arch-aware
 * client reads `files` and picks its own build regardless.
 */
function mergeMacFeeds(paths) {
  const feeds = paths.map(parseMacFeed);
  const versions = new Set(feeds.map((feed) => feed.version));
  if (versions.size !== 1) fail(`${MAC_FEED} inputs disagree on version: ${[...versions].join(", ")}`);

  const byUrl = new Map();
  for (const feed of feeds) {
    for (const file of feed.files) byUrl.set(file.url, file);
  }
  const files = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));

  const legacy = feeds.find((feed) => !feed.path.includes("arm64")) ?? feeds[0];
  const releaseDate = feeds.map((feed) => feed.releaseDate).sort().at(-1);

  const body = [
    `version: ${feeds[0].version}`,
    "files:",
    ...files.flatMap((file) => [`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`]),
    `path: ${legacy.path}`,
    `sha512: ${legacy.sha512}`,
    `releaseDate: '${releaseDate}'`,
  ];
  return body.join("\n") + "\n";
}

const [stagingDir, outDir] = process.argv.slice(2);
if (stagingDir === undefined || outDir === undefined) fail("usage: collect-release-assets.mjs <stagingDir> <outDir>");

const byName = new Map();
for (const path of walk(stagingDir)) {
  const name = basename(path);
  byName.set(name, [...(byName.get(name) ?? []), path]);
}
if (byName.size === 0) fail(`no artifacts found under ${stagingDir}`);

mkdirSync(outDir, { recursive: true });
for (const [name, paths] of [...byName].sort()) {
  const target = join(outDir, name);
  if (paths.length === 1) {
    copyFileSync(paths[0], target);
  } else if (name === MAC_FEED) {
    writeFileSync(target, mergeMacFeeds(paths));
    console.log(`  merged ${paths.length} × ${name} (both macOS architectures in one update feed)`);
    continue;
  } else {
    fail(`two build jobs produced a file called '${name}':\n  ${paths.join("\n  ")}\nOne would silently overwrite the other.`);
  }
  console.log(`  ${name}`);
}
