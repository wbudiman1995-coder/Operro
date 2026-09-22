import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

/**
 * Structural regression test for a class of bug this repo hit directly: a "use server"
 * file exporting a non-function value.
 *
 * Every export from a module with a top-level "use server" directive becomes a Server
 * Action reference for the client bundler. `IDLE_STATE`/`MutationState` are plain data,
 * not actions, so they must live in `lib/schedule/idle_state.ts` and never be exported —
 * directly or via re-export — from `app/schedule/actions.ts`. This is checked by parsing
 * the real source with the TypeScript compiler API rather than a text match, so it also
 * catches re-export syntax (`export { X } from ...`) that a simple `export const` grep
 * would miss.
 */

const ROOT = path.join(__dirname, "..");
const ACTIONS_PATH = path.join(ROOT, "src/app/schedule/actions.ts");
const IDLE_STATE_PATH = path.join(ROOT, "src/lib/schedule/idle_state.ts");

function readSource(filePath: string) {
  const text = fs.readFileSync(filePath, "utf8");
  return { text, sourceFile: ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

test('actions.ts starts with the "use server" directive', () => {
  const { text } = readSource(ACTIONS_PATH);
  assert.match(text.trimStart(), /^"use server";/);
});

test("every export from actions.ts is an async function declaration", () => {
  const { sourceFile } = readSource(ACTIONS_PATH);
  const exportedFunctionNames: string[] = [];

  sourceFile.forEachChild((node) => {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;

    if (ts.isFunctionDeclaration(node)) {
      assert.ok(node.name, "an exported function in a \"use server\" file must be named");
      assert.ok(
        hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        `exported function "${node.name!.getText(sourceFile)}" in actions.ts must be async — every export of a "use server" file is treated as a Server Action`,
      );
      exportedFunctionNames.push(node.name!.getText(sourceFile));
      return;
    }

    assert.fail(
      `actions.ts must export only async functions, found a non-function export: ${node.getText(sourceFile).slice(0, 80)}`,
    );
  });

  assert.deepEqual(
    exportedFunctionNames.sort(),
    ["archiveBookingAction", "cancelBookingAction", "cancelBookingSeriesAction", "cancelScheduleBookingsAction", "createBlackoutAction", "createBookingSeriesAction", "createBranchBlockAction", "createServedCityDateAction", "moveScheduleBookingsAction", "removeBlackoutAction", "removeBranchBlockAction", "removeServedCityDateAction", "replaceWeeklyAvailabilityAction", "rescheduleBookingAction", "updateBlackoutAction"].sort(),
    "actions.ts should export exactly the booking, series, and blackout server actions",
  );
});

test("actions.ts does not declare or export MutationState/IDLE_STATE itself", () => {
  const { text } = readSource(ACTIONS_PATH);
  assert.doesNotMatch(text, /export\s+(const|interface|type)\s+(IDLE_STATE|MutationState)\b/);
  assert.doesNotMatch(text, /export\s*\{[^}]*\b(IDLE_STATE|MutationState)\b[^}]*\}/);
});

test("actions.ts imports MutationState as a type-only import from lib/schedule/idle_state", () => {
  const { sourceFile } = readSource(ACTIONS_PATH);
  const importsMutationStateType = sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
    if (statement.moduleSpecifier.text !== "@/lib/schedule/idle_state") return false;
    const clause = statement.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
    return clause.namedBindings.elements.some(
      (element) => element.name.text === "MutationState" && (element.isTypeOnly || clause.isTypeOnly),
    );
  });
  assert.ok(importsMutationStateType, "expected `import type { MutationState } from \"@/lib/schedule/idle_state\"` in actions.ts");
});

test("lib/schedule/idle_state.ts owns MutationState and IDLE_STATE, and carries no directive", () => {
  const { text } = readSource(IDLE_STATE_PATH);
  assert.match(text, /export\s+interface\s+MutationState\b/);
  assert.match(text, /export\s+const\s+IDLE_STATE\s*:\s*MutationState\b/);
  assert.doesNotMatch(text.trimStart(), /^"use (server|client)";/);
});

test("blackout-manager and booking-edit-form import IDLE_STATE from idle_state.ts, not from actions.ts", () => {
  for (const relativePath of ["src/components/blackout-manager.tsx", "src/components/booking-edit-form.tsx"]) {
    const { text } = readSource(path.join(ROOT, relativePath));
    assert.match(
      text,
      /import\s*\{\s*IDLE_STATE\s*\}\s*from\s*["']@\/lib\/schedule\/idle_state["']/,
      `${relativePath} should import IDLE_STATE from @/lib/schedule/idle_state`,
    );
    const actionsImportLine = text.split("\n").find((line) => line.includes('from "@/app/schedule/actions"'));
    assert.ok(actionsImportLine, `${relativePath} should still import its server actions from @/app/schedule/actions`);
    assert.doesNotMatch(actionsImportLine!, /IDLE_STATE/, `${relativePath} must not import IDLE_STATE through actions.ts`);
  }
});
