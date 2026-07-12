/**
 * Shiki syntax highlighting for the diff view (design
 * /working-docs/build/design/phase-mvp.md §5): a single lazy highlighter
 * singleton built on the JS regex engine (`shiki/engine/javascript` — no
 * WASM, so no renderer CSP fuss), with the github-dark/github-light themes
 * loaded up front and languages loaded lazily, per file extension, the first
 * time each is actually needed. Before/after content is each tokenized whole,


 * rows instead of re-highlighting per hunk). Unknown extensions or a grammar
 * that fails to load fall back to plaintext (one unstyled token per line)
 * rather than throwing — a highlighting problem must never break the diff.
 *
 * Every language loader below is a literal `import("shiki/langs/xxx.mjs")`
 * call (never a template-string path built from a variable) specifically so
 * bundlers that only support static analysis of dynamic imports (Vite/
 * electron-vite, per design §6/§7) can see and code-split each one.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CSSProperties } from "react";

export type DiffTheme = "github-dark" | "github-light";

export interface HighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}

export type HighlightedLine = HighlightToken[];

export interface HighlightResult {
  lines: HighlightedLine[];
  /** False when no grammar was available/loadable for this file (unknown extension, or the grammar failed to load) — `lines` is then one plain token per line, unstyled. */
  highlighted: boolean;
}

/**
 * File extension (lowercased, no dot) -> Shiki bundled language id. Narrow
 * and explicit on purpose: every id here has a matching entry in
 * LANG_LOADERS below, so an extension is either fully supported or falls
 * back to plaintext — no guessing at grammar ids that might not exist.
 */
const EXTENSION_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "bash",
  zsh: "shellscript",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  dockerfile: "dockerfile",
  ini: "ini",
  diff: "diff",
  patch: "diff",
};

/** Shiki language id -> lazy loader. Keys must exactly match EXTENSION_TO_LANG's values. */
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

/**
 * Fence info-string name (lowercased) -> Shiki language id. Sibling of
 * EXTENSION_TO_LANG (which is path/extension-keyed); this one is keyed by the
 * NAMES authors write after a fence (``` ```ts ```, ``` ```bash ```, …). Names
 * absent from this map (or explicit-plaintext names like `text`/`console`)
 * resolve to `null` in langIdForFenceInfo, which additionally guards every
 * result against LANG_LOADERS so the alias map can never drift ahead of the
 * loaders.
 */
const FENCE_NAME_TO_LANG: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  go: "go",
  golang: "go",
  rs: "rust",
  rust: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  php: "php",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  shellscript: "shellscript",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  ini: "ini",
  diff: "diff",
  patch: "diff",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

/** Lazy highlighter singleton (design §5): built once, on first use, and reused for every DiffView instance for the app's lifetime. */
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import("shiki/themes/github-dark.mjs"), import("shiki/themes/github-light.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/** Loads `lang` into the highlighter the first time it's needed; a load failure is swallowed (returns false) so callers fall back to plaintext instead of throwing. */
async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) {
    return true;
  }
  const loader = LANG_LOADERS[lang];
  if (!loader) {
    return false;
  }
  try {
    await highlighter.loadLanguage(loader() as Parameters<HighlighterCore["loadLanguage"]>[0]);
    loadedLangs.add(lang);
    return true;
  } catch {
    return false;
  }
}

function langIdForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  const ext = path.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANG[ext] ?? null;
}

/** jsdiff-convention line split (see diff/compute.ts's docstring): a trailing "\n" terminates the last line rather than starting a phantom empty one, matching DiffHunk's oldLine/newLine numbering. */
function dropTrailingPhantomLine<T>(lines: T[], content: string): T[] {
  return content.endsWith("\n") ? lines.slice(0, -1) : lines;
}

function plainLines(content: string): HighlightedLine[] {
  const raw = content === "" ? [] : content.split("\n").map((line): HighlightedLine => [{ content: line }]);
  return dropTrailingPhantomLine(raw, content);
}

/**
 * Resolves a fenced code block's info string to a Shiki language id, or `null`
 * for plaintext. Takes the FIRST whitespace-separated word (marked's `code`
 * token `lang` carries the whole info string, e.g. "ts title=x"), lowercases
 * it, maps it through FENCE_NAME_TO_LANG, then guards the result against
 * LANG_LOADERS — an id is returned only when a loader actually exists, so the
 * alias map can never claim a language the highlighter cannot load. Unknown or
 * explicit-plaintext names ("", text, plaintext, txt, plain, console, output,
 * or any name absent from the map) return `null`.
 */
export function langIdForFenceInfo(info: string | undefined | null): string | null {
  if (!info) {
    return null;
  }
  const first = (info.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (first === "") {
    return null;
  }
  const id = FENCE_NAME_TO_LANG[first];
  if (!id) {
    return null;
  }
  return LANG_LOADERS[id] ? id : null;
}

/**
 * Tokenizes `content` for an already-resolved Shiki language id. A `null`
 * langId, empty content, or a grammar that fails to load all fall back to
 * plaintext (`highlighted: false`, one unstyled token per line) — and the
 * `null`/empty paths never initialize the highlighter, keeping them sync-cheap
 * and hermetic under node vitest. Never throws.
 */
export async function highlightCode(
  content: string,
  langId: string | null,
  theme: DiffTheme = "github-dark",
): Promise<HighlightResult> {
  if (content === "") {
    return { lines: [], highlighted: false };
  }
  if (!langId) {
    return { lines: plainLines(content), highlighted: false };
  }

  const highlighter = await getHighlighter();
  const loaded = await ensureLanguage(highlighter, langId);
  if (!loaded) {
    return { lines: plainLines(content), highlighted: false };
  }

  const { tokens } = highlighter.codeToTokens(content, { lang: langId, theme });
  const lines: HighlightedLine[] = dropTrailingPhantomLine(tokens, content).map((lineTokens) =>
    lineTokens.map((token): HighlightToken => ({
      content: token.content,
      color: token.color,
      fontStyle: token.fontStyle,
    })),
  );
  return { lines, highlighted: true };
}

/**
 * Tokenizes `content` (one side of a Write/Edit diff) for `filePath`'s
 * language. Falls back to plaintext (unstyled, one token per line) when the
 * extension is unknown or the grammar fails to load — never throws. Thin
 * wrapper over highlightCode: public behavior is byte-identical to the
 * previous implementation.
 */
export async function highlightSource(
  content: string,
  filePath: string,
  theme: DiffTheme = "github-dark",
): Promise<HighlightResult> {
  return highlightCode(content, langIdForPath(filePath), theme);
}

/**
 * vscode-textmate fontStyle bit flags (Shiki tokens carry them as-is): 1=italic,
 * 2=bold, 4=underline. Mirrors the private copy in DiffView.tsx (which is not
 * edited this slice); consolidation is deferred to R13.
 */
export function fontStyleToCss(fontStyle: number | undefined): CSSProperties {
  if (!fontStyle) {
    return {};
  }
  const style: CSSProperties = {};
  if (fontStyle & 1) {
    style.fontStyle = "italic";
  }
  if (fontStyle & 2) {
    style.fontWeight = "bold";
  }
  if (fontStyle & 4) {
    style.textDecoration = "underline";
  }
  return style;
}
