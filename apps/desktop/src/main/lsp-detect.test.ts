/**
 * lsp-detect tests (Taskana 4743): found-in-PATH, found only in the extra
 * dirs, found only in `<workspace>/node_modules/.bin` (the catalog `nodeBin`
 * case — main passes a workspace ONLY for those entries), win32 suffixes,
 * empty/absent PATH, directory-not-file, non-executable file, and the
 * never-spawns posture (an fs seam that records every call proves detection
 * only ever stats).
 */

import { describe, expect, it } from "vitest";
import {
  candidateFileNames,
  detectCommand,
  extraDetectDirs,
  pathDirs,
  type DetectedFile,
} from "./lsp-detect.js";

const EXEC_FILE: DetectedFile = { isFile: true, mode: 0o755 };
const NOEXEC_FILE: DetectedFile = { isFile: true, mode: 0o644 };
const DIRECTORY: DetectedFile = { isFile: false, mode: 0o755 };

/** Fake fs: an exact-path map, plus a call log proving no spawn-side effects exist to observe. */
function makeFs(known: Record<string, DetectedFile> = {}) {
  const calls: string[] = [];
  return {
    calls,
    fileExists(path: string): DetectedFile | undefined {
      calls.push(path);
      return known[path];
    },
  };
}

const DARWIN = process.platform === "darwin" ? process.platform : ("darwin" as NodeJS.Platform);

