import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error plain .mjs script without declarations
import { check, multisetExcess } from "./check-ui-baselines.mjs";

it("reports only entries beyond their count in the base (multiset subset)", () => {
  expect(multisetExcess(["a", "b"], ["a", "b", "c"])).toEqual([]);
  expect(multisetExcess(["a", "a"], ["a"])).toEqual(["a"]);
  expect(multisetExcess(["a", "z"], ["a"])).toEqual(["z"]);
});

it("fails when the head baseline gains an entry and ignores layout exceptions", () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-baselines-"));
  const run = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const renderer = join(dir, "apps/desktop/src/renderer/src");
  mkdirSync(renderer, { recursive: true });
  const put = (typography: string[], legacy: string[], exceptions: Record<string, string>): void => {
    writeFileSync(join(renderer, "typography-baseline.json"), JSON.stringify(typography));
    writeFileSync(join(renderer, "overlay-baseline.json"), JSON.stringify({ legacy, exceptions }));
  };
  run("init", "-q");
  run("config", "user.email", "t@example.test");
  run("config", "user.name", "t");
  put(["t1", "t2"], ["o1"], {});
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  const base = run("rev-parse", "HEAD");

  put(["t1"], ["o1"], { "new layout": "documented layout reason" });
  expect(check(dir, base).problems).toEqual([]);

  put(["t1", "t3"], ["o1", "o2"], {});
  expect(check(dir, base).problems.map((p: string) => p.replace(/^.*\/(?=[\w-]+\.json)/, ""))).toEqual([
    expect.stringContaining("typography-baseline.json: entry not in"),
    expect.stringContaining("overlay-baseline.json: entry not in"),
  ]);
});
