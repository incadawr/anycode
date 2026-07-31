/**
 * Unit tests for the markdown -> sanitized HTML render pipeline (night-track
 * wave-1 cut §1(g)/§3 "96-F"). Every test writes a real temp source file and
 * calls `renderMarkdownFile` for real — `marked` and `sanitize-html` are NOT
 * mocked, since the whole point of this slice is what the REAL libraries do
 * with hostile input, not what a fake claims they do.
 */

import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SOURCE_BYTES,
  PREVIEW_CSP,
  PREVIEW_DIR_NAME,
  SANITIZE_OPTIONS,
  renderMarkdownFile,
} from "./markdown-render.js";

let sourceDir: string;

beforeEach(async () => {
  sourceDir = await mkdtemp(join(tmpdir(), "markdown-render-test-src-"));
});

async function writeSource(name: string, content: string): Promise<string> {
  const path = join(sourceDir, name);
  await writeFile(path, content, "utf8");
  return path;
}

async function renderOk(path: string): Promise<{ htmlPath: string; html: string }> {
  const result = await renderMarkdownFile(path);
  if ("error" in result) {
    throw new Error(`expected ok render, got error: ${result.error}`);
  }
  const html = await readFile(result.htmlPath, "utf8");
  return { htmlPath: result.htmlPath, html };
}

