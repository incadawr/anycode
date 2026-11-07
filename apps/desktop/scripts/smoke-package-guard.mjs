import assert from 'node:assert/strict';
import { openSync, readSync, closeSync } from 'node:fs';
/** Inspect archive paths without executing packaged code or loading its dependencies. */
export function assertProductionPaths(paths) {
  assert(!paths.some(path => /(?:session-peers-smoke|engine-smoke-fixtures|native-double\.mjs|compact-fixtures|(?:^|\/)scripts\/)/.test(path)), 'Development smoke shipped in package');
}
export function assertSmokeAbsentFromAsar(file) {
  const fd = openSync(file,'r');
  try {
    const prefix = Buffer.alloc(16);
    assert.equal(readSync(fd,prefix,0,16,0),16);
    const length = prefix.readUInt32LE(12);
    assert(length > 0 && length < 64*1024*1024,'Invalid archive header');
    const header = Buffer.alloc(length);
    assert.equal(readSync(fd,header,0,length,16),length);
    const paths = [];
    function walk(files,base = '') {
      for (const [name,entry] of Object.entries(files)) {
        const path = `${base}/${name}`; paths.push(path);
        if (entry.files) walk(entry.files,path);
      }
    }
    walk(JSON.parse(header.toString()).files); assertProductionPaths(paths);
  } finally { closeSync(fd); }
}
