/**
 * CLI workspace-trust prompt (Taskana 4736, design 2.9). A plain readline
 * question on the CLI's own input/output streams, shown before any project
 * spawn declaration loads. Answers: `t` trust (persisted), `o` once (this
 * process only, never persisted), anything else — including EOF — is No
 * (persisted as denied until the declarations change).
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ProjectSpawnItem } from "./project-spawn-config.js";
import type { WorkspaceTrustResult } from "./index.js";

export type TrustPromptAnswer = "trust" | "once" | "no";

/**
 * xfix m2: `y`/`yes` map to "trust" too — a user typing the universal
 * confirmation was silently persisted as DENIED (unrecognized => No) with no
 * confirmation. `n`/`no` map to "no" for symmetry; anything else still falls
 * through to "no" (the documented fail-closed default).
 */
export function parseTrustAnswer(line: string): TrustPromptAnswer {
  const answer = line.trim().toLowerCase();
  if (answer === "t" || answer === "trust" || answer === "y" || answer === "yes") return "trust";
  if (answer === "o" || answer === "once") return "once";
  if (answer === "n" || answer === "no") return "no";
  return "no";
}

/** One printable line per declaration: kind, name, command line, env KEY names only. */
export function describeTrustItem(item: ProjectSpawnItem): string {
  const env = item.envKeys.length > 0 ? ` (env: ${item.envKeys.join(", ")})` : "";
  return `  - [${item.kind}] ${item.name}: ${item.commandLine}${env}`;
}

/**
 * Asks whether to trust a folder's project spawn declarations. Resolves with
 * the answer; never rejects (a closed input is treated as No).
 */
export async function promptWorkspaceTrust(
  io: { input: Readable; output: Writable },
  result: WorkspaceTrustResult,
): Promise<TrustPromptAnswer> {
  const lines = [
    `This folder declares ${result.items.length} process(es) that would start from the project:`,
    `  ${result.folder}`,
    ...result.items.map(describeTrustItem),
    "Trust this folder's project configuration? Its commands run with your permissions.",
  ];
  io.output.write(`${lines.join("\n")}\n`);

  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    rl.once("close", () => {
      if (!settled) {
        settled = true;
        resolve("");
      }
    });
    rl.question("[t]rust / [o]nce / [N]o (y=yes): ", (line) => {
      if (!settled) {
        settled = true;
        resolve(line);
      }
    });
  });
  rl.close();
  return parseTrustAnswer(answer);
}
