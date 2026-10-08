import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveFullChildReport } from "./child-report-spill.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "child-report-spill-"));
  dirs.push(dir);
  return dir;
}

describe("saveFullChildReport", () => {
  it("writes the whole report under the child's session id and returns its path", () => {
    const dir = join(tempDir(), "reports");
    const path = saveFullChildReport(dir, "984b38e5-1e3c", "# Plan\n\nfull text");
    expect(path).toBe(join(dir, "984b38e5-1e3c.md"));
    expect(readFileSync(path!, "utf8")).toBe("# Plan\n\nfull text");
  });

  it("keeps a hostile id inside the directory", () => {
    const dir = tempDir();
    const path = saveFullChildReport(dir, "../../etc/x", "t");
    expect(path).toBe(join(dir, ".._.._etc_x.md"));
  });

  it("returns undefined instead of throwing when the directory cannot be created", () => {
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "");
    expect(saveFullChildReport(join(blocker, "sub"), "id", "t")).toBeUndefined();
  });
});
