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
import { isAllowedFileSubresource } from "./file-resource-policy.js";

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
