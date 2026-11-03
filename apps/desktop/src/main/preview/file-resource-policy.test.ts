/**
 * Unit tests for the file-subresource policy of local HTML previews
 * (preview/file-resource-policy.ts).
 *
 * Every path here is SYNTHETIC — the fake home (`/fake-home`) and the fake
 * workspace (`/fake-ws`) never exist on disk, and the real user home is
 * never read. The policy is a pure function (no fs, no I/O), so the tests
 * assert the RULES, not the environment.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedFileSubresource } from "./file-resource-policy.js";
import { buildFileResourceRoots, defaultFileResourceRoots } from "./file-resource-roots.js";

const FAKE_HOME = "/fake-home";
const FAKE_WS = "/fake-ws";
const FAKE_TMP = "/fake-tmp";

/** The common input shape; every test overrides only what it exercises. */
function input(overrides: {
  requestRealPath: string;
  documentRealPath: string;
  workspace?: string | undefined;
  home?: string;
  tmpdirs?: string[];
  platform?: NodeJS.Platform;
}): Parameters<typeof isAllowedFileSubresource>[0] {
  return {
    requestRealPath: overrides.requestRealPath,
    documentRealPath: overrides.documentRealPath,
    workspace: overrides.workspace,
    home: overrides.home ?? FAKE_HOME,
    tmpdirs: overrides.tmpdirs ?? [FAKE_TMP],
    platform: overrides.platform,
  };
}

describe("isAllowedFileSubresource — workspace documents", () => {
  it("allows a sibling of the document", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_WS}/app/style.css`,
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
  });

  it("allows a relative asset in a sibling directory of the workspace", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_WS}/shared/app.js`,
          documentRealPath: `${FAKE_WS}/app/pages/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
  });

  it("allows an image inside the document's own directory", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_WS}/app/img/logo.png`,
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
  });

  it("denies a file outside the workspace", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: "/etc/passwd",
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });
});

describe("isAllowedFileSubresource — the app profile and the home dir", () => {
  it("denies <home>/.anycode/auth.json", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/auth.json`,
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("denies <home>/.ssh/id_rsa", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.ssh/id_rsa`,
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("denies the profile even when the workspace IS the home dir's parent", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/auth.json`,
          documentRealPath: `${FAKE_HOME}/app/index.html`,
          workspace: FAKE_HOME,
        }),
      ),
    ).toBe(false);
  });

  it("a document under <home>/.anycode reads only its own tree", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/gen/app.js`,
          documentRealPath: `${FAKE_HOME}/.anycode/gen/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/auth.json`,
          documentRealPath: `${FAKE_HOME}/.anycode/gen/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("a workspace INSIDE the app profile never widens a document under it", () => {
    // The workspace is a broad-root SUBDIRECTORY (`<home>/.anycode/gen`):
    // the workspace-widening rule must not apply to a document that lives
    // under the app profile — its own directory is the whole allowed tree.
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/gen/secret.json`,
          documentRealPath: `${FAKE_HOME}/.anycode/gen/pages/index.html`,
          workspace: `${FAKE_HOME}/.anycode/gen`,
        }),
      ),
    ).toBe(false);
    // …and the document's own directory stays readable.
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/gen/pages/style.css`,
          documentRealPath: `${FAKE_HOME}/.anycode/gen/pages/index.html`,
          workspace: `${FAKE_HOME}/.anycode/gen`,
        }),
      ),
    ).toBe(true);
  });
});

describe("isAllowedFileSubresource — broad roots (home, temp)", () => {
  it("a document directly in the temp dir reads the temp dir's DIRECT children only", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_TMP}/logo.png`,
          documentRealPath: `${FAKE_TMP}/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
  });

  it("denies a nested file of the temp dir", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_TMP}/other-dir/secret.json`,
          documentRealPath: `${FAKE_TMP}/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("denies a deeply nested file of the temp dir", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_TMP}/a/b/c/secret.txt`,
          documentRealPath: `${FAKE_TMP}/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("a document directly in the home dir reads the home dir's DIRECT children only", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/notes.txt`,
          documentRealPath: `${FAKE_HOME}/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.ssh/id_rsa`,
          documentRealPath: `${FAKE_HOME}/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });

  it("a document directly in the app profile reads the profile's DIRECT children only", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/notes.txt`,
          documentRealPath: `${FAKE_HOME}/.anycode/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(true);
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/.anycode/gen/app.js`,
          documentRealPath: `${FAKE_HOME}/.anycode/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });
});

describe("isAllowedFileSubresource — the workspace never widens a broad root", () => {
  it("workspace == home does not widen anything", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_HOME}/secret.txt`,
          documentRealPath: `${FAKE_HOME}/app/index.html`,
          workspace: FAKE_HOME,
        }),
      ),
    ).toBe(false);
  });

  it("workspace == the temp dir does not widen anything", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_TMP}/other-dir/secret.json`,
          documentRealPath: `${FAKE_TMP}/app/index.html`,
          workspace: FAKE_TMP,
        }),
      ),
    ).toBe(false);
  });

  it("workspace above a broad root (an ancestor of the temp dir) does not widen anything", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${FAKE_TMP}/secret.json`,
          documentRealPath: `${FAKE_TMP}/app/index.html`,
          workspace: "/",
          tmpdirs: [FAKE_TMP],
        }),
      ),
    ).toBe(false);
  });
});

