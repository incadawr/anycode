/**
 * S3-closure durability guard (ARBITRATION-S3-RES14.md, D-S3-21).
 *
 * Pins the load-bearing invariant behind the B1 fix (ARBITRATION-S3-W1
 * D-S3-16): the stretch of runTurnInner from the prologue mode read
 * (`const mode = options?.mode ?? this.config.mode;`) to the context publish
 * (`this.activeDispatchCtx = dispatchCtx;`) must be ONE JavaScript job — no
 * suspension point (await/yield) and no top-level transfer of control
 * (call/new/tagged template/spread/for-of). H1 proves the fix's behavior but
 * releases its hook gate before the stretch begins; MH1 pins the read's
 * POSITION, not the stretch's EMPTINESS. A future `await` inserted into the
 * stretch would reopen B1 with the whole behavioral suite green — this file
 * is the only automated tripwire (RESIDUALS-S3.md#RES-14, closed by D-S3-21).
 *
 * Deliberate over-approximation: ALL top-level call expressions are
 * forbidden, even provably safe intrinsics. A maintainer who genuinely needs
 * one in the stretch must consciously amend this guard, making the edit
 * visible in review — that amendment IS the guard working as designed.
 *
 * NOT detected here (RESIDUALS-S3.md#RES-15): a getter/Proxy introduced over
 * the config object at a construction site outside agent-loop.ts (a plain
 * property read in the stretch would then transfer control), and divergence
 * between this source text and emitted JS (target ES2023: native async
 * generators, no downlevel tick insertion).
 *
 * Fails LOUD on marker drift: if runTurnInner, the read, or the publish stop
 * being findable exactly once at the method body's top level, G1 fails
 * rather than the scan silently passing over an empty span.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

interface PrologueSpan {
  sourceFile: ts.SourceFile;
  span: readonly ts.Statement[];
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node)
  );
}

function loadPrologueSpan(): PrologueSpan {
  const sourcePath = fileURLToPath(new URL("./agent-loop.ts", import.meta.url));
  const sourceFile = ts.createSourceFile(
    "agent-loop.ts",
    readFileSync(sourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const methods: ts.MethodDeclaration[] = [];
  const findMethods = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(sourceFile) === "runTurnInner") {
      methods.push(node);
    }
    ts.forEachChild(node, findMethods);
  };
  findMethods(sourceFile);
  expect(methods, "exactly one runTurnInner method must exist").toHaveLength(1);
  const body = methods[0]!.body;
  expect(body, "runTurnInner must have a body").toBeDefined();

  const statements = body!.statements;
  const readIndexes: number[] = [];
  const publishIndexes: number[] = [];
  statements.forEach((statement, index) => {
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1 &&
      statement.declarationList.declarations[0]!.name.getText(sourceFile) === "mode"
    ) {
      readIndexes.push(index);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sourceFile) === "this.activeDispatchCtx" &&
      ts.isIdentifier(statement.expression.right) &&
      statement.expression.right.text === "dispatchCtx"
    ) {
      publishIndexes.push(index);
    }
  });

  expect(
    readIndexes,
    "exactly one top-level `mode` declaration must exist in runTurnInner",
  ).toHaveLength(1);
  expect(
    publishIndexes,
    "exactly one top-level `this.activeDispatchCtx = dispatchCtx` publish must exist in runTurnInner",
  ).toHaveLength(1);
  expect(publishIndexes[0]!, "the publish must come after the read").toBeGreaterThan(
    readIndexes[0]!,
  );

  return { sourceFile, span: statements.slice(readIndexes[0]!, publishIndexes[0]! + 1) };
}

function collectViolations(span: readonly ts.Statement[], sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    // Closure bodies never execute during the prologue; suspension points and
    // calls inside them are the sanctioned pattern (checkpoint.ensure,
    // exitPlan, currentMode). Do not descend past a function boundary.
    if (isFunctionBoundary(node)) {
      return;
    }
    let label: string | null = null;
    if (ts.isAwaitExpression(node)) label = "await expression";
    else if (ts.isYieldExpression(node)) label = "yield expression";
    else if (ts.isCallExpression(node)) label = "call expression";
    else if (ts.isNewExpression(node)) label = "new expression";
    else if (ts.isTaggedTemplateExpression(node)) label = "tagged template";
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) label = "spread";
    else if (ts.isForOfStatement(node)) label = "for-of statement";
    if (label !== null) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(
        `${label} at agent-loop.ts:${line + 1}: ${node.getText(sourceFile).slice(0, 80)}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of span) {
    visit(statement);
  }
  return violations;
}

describe("runTurnInner prologue guard — read→publish is one JS job (D-S3-21, closes RES-14)", () => {
  it("G1: markers hold — one runTurnInner, one top-level mode read, one publish, in order", () => {
    const { span } = loadPrologueSpan();
    // The span includes both endpoint statements; it can never be empty.
    expect(span.length).toBeGreaterThanOrEqual(2);
  });

  it("G2: no suspension point and no top-level control transfer between read and publish", () => {
    const { sourceFile, span } = loadPrologueSpan();
    const violations = collectViolations(span, sourceFile);
    expect(
      violations,
      [
        "The runTurnInner stretch from `const mode = ...` to `this.activeDispatchCtx = dispatchCtx;`",
        "must stay a single synchronous job: a setMode() landing in a gap there is silently lost",
        "for the whole turn (wave-1 BLOCKER B1, ARBITRATION-S3-W1 D-S3-16). Move the offending",
        "construct out of the stretch, or amend this guard ONLY with an arbitration ruling",
        "(ARBITRATION-S3-RES14.md D-S3-21). Violations:",
        ...violations,
      ].join("\n"),
    ).toEqual([]);
  });
});