describe("renderMarkdownFile — sanitize allowlist (cut §1(g)/§3 96-F)", () => {
  it("strips <script> tags and their content entirely", async () => {
    const path = await writeSource("script.md", "hi\n\n<script>alert(document.cookie)</script>\n\nbye");
    const { html } = await renderOk(path);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(document.cookie)");
  });

  it("strips <iframe> tags", async () => {
    const path = await writeSource("iframe.md", '<iframe src="https://evil.example"></iframe>');
    const { html } = await renderOk(path);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("evil.example");
  });

  it("strips event-handler attributes (onerror/onclick/...)", async () => {
    const path = await writeSource(
      "handlers.md",
      '<img src="https://example.com/x.png" onerror="alert(1)">\n\n<div onclick="alert(2)">hi</div>',
    );
    const { html } = await renderOk(path);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(");
  });

  it("strips style attributes and <style> blocks", async () => {
    const path = await writeSource(
      "style.md",
      '<style>body{background:url(javascript:alert(1))}</style>\n\n<p style="color:red">hi</p>',
    );
    const { html } = await renderOk(path);
    // The shell's OWN <style> block (light/dark CSS) is expected to survive —
    // this asserts the SOURCE's hostile <style> content and inline `style=`
    // attribute are gone, not that no <style> tag exists anywhere in the page.
    expect(html).not.toMatch(/style\s*=\s*"/);
    expect(html).not.toContain("background:url(javascript");
    expect(html).not.toContain("javascript:alert");
  });

  it("strips javascript: hrefs, degrading the link to plain text", async () => {
    const path = await writeSource("javascript-href.md", "[click me](javascript:alert(1))");
    const { html } = await renderOk(path);
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("click me");
  });

  it("keeps https and mailto hrefs", async () => {
    const path = await writeSource(
      "links.md",
      "[site](https://example.com)\n\n[mail](mailto:person@example.com)",
    );
    const { html } = await renderOk(path);
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:person@example.com"');
  });

  it("includes the frozen CSP meta tag literally", async () => {
    const path = await writeSource("csp.md", "just some text");
    const { html } = await renderOk(path);
    expect(html).toContain(`content="${PREVIEW_CSP}"`);
    expect(PREVIEW_CSP).toBe(
      "default-src 'none'; img-src file: data: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(html).not.toContain("script-src");
  });

  it("keeps file: and data: image sources, drops http: images entirely", async () => {
    const path = await writeSource(
      "images.md",
      [
        "![a](http://evil.example/x.png)",
        "![b](file:///tmp/local.png)",
        "![c](data:image/png;base64,AAAA)",
        "![d](https://example.com/x.png)",
      ].join("\n\n"),
    );
    const { html } = await renderOk(path);
    expect(html).not.toContain("evil.example");
    expect(html).not.toMatch(/src="http:/);
    expect(html).toContain('src="file:///tmp/local.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('src="https://example.com/x.png"');
  });

  it("keeps a GFM task-list checkbox with its disabled attribute", async () => {
    const path = await writeSource("tasks.md", "- [ ] todo\n- [x] done");
    const { html } = await renderOk(path);
    const inputTags = html.match(/<input\b[^>]*>/g) ?? [];
    // exactly two survive: one unchecked, one checked.
    expect(inputTags).toHaveLength(2);
    for (const tag of inputTags) {
      expect(tag).toContain('type="checkbox"');
      expect(tag).toContain("disabled");
    }
    expect(inputTags.some((tag) => tag.includes("checked"))).toBe(true);
  });

  it("discards a non-checkbox <input> smuggled in as raw HTML", async () => {
    const path = await writeSource("raw-input.md", '<input type="text" value="hax">');
    const { html } = await renderOk(path);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("hax");
  });

  it("discards an enabled checkbox (no disabled attribute)", async () => {
    const path = await writeSource("enabled-checkbox.md", '<input type="checkbox">');
    const { html } = await renderOk(path);
    expect(html).not.toContain("<input");
  });

  it("drops a protocol-relative <img src> entirely (cut §1.7, F6 — no UNC/NTLM egress on win32)", async () => {
    const path = await writeSource("protocol-relative-img.md", "![x](//evil.tld/x.png)");
    const { html } = await renderOk(path);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.tld");
  });

  it("degrades a protocol-relative <a href> to plain text (cut §1.7, F6)", async () => {
    const path = await writeSource("protocol-relative-href.md", "[click me](//evil.tld/x)");
    const { html } = await renderOk(path);
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("evil.tld");
    expect(html).toContain("click me");
  });

  it("SANITIZE_OPTIONS carries the frozen allowProtocolRelative:false literal (cut §1.7, F6)", () => {
    expect(SANITIZE_OPTIONS.allowProtocolRelative).toBe(false);
  });
});

describe("renderMarkdownFile — size cap (cut §1(g)/§3 96-F)", () => {
  it("refuses an oversize source with an honest error, without writing anything", async () => {
    const path = await writeSource("big.md", "x".repeat(MAX_SOURCE_BYTES + 1));
    const result = await renderMarkdownFile(path);
    expect(result).toEqual({ error: expect.stringContaining(String(MAX_SOURCE_BYTES)) });
  });

  it("accepts a source right at the cap", async () => {
    const path = await writeSource("at-cap.md", "x".repeat(MAX_SOURCE_BYTES));
    const result = await renderMarkdownFile(path);
    expect("htmlPath" in result).toBe(true);
  });

  it("returns an honest error for a missing source file", async () => {
    const result = await renderMarkdownFile(join(sourceDir, "does-not-exist.md"));
    expect("error" in result).toBe(true);
  });
});

describe("renderMarkdownFile — temp-file placement, perms, determinism (cut §1(g)/§3 96-F)", () => {
  it("writes under os.tmpdir()/anycode-preview with file mode 0600 and dir mode 0700", async () => {
    const path = await writeSource("perms.md", "hello");
    const result = await renderMarkdownFile(path);
    if ("error" in result) throw new Error(result.error);

    expect(result.htmlPath.startsWith(join(tmpdir(), PREVIEW_DIR_NAME))).toBe(true);

    const dirStat = await stat(join(tmpdir(), PREVIEW_DIR_NAME));
    expect(dirStat.mode & 0o777).toBe(0o700);

    const fileStat = await stat(result.htmlPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("re-opening the SAME source at the SAME mtime is idempotent (same path)", async () => {
    const path = await writeSource("idempotent.md", "hello");
    const first = await renderMarkdownFile(path);
    const second = await renderMarkdownFile(path);
    if ("error" in first || "error" in second) throw new Error("expected both renders to succeed");
    expect(second.htmlPath).toBe(first.htmlPath);
  });

  it("re-rendering after the source's mtime changes produces a NEW path (edit -> re-render)", async () => {
    const path = await writeSource("edited.md", "hello");
    const first = await renderMarkdownFile(path);
    if ("error" in first) throw new Error(first.error);

    // Force a distinct mtime — some filesystems have coarse mtime resolution,
    // so this sets it explicitly rather than relying on real-time elapsing.
    const originalStat = await stat(path);
    await writeFile(path, "hello, edited");
    const bumpedDate = new Date(originalStat.mtimeMs + 5000);
    await utimes(path, bumpedDate, bumpedDate);

    const second = await renderMarkdownFile(path);
    if ("error" in second) throw new Error(second.error);
    expect(second.htmlPath).not.toBe(first.htmlPath);
  });
});
