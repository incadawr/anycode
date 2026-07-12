/**
 * CLI argument parsing tests (design slice-4.1-cut.md §5.2 item 5): all new
 * flags in both forms, `-p`, the existing --mode/--yolo/--resume flags parsing
 * byte-identically, unknown-flag -> warn (not exit), and the --help synopsis
 * content (only real flags/env vars/slash commands).
 */

import { describe, expect, it } from "vitest";
import {
  collectUnknownFlags,
  formatUnknownFlagWarning,
  formatUsage,
  isPermissionMode,
  parseCliArgs,
} from "./args.js";
import { COMMAND_HELP } from "./commands.js";
import {
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_CONTEXT_WINDOW,
  ENV_DB_PATH,
  ENV_MAX_RETRIES,
  ENV_MAX_TURNS,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_REASONING_EFFORT,
  ENV_MODEL,
  ENV_STALL_TIMEOUT_MS,
  ENV_TOOL_CONCURRENCY,
} from "../provider/env.js";

describe("isPermissionMode", () => {
  it("accepts every PERMISSION_MODES value and rejects anything else", () => {
    for (const mode of ["plan", "build", "edit", "auto", "yolo"]) {
      expect(isPermissionMode(mode)).toBe(true);
    }
    expect(isPermissionMode("bogus")).toBe(false);
    expect(isPermissionMode("")).toBe(false);
  });
});

describe("parseCliArgs — defaults", () => {
  it("empty argv yields the documented defaults", () => {
    expect(parseCliArgs([])).toEqual({
      mode: "build",
      yolo: false,
      resumeSessionId: undefined,
      help: false,
      version: false,
      noColor: false,
      noReasoning: false,
      printPrompt: undefined,
      resumePicker: false,
      continueSession: false,
      print: false,
      outputFormat: undefined,
      model: undefined,
      modeExplicit: false,
      noCheckpoints: false,
      images: [],
    });
  });
});

describe("parseCliArgs — existing flags parse byte-identically (--mode/--yolo/--resume)", () => {
  it("--mode <value> and --mode=<value>", () => {
    expect(parseCliArgs(["--mode", "plan"]).mode).toBe("plan");
    expect(parseCliArgs(["--mode=edit"]).mode).toBe("edit");
    // An invalid mode value leaves the default untouched (existing behaviour).
    expect(parseCliArgs(["--mode", "nonsense"]).mode).toBe("build");
    expect(parseCliArgs(["--mode=nonsense"]).mode).toBe("build");
  });

  it("--yolo sets the flag", () => {
    expect(parseCliArgs(["--yolo"]).yolo).toBe(true);
    expect(parseCliArgs([]).yolo).toBe(false);
  });

  it("--resume <id> and --resume=<id>", () => {
    expect(parseCliArgs(["--resume", "sess-1"]).resumeSessionId).toBe("sess-1");
    expect(parseCliArgs(["--resume=sess-2"]).resumeSessionId).toBe("sess-2");
  });

  it("--resume= (degenerate empty id) resolves resumeSessionId to the empty string", () => {
    const args = parseCliArgs(["--resume="]);
    expect(args.resumeSessionId).toBe("");
    expect(args.resumePicker).toBe(false);
  });

  it("combines with the new flags without disturbing each other", () => {
    const args = parseCliArgs(["--mode", "edit", "--yolo", "--resume=sess-9", "--no-color"]);
    expect(args.mode).toBe("edit");
    expect(args.yolo).toBe(true);
    expect(args.resumeSessionId).toBe("sess-9");
    expect(args.noColor).toBe(true);
  });
});

describe("parseCliArgs — slice-4.1 additions", () => {
  it("--print <prompt> and --print=<prompt>", () => {
    expect(parseCliArgs(["--print", "hello world"]).printPrompt).toBe("hello world");
    expect(parseCliArgs(["--print=hello=world"]).printPrompt).toBe("hello=world");
  });

  it("-p <prompt> and -p=<prompt> (short form)", () => {
    expect(parseCliArgs(["-p", "2+2?"]).printPrompt).toBe("2+2?");
    expect(parseCliArgs(["-p=2+2?"]).printPrompt).toBe("2+2?");
  });

  it("--help and -h", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs([]).help).toBe(false);
  });

  it("--version", () => {
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs([]).version).toBe(false);
  });

  it("--no-color", () => {
    expect(parseCliArgs(["--no-color"]).noColor).toBe(true);
    expect(parseCliArgs([]).noColor).toBe(false);
  });
});

