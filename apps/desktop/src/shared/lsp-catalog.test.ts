/**
 * Catalog shape tests (Taskana 4743): every `LSP_CATALOG` entry must validate
 * against core's REAL `lspServerEntrySchema` after the `{name: id, command,
 * args, extensions}` mapping main performs on enable — this is the exact
 * object that would be written to `lspServers`, so a catalog typo must fail
 * HERE, in a unit test, not at the user's first click. Also pins: unique ids,
 * dot-prefixed lowercase extensions, non-empty install hints, and no id that
 * collides with a reserved prototype key (config-write refuses those names).
 */
import { describe, expect, it } from "vitest";
import { lspServerEntrySchema } from "@anycode/core/lsp-admin";
import { DANGEROUS_LSP_NAMES } from "./lsp-config.js";
import { LSP_CATALOG, findCatalogEntry } from "./lsp-catalog.js";

describe("LSP_CATALOG — every entry validates against core's lspServerEntrySchema", () => {
  it("the catalog is non-empty", () => {
    expect(LSP_CATALOG.length).toBeGreaterThan(0);
  });

  for (const entry of LSP_CATALOG) {
    it(`${entry.id}: {name: id, command, args, extensions} parses`, () => {
      const parsed = lspServerEntrySchema.safeParse({
        name: entry.id,
        command: entry.command,
        args: entry.args,
        extensions: entry.extensions,
      });
      expect(parsed.success).toBe(true);
    });
  }

  it("typescript / pyright / basedpyright / gopls / rust-analyzer / clangd / jdtls / ruby-lsp / intelephense / lua-language-server / bash-language-server / yaml-language-server / vscode-json-language-server are all present", () => {
    const ids = new Set(LSP_CATALOG.map((entry) => entry.id));
    for (const id of [
      "typescript",
      "pyright",
      "basedpyright",
      "gopls",
      "rust-analyzer",
      "clangd",
      "jdtls",
      "ruby-lsp",
      "intelephense",
      "lua-language-server",
      "bash-language-server",
      "yaml-language-server",
      "vscode-json-language-server",
    ]) {
      expect(ids.has(id), `catalog is missing ${id}`).toBe(true);
    }
  });
});

describe("LSP_CATALOG — structural invariants", () => {
  it("ids are unique (case-insensitive)", () => {
    const seen = new Set<string>();
    for (const entry of LSP_CATALOG) {
      const key = entry.id.toLowerCase();
      expect(seen.has(key), `duplicate catalog id ${entry.id}`).toBe(false);
      seen.add(key);
    }
  });

  it("every extension is lowercase and starts with a dot", () => {
    for (const entry of LSP_CATALOG) {
      expect(entry.extensions.length).toBeGreaterThan(0);
      for (const ext of entry.extensions) {
        expect(ext.startsWith("."), `${entry.id}: ${ext} lacks a leading dot`).toBe(true);
        expect(ext, `${entry.id}: ${ext} is not lowercase`).toBe(ext.toLowerCase());
      }
    }
  });

  it("command and installHint are non-empty; label and languages are non-empty", () => {
    for (const entry of LSP_CATALOG) {
      expect(entry.command.trim().length).toBeGreaterThan(0);
      expect(entry.installHint.trim().length).toBeGreaterThan(0);
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.languages.trim().length).toBeGreaterThan(0);
    }
  });

  it("commands are bare executable names, never paths (no / or \\)", () => {
    for (const entry of LSP_CATALOG) {
      expect(entry.command.includes("/"), `${entry.command} looks like a path`).toBe(false);
      expect(entry.command.includes("\\"), `${entry.command} looks like a path`).toBe(false);
    }
  });

  it("no id is a reserved prototype key (config-write would refuse it)", () => {
    for (const entry of LSP_CATALOG) {
      expect(DANGEROUS_LSP_NAMES.has(entry.id)).toBe(false);
    }
  });

  it("pyright and basedpyright both claim .py (the pane's overlap-hint case)", () => {
    const pyright = LSP_CATALOG.find((entry) => entry.id === "pyright");
    const based = LSP_CATALOG.find((entry) => entry.id === "basedpyright");
    expect(pyright?.extensions).toContain(".py");
    expect(based?.extensions).toContain(".py");
  });
});

describe("findCatalogEntry", () => {
  it("finds by exact id", () => {
    expect(findCatalogEntry("gopls")?.command).toBe("gopls");
  });

  it("matches case-insensitively (ids are the written config name)", () => {
    expect(findCatalogEntry("GOPLS")?.id).toBe("gopls");
  });

  it("returns undefined for an unknown id", () => {
    expect(findCatalogEntry("no-such-server")).toBeUndefined();
  });
});