describe("isAllowedFileSubresource — platform rules", () => {
  it("darwin: a case-variant path compares equal (case-insensitive filesystem)", () => {
    // The document sits DIRECTLY in the temp dir (a broad root), so only the
    // direct children may be loaded — and the case-variant spelling of the
    // temp dir is the SAME directory on darwin.
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: "/FAKE-TMP/logo.png",
          documentRealPath: `${FAKE_TMP}/index.html`,
          platform: "darwin",
        }),
      ),
    ).toBe(true);
  });

  it("linux: the same case-variant path does NOT compare equal", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: "/FAKE-TMP/logo.png",
          documentRealPath: `${FAKE_TMP}/index.html`,
          platform: "linux",
        }),
      ),
    ).toBe(false);
  });

  it("darwin: a case-variant of a NESTED temp file is still denied", () => {
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: "/FAKE-TMP/other-dir/secret.json",
          documentRealPath: `${FAKE_TMP}/index.html`,
          platform: "darwin",
        }),
      ),
    ).toBe(false);
  });

  it("a symlink whose target was already resolved outside the tree is denied", () => {
    // The caller realpaths the request BEFORE this call, so a link pointing
    // out of the tree arrives here as its real target — and is denied.
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: "/etc/passwd",
          documentRealPath: `${FAKE_WS}/app/index.html`,
          workspace: FAKE_WS,
        }),
      ),
    ).toBe(false);
  });
});

describe("file-resource-roots — the broad roots are CANONICALIZED", () => {
  it("canonicalizes a symlinked temp root AND keeps the raw spelling", () => {
    // The policy compares REALPATH'd paths, so a root that is only known in
    // its raw spelling never matches — and the broad-root rules silently
    // stop applying. The canonical spelling is therefore added, and the
    // raw one is kept (a realpath'd request may carry either).
    const base = mkdtempSync(join(tmpdir(), "anycode-roots-"));
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const roots = buildFileResourceRoots(base, [link]);
    expect(roots.tmpdirs).toContain(link);
    expect(roots.tmpdirs).toContain(realpathSync(link));
    expect(roots.tmpdirs).toContain(realpathSync(real));
  });

  it("canonicalizes the home dir and the app profile dir", () => {
    const base = mkdtempSync(join(tmpdir(), "anycode-home-"));
    const home = join(base, "home");
    mkdirSync(join(home, ".anycode"), { recursive: true });
    const roots = buildFileResourceRoots(home, []);
    expect(roots.home).toBe(realpathSync(home));
    expect(roots.profileDir).toBe(realpathSync(join(home, ".anycode")));
  });

  it("the default roots contain the canonical spelling of the OS temp dir", () => {
    // On macOS the OS temp dir is `/var/folders/…` while its realpath is
    // `/private/var/folders/…` — the raw spelling alone would not match a
    // realpath'd request.
    const roots = defaultFileResourceRoots();
    expect(roots.tmpdirs).toContain(tmpdir());
    expect(roots.tmpdirs).toContain(realpathSync(tmpdir()));
  });

  it("a document directly in the canonical temp root reads its DIRECT children only", () => {
    // The end-to-end shape of the defect: the document's directory IS the
    // canonical temp root, so the request below it is denied.
    const canonicalTmp = realpathSync(tmpdir());
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${canonicalTmp}/nested/secret.json`,
          documentRealPath: `${canonicalTmp}/index.html`,
          tmpdirs: defaultFileResourceRoots().tmpdirs,
        }),
      ),
    ).toBe(false);
    expect(
      isAllowedFileSubresource(
        input({
          requestRealPath: `${canonicalTmp}/logo.png`,
          documentRealPath: `${canonicalTmp}/index.html`,
          tmpdirs: defaultFileResourceRoots().tmpdirs,
        }),
      ),
    ).toBe(true);
  });
});