describe("parseCliArgs — slice-4.2 additions", () => {
  it("--no-reasoning sets the flag; default is false (reasoning shown in interactive)", () => {
    expect(parseCliArgs(["--no-reasoning"]).noReasoning).toBe(true);
    expect(parseCliArgs([]).noReasoning).toBe(false);
  });
});

describe("parseCliArgs — slice-4.4 additions (design slice-4.4-cut.md §2.1)", () => {
  it("--continue and -c both set continueSession; default is false", () => {
    expect(parseCliArgs(["--continue"]).continueSession).toBe(true);
    expect(parseCliArgs(["-c"]).continueSession).toBe(true);
    expect(parseCliArgs([]).continueSession).toBe(false);
  });

  it("a trailing bare --resume (no following token) sets resumePicker and leaves resumeSessionId undefined", () => {
    const args = parseCliArgs(["--resume"]);
    expect(args.resumePicker).toBe(true);
    expect(args.resumeSessionId).toBeUndefined();
  });

  it("a trailing bare --resume after other flags is still recognised (not pushed to unknownFlags)", () => {
    const args = parseCliArgs(["--yolo", "--resume"]);
    expect(args.yolo).toBe(true);
    expect(args.resumePicker).toBe(true);
    expect(collectUnknownFlags(["--yolo", "--resume"])).toEqual([]);
  });

  it("--resume <token> (a following token present) never sets resumePicker — A7 stays frozen", () => {
    expect(parseCliArgs(["--resume", "-abc"]).resumePicker).toBe(false);
    expect(parseCliArgs(["--resume", "-abc"]).resumeSessionId).toBe("-abc");
    expect(parseCliArgs(["--resume", "sess-1"]).resumePicker).toBe(false);
  });

  it("--resume=<id> never sets resumePicker", () => {
    expect(parseCliArgs(["--resume=sess-2"]).resumePicker).toBe(false);
    expect(parseCliArgs(["--resume="]).resumePicker).toBe(false);
  });

  it("combines with the other flags without disturbing each other", () => {
    const args = parseCliArgs(["--mode", "edit", "--continue", "--no-color"]);
    expect(args.mode).toBe("edit");
    expect(args.continueSession).toBe(true);
    expect(args.noColor).toBe(true);
  });
});

describe("parseCliArgs — slice-4.5 additions (design slice-4.5-cut.md §2.1)", () => {
  it("all 4 --print/-p forms set print:true", () => {
    expect(parseCliArgs(["--print", "hi"]).print).toBe(true);
    expect(parseCliArgs(["--print=hi"]).print).toBe(true);
    expect(parseCliArgs(["-p", "hi"]).print).toBe(true);
    expect(parseCliArgs(["-p=hi"]).print).toBe(true);
  });

  it("trailing bare --print/-p sets print:true and leaves printPrompt undefined (stdin mode)", () => {
    expect(parseCliArgs(["--print"])).toMatchObject({ print: true, printPrompt: undefined });
    expect(parseCliArgs(["-p"])).toMatchObject({ print: true, printPrompt: undefined });
  });

  it("-p X sets print:true and printPrompt to the consumed value", () => {
    expect(parseCliArgs(["-p", "X"])).toMatchObject({ print: true, printPrompt: "X" });
  });

  it("without any --print/-p form, print stays false", () => {
    expect(parseCliArgs([]).print).toBe(false);
    expect(parseCliArgs(["--yolo"]).print).toBe(false);
  });

  it("--output-format <fmt> and --output-format=<fmt>", () => {
    expect(parseCliArgs(["--output-format", "json"]).outputFormat).toBe("json");
    expect(parseCliArgs(["--output-format=json"]).outputFormat).toBe("json");
  });

  it("--output-format two-token form consumes the following token", () => {
    const args = parseCliArgs(["--output-format", "stream-json", "-p", "hi"]);
    expect(args.outputFormat).toBe("stream-json");
    expect(args.printPrompt).toBe("hi");
  });

  it("trailing bare --output-format (no following token) resolves to the empty string, not undefined", () => {
    const args = parseCliArgs(["--output-format"]);
    expect(args.outputFormat).toBe("");
  });

  it("without --output-format at all, outputFormat stays undefined", () => {
    expect(parseCliArgs([]).outputFormat).toBeUndefined();
  });

  it("the --output-format value is never counted as unknown, even if it looks like a flag (mirrors A8)", () => {
    expect(collectUnknownFlags(["--output-format", "-abc"])).toEqual([]);
    expect(parseCliArgs(["--output-format", "-abc"]).outputFormat).toBe("-abc");
  });
});

