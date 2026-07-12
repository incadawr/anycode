/** Contract smoke tests: tool input schemas parse/reject as specified. */

import { describe, expect, it } from "vitest";
import {
  bashInputSchema,
  editInputSchema,
  globInputSchema,
  grepInputSchema,
  readInputSchema,
  todoReadInputSchema,
  todoWriteInputSchema,
  webFetchInputSchema,
  writeInputSchema,
} from "./schemas.js";

describe("tool input schemas", () => {
  it("Read accepts a minimal input and rejects an empty path", () => {
    expect(readInputSchema.safeParse({ file_path: "/tmp/a.txt" }).success).toBe(true);
    expect(readInputSchema.safeParse({ file_path: "" }).success).toBe(false);
  });

  it("Write requires both file_path and content", () => {
    expect(writeInputSchema.safeParse({ file_path: "/tmp/a.txt", content: "x" }).success).toBe(true);
    expect(writeInputSchema.safeParse({ file_path: "/tmp/a.txt" }).success).toBe(false);
  });

  it("Edit defaults replace_all to false", () => {
    const parsed = editInputSchema.parse({
      file_path: "/tmp/a.txt",
      old_string: "a",
      new_string: "b",
    });
    expect(parsed.replace_all).toBe(false);
  });

  it("Bash caps the timeout override at 600000ms", () => {
    expect(bashInputSchema.safeParse({ command: "ls", timeout: 600_000 }).success).toBe(true);
    expect(bashInputSchema.safeParse({ command: "ls", timeout: 600_001 }).success).toBe(false);
  });

  it("Grep applies defaults and validates output_mode", () => {
    const parsed = grepInputSchema.parse({ pattern: "foo" });
    expect(parsed.output_mode).toBe("files_with_matches");
    expect(parsed.head_limit).toBe(250);
    expect(grepInputSchema.safeParse({ pattern: "foo", output_mode: "bogus" }).success).toBe(false);
  });

  it("Glob requires a non-empty pattern; path is optional", () => {
    expect(globInputSchema.safeParse({ pattern: "src/**/*.ts" }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "*.md", path: "/tmp" }).success).toBe(true);
    expect(globInputSchema.safeParse({ pattern: "" }).success).toBe(false);
    expect(globInputSchema.safeParse({}).success).toBe(false);
  });

  it("TodoRead is a strict empty object", () => {
    expect(todoReadInputSchema.safeParse({}).success).toBe(true);
    expect(todoReadInputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("TodoWrite validates items: non-empty content, enum status, optional id", () => {
    expect(
      todoWriteInputSchema.safeParse({
        todos: [
          { content: "do a thing", status: "pending" },
          { id: "t1", content: "done thing", status: "completed" },
        ],
      }).success,
    ).toBe(true);
    expect(todoWriteInputSchema.safeParse({ todos: [] }).success).toBe(true);
    expect(
      todoWriteInputSchema.safeParse({ todos: [{ content: "", status: "pending" }] }).success,
    ).toBe(false);
    expect(
      todoWriteInputSchema.safeParse({ todos: [{ content: "x", status: "bogus" }] }).success,
    ).toBe(false);
    expect(todoWriteInputSchema.safeParse({}).success).toBe(false);
  });

  it("WebFetch requires a valid URL and a non-empty prompt", () => {
    expect(
      webFetchInputSchema.safeParse({ url: "https://example.com/x", prompt: "what is this?" })
        .success,
    ).toBe(true);
    expect(webFetchInputSchema.safeParse({ url: "not a url", prompt: "q" }).success).toBe(false);
    expect(
      webFetchInputSchema.safeParse({ url: "https://example.com", prompt: "" }).success,
    ).toBe(false);
    expect(webFetchInputSchema.safeParse({ url: "https://example.com" }).success).toBe(false);
  });
});
