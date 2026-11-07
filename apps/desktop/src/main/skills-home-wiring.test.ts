import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { resolveSkillsProfileHome } from "./dev-profile.js";
import { applySubagentsHomeOverride } from "./host-env.js";
import { resolveExtensionsHomeOverride } from "../host/dev-home.js";
const main = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const host = ts.createSourceFile("host.ts", readFileSync(new URL("../host/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let paneHome: ts.Node, forkHome: ts.Node, forward: ts.Node;
function visit(n: ts.Node) {
  if (ts.isCallExpression(n) && n.expression.getText(main) === "registerSkillsIpc") {
    paneHome = ((n.arguments[0] as ts.ObjectLiteralExpression).properties.find(p => p.name?.getText(main) === "home") as ts.PropertyAssignment).initializer;
  }
  if (ts.isVariableDeclaration(n) && n.name.getText(main) === "skillsHome") forkHome = n.initializer!;
  if (ts.isExpressionStatement(n) && n.expression.getText(main) === "applySubagentsHomeOverride(env, skillsHome)") forward = n;
  ts.forEachChild(n, visit);
}
visit(main);
const profile = host.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "hostProfileHome")!;
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
it.each(["ANYCODE_SKILLS_IMPORT_HOME", "ANYCODE_SUBAGENTS_HOME", "ANYCODE_PROFILE_HOME", "ANYCODE_USER_DATA_DIR"])("forwards pane home to host policy for %s", key => {
  for (const isPackaged of [false, true]) {
    const bootEnv = { ANYCODE_AUTOMATION: "1", [key]: "/synthetic/profile" };
    const env = { ...bootEnv };
    const deps = { selfCheckProfile: undefined, resolveSkillsProfileHome, applySubagentsHomeOverride,
      bootEnv, env, app: { isPackaged }, process: { env: bootEnv }, homedir: () => "/fallback" };
    const executable = compile(`const pane = ${paneHome!.getText(main)}; const skillsHome = ${forkHome!.getText(main)}; ${forward!.getText(main)};`);
    const pane = new Function(...Object.keys(deps), `${executable}; return pane();`)(...Object.values(deps));
    const read = new Function("resolveExtensionsHomeOverride", "homedir", "process", `${compile(profile.getText(host))}; return hostProfileHome();`);
    expect(read(resolveExtensionsHomeOverride, deps.homedir, { env })).toBe(pane);
    expect(pane).toBe(isPackaged ? "/fallback" : "/synthetic/profile");
  }
});