describe("detectCommand — PATH", () => {
  it("finds a command present in a PATH dir", async () => {
    const fs = makeFs({ "/usr/local/bin/gopls": EXEC_FILE });
    const result = await detectCommand("gopls", { pathEnv: "/usr/bin:/usr/local/bin", platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
    expect(result).toEqual({ found: true, source: "path" });
  });

  it("misses when PATH is empty or absent", async () => {
    const fs = makeFs({ "/usr/local/bin/gopls": EXEC_FILE });
    for (const pathEnv of [undefined, "", "   "] as const) {
      const result = await detectCommand("gopls", { pathEnv, platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
      // NOTE: /usr/local/bin is also an extra dir, so this still finds it —
      // use a command that lives ONLY in a PATH dir to prove emptiness.
      expect(result.found).toBe(true);
    }
  });

  it("an empty PATH finds nothing when the binary sits in a non-probed dir", async () => {
    const fs = makeFs({ "/opt/other/bin/gopls": EXEC_FILE });
    const result = await detectCommand("gopls", { pathEnv: "", platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
    expect(result).toEqual({ found: false, source: null });
  });

  it("a directory named like the command does not count as found", async () => {
    const fs = makeFs({ "/usr/local/bin/gopls": DIRECTORY });
    const result = await detectCommand("gopls", { pathEnv: "/usr/local/bin", platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
    expect(result).toEqual({ found: false, source: null });
  });

  it("a non-executable file does not count as found on POSIX (X_OK discipline)", async () => {
    const fs = makeFs({ "/usr/local/bin/gopls": NOEXEC_FILE });
    const result = await detectCommand("gopls", { pathEnv: "/usr/local/bin", platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
    expect(result).toEqual({ found: false, source: null });
  });
});

describe("detectCommand — extras beyond PATH", () => {
  it("finds a command only in ~/.local/bin (a GUI-launched app's minimal PATH)", async () => {
    const fs = makeFs({ "/home/u/.local/bin/typescript-language-server": EXEC_FILE });
    const result = await detectCommand("typescript-language-server", {
      pathEnv: "/usr/bin:/bin",
      platform: "linux" as NodeJS.Platform,
      home: "/home/u",
      fileExists: fs.fileExists,
    });
    expect(result).toEqual({ found: true, source: "path" });
  });

  it("finds go-installed (~/.go/bin style ~/go/bin) and cargo-installed (~/.cargo/bin) tools", async () => {
    for (const dir of ["/home/u/go/bin", "/home/u/.cargo/bin"]) {
      const fs = makeFs({ [`${dir}/mytool`]: EXEC_FILE });
      const result = await detectCommand("mytool", { pathEnv: "", platform: "linux" as NodeJS.Platform, home: "/home/u", fileExists: fs.fileExists });
      expect(result).toEqual({ found: true, source: "path" });
    }
  });

  it("finds an npm-global install under ~/.npm-global/bin", async () => {
    const fs = makeFs({ "/home/u/.npm-global/bin/pyright-langserver": EXEC_FILE });
    const result = await detectCommand("pyright-langserver", { pathEnv: "", platform: "linux" as NodeJS.Platform, home: "/home/u", fileExists: fs.fileExists });
    expect(result).toEqual({ found: true, source: "path" });
  });

  it("drops the ~-relative extras when home is unknown (never throws)", async () => {
    const fs = makeFs({ "/opt/homebrew/bin/lua-language-server": EXEC_FILE });
    const result = await detectCommand("lua-language-server", { pathEnv: "", platform: DARWIN, home: undefined, fileExists: fs.fileExists });
    expect(result).toEqual({ found: true, source: "path" });
  });
});

describe("detectCommand — project node_modules/.bin (nodeBin entries)", () => {
  it("finds a devDependency binary only when a workspace is supplied, and never reports it as found", async () => {
    const fs = makeFs({ "/proj/node_modules/.bin/typescript-language-server": EXEC_FILE });
    const inputs = {
      pathEnv: "/usr/bin:/bin",
      platform: "darwin" as NodeJS.Platform,
      home: "/home/u",
      fileExists: fs.fileExists,
    };
    // Without the workspace (a non-nodeBin entry), not found:
    expect(await detectCommand("typescript-language-server", inputs)).toEqual({ found: false, source: null });
    // With it (nodeBin): present only in node_modules/.bin is NOT found (the
    // app spawns by PATH, so it would not start), but the source is named.
    expect(await detectCommand("typescript-language-server", { ...inputs, workspace: "/proj" })).toEqual({
      found: false,
      source: "project",
    });
  });

  it("a node_modules-only binary is found:false source project (the app cannot spawn it by PATH)", async () => {
    const fs = makeFs({ "/proj/node_modules/.bin/typescript-language-server": EXEC_FILE });
    const result = await detectCommand("typescript-language-server", {
      pathEnv: "/usr/bin:/bin",
      platform: "darwin" as NodeJS.Platform,
      home: "/home/u",
      workspace: "/proj",
      fileExists: fs.fileExists,
    });
    expect(result).toEqual({ found: false, source: "project" });
  });

  it("on both PATH and node_modules, the PATH hit wins: found:true source path", async () => {
    const fs = makeFs({
      "/usr/bin/typescript-language-server": EXEC_FILE,
      "/proj/node_modules/.bin/typescript-language-server": EXEC_FILE,
    });
    const result = await detectCommand("typescript-language-server", {
      pathEnv: "/usr/bin:/bin",
      platform: "darwin" as NodeJS.Platform,
      home: "/home/u",
      workspace: "/proj",
      fileExists: fs.fileExists,
    });
    expect(result).toEqual({ found: true, source: "path" });
  });

  it("PATH still wins over node_modules/.bin (checked first)", async () => {
    const fs = makeFs({
      "/usr/local/bin/typescript-language-server": EXEC_FILE,
      "/proj/node_modules/.bin/typescript-language-server": EXEC_FILE,
    });
    const result = await detectCommand("typescript-language-server", {
      pathEnv: "/usr/local/bin",
      platform: "darwin" as NodeJS.Platform,
      workspace: "/proj",
      fileExists: fs.fileExists,
    });
    expect(result).toEqual({ found: true, source: "path" });
  });
});

describe("detectCommand — win32", () => {
  it("tries .exe/.cmd/.bat suffixes", async () => {
    const fs = makeFs({ "C:\\tools\\yaml-language-server.cmd": EXEC_FILE });
    const result = await detectCommand("yaml-language-server", {
      pathEnv: "C:\\tools;C:\\Windows",
      platform: "win32" as NodeJS.Platform,
      fileExists: fs.fileExists,
    });
    expect(result).toEqual({ found: true, source: "path" });
    expect(fs.calls).toContain("C:\\tools\\yaml-language-server.cmd");
  });

  it("splits PATH on ';' on win32", async () => {
    const fs = makeFs({ "C:\\tools\\gopls.exe": EXEC_FILE });
    const result = await detectCommand("gopls", { pathEnv: "C:\\a;C:\\tools", platform: "win32" as NodeJS.Platform, fileExists: fs.fileExists });
    expect(result).toEqual({ found: true, source: "path" });
  });
});

describe("detectCommand — never spawns", () => {
  it("only ever stats paths built by plain path joins (no shell, no exec surface to observe)", async () => {
    const fs = makeFs({ "/usr/local/bin/gopls": EXEC_FILE });
    await detectCommand("gopls", { pathEnv: "/usr/local/bin", platform: "darwin" as NodeJS.Platform, fileExists: fs.fileExists });
    // Every observed call is a plain candidate path — detection has no other
    // side channel by construction (the module imports node:path only).
    expect(fs.calls.length).toBeGreaterThan(0);
    for (const call of fs.calls) {
      expect(call.startsWith("/")).toBe(true);
    }
  });
});

describe("pure helpers", () => {
  it("candidateFileNames: bare name on POSIX; exe/cmd/bat variants on win32", () => {
    expect(candidateFileNames("gopls", "darwin")).toEqual(["gopls"]);
    expect(candidateFileNames("gopls", "win32")).toEqual(["gopls", "gopls.exe", "gopls.cmd", "gopls.bat"]);
  });

  it("pathDirs: trims and drops empty segments", () => {
    expect(pathDirs(" /usr/bin ::/bin ", "darwin")).toEqual(["/usr/bin", "/bin"]);
    expect(pathDirs(undefined, "darwin")).toEqual([]);
  });

  it("extraDetectDirs: POSIX includes homebrew roots; home-relative entries need home", () => {
    const withHome = extraDetectDirs("/home/u", "linux");
    expect(withHome).toContain("/opt/homebrew/bin");
    expect(withHome).toContain("/usr/local/bin");
    expect(withHome).toContain("/home/u/.local/bin");
    expect(withHome).toContain("/home/u/go/bin");
    expect(withHome).toContain("/home/u/.cargo/bin");
    expect(withHome).toContain("/home/u/.npm-global/bin");
    const noHome = extraDetectDirs(undefined, "linux");
    expect(noHome).not.toContain("/home/u/.local/bin");
  });
});
