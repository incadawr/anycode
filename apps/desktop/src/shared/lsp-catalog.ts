/**
 * Language-server catalog (Taskana 4743): the fixed list of well-known LSP
 * servers the Settings → Language servers pane offers for one-click enable.
 * Each entry carries the exact `lspServers` shape core's
 * `lspServerEntrySchema` accepts (`{name, command, args, extensions}` — the
 * catalog id IS the written entry name), plus display fields: `label`,
 * `languages`, one copyable `installHint` string, and `nodeBin` (also look in
 * `<workspace>/node_modules/.bin` — npm-installed servers are often only
 * there, not on the GUI-launched app's PATH).
 *
 * VALUE-ONLY module with ZERO imports, exact ethic of shared/mcp-config.ts: it
 * is imported by preload (sandboxed CJS), the renderer web bundle, AND main,
 * so it must never drag zod or the @anycode/core barrel into a bundle that
 * cannot afford it. Shape validation against the real schema happens in TESTS
 * (lsp-catalog.test.ts imports core) and again at the main trust boundary
 * before any entry is written (main/lsp-config-ipc.ts re-parses with
 * `lspServerEntrySchema`).
 *
 * SECURITY POSTURE (Taskana 4743 brief §0): the app NEVER installs anything
 * and NEVER executes a found binary. `installHint` is a plain string the pane
 * renders as text and offers to copy — nothing anywhere spawns it. Detection
 * is existence-only (see main/lsp-detect.ts).
 */

/** One catalog entry: a well-known language server the pane can enable. */
export interface LspCatalogEntry {
  /** Written verbatim as the `lspServers[].name` on enable; unique across the catalog. */
  id: string;
  /** Display label (pane row title). */
  label: string;
  /** Display string naming the languages served, e.g. "TypeScript, JavaScript". */
  languages: string;
  /** Executable name exactly as `lspServers[].command` expects it (never a path). */
  command: string;
  /** Fixed args for the server's stdio mode; `[]` when the bare command speaks stdio. */
  args: readonly string[];
  /** Dot-prefixed lowercase extensions this server claims. */
  extensions: readonly string[];
  /** One primary copyable install command. Rendered as plain text; never executed. */
  installHint: string;
  /** True => detection also looks in `<workspace>/node_modules/.bin` (npm-local installs). */
  nodeBin?: boolean;
}

/**
 * The catalog (Taskana 4743 brief §2.1). Commands/args are each server's
 * documented stdio invocation. `pyright` AND `basedpyright` are both listed;
 * both claim `.py` — the pane surfaces the overlap ("both claim .py") rather
 * than hiding either.
 */
export const LSP_CATALOG: readonly LspCatalogEntry[] = [
  {
    id: "typescript",
    label: "TypeScript",
    languages: "TypeScript, JavaScript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    installHint: "npm i -g typescript typescript-language-server",
    nodeBin: true,
  },
  {
    id: "pyright",
    label: "Pyright",
    languages: "Python",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
    installHint: "npm i -g pyright",
    nodeBin: true,
  },
  {
    id: "basedpyright",
    label: "Based Pyright",
    languages: "Python",
    command: "basedpyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
    installHint: "pip install basedpyright",
  },
  {
    id: "gopls",
    label: "Go",
    languages: "Go",
    command: "gopls",
    args: [],
    extensions: [".go"],
    installHint: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "rust-analyzer",
    label: "Rust",
    languages: "Rust",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    installHint: "rustup component add rust-analyzer",
  },
  {
    id: "clangd",
    label: "C / C++",
    languages: "C, C++",
    command: "clangd",
    args: [],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
    installHint: "brew install llvm (or your distribution's clangd package)",
  },
  {
    id: "jdtls",
    label: "Java",
    languages: "Java",
    command: "jdtls",
    args: [],
    extensions: [".java"],
    installHint: "brew install jdtls",
  },
  {
    id: "ruby-lsp",
    label: "Ruby",
    languages: "Ruby",
    command: "ruby-lsp",
    args: [],
    extensions: [".rb", ".rake"],
    installHint: "gem install ruby-lsp",
  },
  {
    id: "intelephense",
    label: "PHP",
    languages: "PHP",
    command: "intelephense",
    args: ["--stdio"],
    extensions: [".php"],
    installHint: "npm i -g intelephense",
    nodeBin: true,
  },
  {
    id: "lua-language-server",
    label: "Lua",
    languages: "Lua",
    command: "lua-language-server",
    args: [],
    extensions: [".lua"],
    installHint: "brew install lua-language-server",
  },
  {
    id: "bash-language-server",
    label: "Shell",
    languages: "Bash, shell",
    command: "bash-language-server",
    args: ["start"],
    extensions: [".sh", ".bash"],
    installHint: "npm i -g bash-language-server",
    nodeBin: true,
  },
  {
    id: "yaml-language-server",
    label: "YAML",
    languages: "YAML",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensions: [".yaml", ".yml"],
    installHint: "npm i -g yaml-language-server",
    nodeBin: true,
  },
  {
    id: "vscode-json-language-server",
    label: "JSON",
    languages: "JSON",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensions: [".json", ".jsonc"],
    installHint: "npm i -g vscode-langservers-extracted",
    nodeBin: true,
  },
];

/** Case-insensitive catalog lookup by id (the written entry name). */
export function findCatalogEntry(id: string): LspCatalogEntry | undefined {
  const needle = id.toLowerCase();
  return LSP_CATALOG.find((entry) => entry.id.toLowerCase() === needle);
}
