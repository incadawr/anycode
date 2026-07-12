/**
 * Frontmatter parser matrix (Phase 3 slice 3.3, design §3.2 / §5.2 item 1):
 * scalars, quotes, inline lists, comma lists, CRLF, BOM, missing/absent fences,
 * nesting/block-list rejection, unknown-key tolerance, and body stripping.
 */

import { describe, expect, it } from "vitest";
import { parseFrontmatter, splitList, type FrontmatterParsed } from "./frontmatter.js";

function ok(result: ReturnType<typeof parseFrontmatter>): FrontmatterParsed {
  if ("error" in result) {
    throw new Error(`expected a parsed frontmatter, got error: ${result.error}`);
  }
  return result;
}

describe("parseFrontmatter — happy paths", () => {
  it("parses flat scalar fields and strips the frontmatter from the body", () => {
    const parsed = ok(
      parseFrontmatter("---\nname: my-skill\ndescription: Does a thing\n---\nBody line 1\nBody line 2\n"),
    );
    expect(parsed.fields).toEqual({ name: "my-skill", description: "Does a thing" });
    expect(parsed.body).toBe("Body line 1\nBody line 2\n");
  });

  it("strips matching single and double quotes from scalar values", () => {
    const parsed = ok(
      parseFrontmatter(`---\nname: "quoted name"\ndescription: 'single quoted'\n---\nbody`),
    );
    expect(parsed.fields.name).toBe("quoted name");
    expect(parsed.fields.description).toBe("single quoted");
  });

  it("preserves an inner colon inside a scalar value", () => {
    const parsed = ok(parseFrontmatter('---\ndescription: "a: b: c"\n---\nbody'));
    expect(parsed.fields.description).toBe("a: b: c");
  });

  it("keeps an inline list value raw for splitList", () => {
    const parsed = ok(parseFrontmatter("---\ntools: [Read, Grep]\n---\nbody"));
    expect(parsed.fields.tools).toBe("[Read, Grep]");
    expect(splitList(parsed.fields.tools ?? "")).toEqual(["Read", "Grep"]);
  });

  it("keeps a comma-separated scalar value raw for splitList", () => {
    const parsed = ok(parseFrontmatter("---\ntools: Read, Grep, Glob\n---\nbody"));
    expect(splitList(parsed.fields.tools ?? "")).toEqual(["Read", "Grep", "Glob"]);
  });

  it("allows blank lines between fields", () => {
    const parsed = ok(parseFrontmatter("---\nname: s\n\ndescription: d\n---\nbody"));
    expect(parsed.fields).toEqual({ name: "s", description: "d" });
  });

  it("tolerates a leading UTF-8 BOM", () => {
    const parsed = ok(parseFrontmatter("﻿---\nname: bom\n---\nbody"));
    expect(parsed.fields.name).toBe("bom");
    expect(parsed.body).toBe("body");
  });

  it("tolerates CRLF line endings and returns the CRLF body verbatim", () => {
    const parsed = ok(parseFrontmatter("---\r\nname: crlf\r\ndescription: d\r\n---\r\nbody\r\nmore\r\n"));
    expect(parsed.fields).toEqual({ name: "crlf", description: "d" });
    expect(parsed.body).toBe("body\r\nmore\r\n");
  });

  it("returns an empty body when the closing fence is the last line without a trailing newline", () => {
    const parsed = ok(parseFrontmatter("---\nname: eof\n---"));
    expect(parsed.fields.name).toBe("eof");
    expect(parsed.body).toBe("");
  });

  it("accepts empty frontmatter", () => {
    const parsed = ok(parseFrontmatter("---\n---\nbody"));
    expect(parsed.fields).toEqual({});
    expect(parsed.body).toBe("body");
  });

  it("returns an empty-string value for a key with no value", () => {
    const parsed = ok(parseFrontmatter("---\nname:\n---\nbody"));
    expect(parsed.fields.name).toBe("");
  });

  it("returns unknown keys verbatim (the consumer ignores them, no error)", () => {
    const parsed = ok(
      parseFrontmatter("---\nname: s\ndescription: d\nmodel: opus\ncolor: blue\nallowed-tools: X\n---\nbody"),
    );
    expect(parsed.fields).toEqual({
      name: "s",
      description: "d",
      model: "opus",
      color: "blue",
      "allowed-tools": "X",
    });
  });
});

describe("parseFrontmatter — non-conforming inputs return { error }", () => {
  it("errors when there is no opening fence", () => {
    expect(parseFrontmatter("name: s\ndescription: d\n")).toHaveProperty("error");
  });

  it("errors when the file does not start with the fence (leading blank line)", () => {
    expect(parseFrontmatter("\n---\nname: s\n---\n")).toHaveProperty("error");
  });

  it("errors when the closing fence is missing", () => {
    expect(parseFrontmatter("---\nname: s\ndescription: d\n")).toHaveProperty("error");
  });

  it("errors on a nested mapping (indented line)", () => {
    expect(parseFrontmatter("---\nmeta:\n  nested: x\n---\nbody")).toHaveProperty("error");
  });

  it("errors on a block-list item", () => {
    expect(parseFrontmatter("---\ntools:\n  - Read\n  - Grep\n---\nbody")).toHaveProperty("error");
  });

  it("errors on a line with no colon", () => {
    expect(parseFrontmatter("---\njust some prose\n---\nbody")).toHaveProperty("error");
  });
});

describe("splitList", () => {
  it("parses an inline list with mixed quoting", () => {
    expect(splitList(`[ "a", 'b', c ]`)).toEqual(["a", "b", "c"]);
  });

  it("parses a comma-separated scalar", () => {
    expect(splitList("Read, Grep")).toEqual(["Read", "Grep"]);
  });

  it("drops empty entries and trims whitespace", () => {
    expect(splitList("Read, , Grep,")).toEqual(["Read", "Grep"]);
  });

  it("returns an empty list for an empty value or empty inline list", () => {
    expect(splitList("")).toEqual([]);
    expect(splitList("[]")).toEqual([]);
    expect(splitList("  ")).toEqual([]);
  });

  it("handles a single scalar", () => {
    expect(splitList("Read")).toEqual(["Read"]);
  });
});
