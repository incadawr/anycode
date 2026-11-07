import assert from 'node:assert/strict';
import { openSync, readSync, closeSync } from 'node:fs';

/** Inspect app-owned archive paths; dependency packages may ship their own scripts. */
export function assertProductionPaths(paths) {
  const matched = paths.find(path =>
    !/(?:^|\/)node_modules(?:\/|$)/.test(path) &&
    /(?:session-peers-smoke|engine-smoke-fixtures|native-double\.mjs|compact-fixtures|(?:^|\/)scripts(?:\/|$))/.test(path));
  assert(!matched, `Development smoke shipped in package: ${matched}`);
}

/** Read only the archive header, without executing or loading packaged code. */
export function assertSmokeAbsentFromAsar(file) {
  const fd = openSync(file, 'r');
  let paths;
  try {
    try {
      const prefix = Buffer.alloc(16);
      assert.equal(readSync(fd, prefix, 0, 16, 0), 16, 'Truncated archive prefix');
      const length = prefix.readUInt32LE(12);
      assert(length > 0 && length < 64 * 1024 * 1024, 'Invalid archive header length');
      const header = Buffer.alloc(length);
      assert.equal(readSync(fd, header, 0, length, 16), length, 'Truncated archive header');
      paths = [];
      function walk(files, base = '') {
        assert(files && typeof files === 'object' && !Array.isArray(files), 'Invalid archive files');
        for (const [name, entry] of Object.entries(files)) {
          const path = `${base}/${name}`;
          paths.push(path);
          if (entry.files) walk(entry.files, path);
        }
      }
      walk(JSON.parse(header.toString()).files);
    } catch (error) {
      throw new Error(`Cannot parse archive header: ${error.message}`, { cause: error });
    }
  } finally {
    closeSync(fd);
  }
  assertProductionPaths(paths);
}