describe("parseCliArgs — slice-4.6 additions (design slice-4.6-cut.md §2.2)", () => {
  it("--model <id> and --model=<id>", () => {
    expect(parseCliArgs(["--model", "glm-4.5"]).model).toBe("glm-4.5");
    expect(parseCliArgs(["--model=glm-4.5"]).model).toBe("glm-4.5");
  });

  it("trailing bare --model (no following token) resolves to the empty string, not undefined", () => {
    const args = parseCliArgs(["--model"]);
    expect(args.model).toBe("");
  });

  it("without --model at all, model stays undefined", () => {
    expect(parseCliArgs([]).model).toBeUndefined();
  });

  it("the --model value is never counted as unknown, even if it looks like a flag (mirrors A8/A22)", () => {
    expect(collectUnknownFlags(["--model", "-abc"])).toEqual([]);
    expect(parseCliArgs(["--model", "-abc"]).model).toBe("-abc");
  });

  it("--model two-token form consumes the following token without disturbing other flags", () => {
    const args = parseCliArgs(["--model", "glm-4.5", "-p", "hi"]);
    expect(args.model).toBe("glm-4.5");
    expect(args.printPrompt).toBe("hi");
  });

  it("--mode <value> with a valid value sets modeExplicit true", () => {
    expect(parseCliArgs(["--mode", "plan"]).modeExplicit).toBe(true);
    expect(parseCliArgs(["--mode=plan"]).modeExplicit).toBe(true);
  });

  it("--mode with an invalid value leaves mode at the default and modeExplicit false (byte-frozen, L4)", () => {
    const twoToken = parseCliArgs(["--mode", "bogus"]);
    expect(twoToken.mode).toBe("build");
    expect(twoToken.modeExplicit).toBe(false);

    const equalsForm = parseCliArgs(["--mode=bogus"]);
    expect(equalsForm.mode).toBe("build");
    expect(equalsForm.modeExplicit).toBe(false);
  });

  it("without --mode at all, modeExplicit stays false", () => {
    expect(parseCliArgs([]).modeExplicit).toBe(false);
  });
});

describe("parseCliArgs — slice-4.7 additions (design slice-4.7-cut.md §2.5)", () => {
  it("--no-checkpoints sets the flag; default is false (checkpoints enabled)", () => {
    expect(parseCliArgs(["--no-checkpoints"]).noCheckpoints).toBe(true);
    expect(parseCliArgs([]).noCheckpoints).toBe(false);
  });

  it("combines with the other flags without disturbing each other", () => {
    const args = parseCliArgs(["--mode", "edit", "--no-checkpoints", "--no-color"]);
    expect(args.mode).toBe("edit");
    expect(args.noCheckpoints).toBe(true);
    expect(args.noColor).toBe(true);
  });
});

describe("parseCliArgs — slice-6.2 addition (--image, design slice-6.2-cut.md §2-D1)", () => {
  it("defaults to an empty array", () => {
    expect(parseCliArgs([]).images).toEqual([]);
  });

  it("--image <path> is repeatable, collected in encounter order", () => {
    expect(parseCliArgs(["--image", "a.png", "--image", "b.jpg"]).images).toEqual(["a.png", "b.jpg"]);
  });

  it("--image=<path> form works and combines with the two-token form", () => {
    expect(parseCliArgs(["--image=a.png"]).images).toEqual(["a.png"]);
    expect(parseCliArgs(["--image", "a.png", "--image=b.jpg"]).images).toEqual(["a.png", "b.jpg"]);
  });

  it("a trailing bare --image (no following token) pushes nothing", () => {
    expect(parseCliArgs(["--yolo", "--image"]).images).toEqual([]);
  });

  it("does not disturb other flags parsed alongside it", () => {
    const args = parseCliArgs(["--mode", "edit", "--image", "shot.png", "--yolo"]);
    expect(args.mode).toBe("edit");
    expect(args.yolo).toBe(true);
    expect(args.images).toEqual(["shot.png"]);
  });
});

describe("parseCliArgs — unknown flags never throw or change the exit shape (design §3.3 R5)", () => {
  it("an unrecognised --flag is simply absent from the result — parse still succeeds", () => {
    expect(() => parseCliArgs(["--bogus-flag"])).not.toThrow();
    expect(parseCliArgs(["--bogus-flag", "value"])).toEqual({
      mode: "build",
      yolo: false,
      resumeSessionId: undefined,
      help: false,
      version: false,
      noColor: false,
      noReasoning: false,
      printPrompt: undefined,
      resumePicker: false,
      continueSession: false,
      print: false,
      outputFormat: undefined,
      model: undefined,
      modeExplicit: false,
      noCheckpoints: false,
      images: [],
    });
  });

  it("a recognised flag alongside an unknown one still parses correctly", () => {
    const args = parseCliArgs(["--yolo", "--bogus", "--mode", "edit"]);
    expect(args.yolo).toBe(true);
    expect(args.mode).toBe("edit");
  });
});

describe("collectUnknownFlags / formatUnknownFlagWarning (design §3.3 R5)", () => {
  it("is empty for argv made entirely of recognised flags/values", () => {
    expect(collectUnknownFlags(["--mode", "build", "--yolo", "--resume=sess-1", "-p", "hi", "--no-color"])).toEqual(
      [],
    );
  });

  it("collects unrecognised flag-shaped tokens in encounter order", () => {
    expect(collectUnknownFlags(["--foo", "--yolo", "--bar"])).toEqual(["--foo", "--bar"]);
  });

  it("never counts a two-token flag's VALUE as unknown, even if it looks like a flag", () => {
    expect(collectUnknownFlags(["--resume", "-abc"])).toEqual([]);
    expect(parseCliArgs(["--resume", "-abc"]).resumeSessionId).toBe("-abc");
  });

  it("formatUnknownFlagWarning matches the ratified diagnostic text exactly", () => {
    expect(formatUnknownFlagWarning("--bogus")).toBe("[warn] unknown flag: --bogus (see --help)\n");
  });
});

describe("formatUsage (design §3.3): only real flags, ANYCODE_* env, and the COMMAND_HELP slash-command list", () => {
  const usage = formatUsage();

  it("lists every currently-real flag", () => {
    for (const flag of [
      "--mode",
      "--model",
      "--yolo",
      "--resume",
      "--continue",
      "-c",
      "--print",
      "-p",
      "--output-format",
      "--no-color",
      "--no-reasoning",
      "--no-checkpoints",
      "--image",
      "--help",
      "-h",
      "--version",
    ]) {
      expect(usage).toContain(flag);
    }
  });

  // --model became real in slice-4.6 (design slice-4.6-cut.md §2.2) — this
  // used to assert usage did NOT advertise it as a future-slice placeholder;
  // that guard is now satisfied by the positive assertion above (and by the
  // /model mention in the --model line itself).
  it("the --model line mentions the runtime /model slash command", () => {
    expect(usage).toContain("--model <id>");
    expect(usage).toContain("/model");
  });

  it("lists every ANYCODE_* env var loadEnvConfig reads", () => {
    for (const name of [
      ENV_API_KEY,
      ENV_BASE_URL,
      ENV_MODEL,
      ENV_MAX_TURNS,
      ENV_MAX_OUTPUT_TOKENS,
      ENV_REASONING_EFFORT,
      ENV_CONTEXT_WINDOW,
      ENV_MAX_RETRIES,
      ENV_DB_PATH,
      ENV_TOOL_CONCURRENCY,
      ENV_STALL_TIMEOUT_MS,
    ]) {
      expect(usage).toContain(name);
    }
  });

  it("lists every COMMAND_HELP slash command (single source of truth with commands.ts)", () => {
    for (const entry of COMMAND_HELP) {
      expect(usage).toContain(entry.command);
    }
  });

  it("exits 0/no-throw shape: formatUsage never throws and always ends in a newline", () => {
    expect(() => formatUsage()).not.toThrow();
    expect(usage.endsWith("\n")).toBe(true);
  });
});
