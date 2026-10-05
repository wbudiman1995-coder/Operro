import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectExportPages } from "../src/lib/finance-export-pagination";
import { spreadsheetSafeCell } from "../src/lib/spreadsheet-safe";

const readSource = (relativePath: string) => fs.readFileSync(path.join(__dirname, relativePath), "utf8");

test("collects every keyset page in order", async () => {
  const seen: Array<number | undefined> = [];
  const rows = await collectExportPages(async (cursor: number | undefined) => {
    seen.push(cursor);
    if (cursor === undefined) return { rows: [1, 2], hasMore: true, nextCursor: 2 };
    if (cursor === 2) return { rows: [3], hasMore: true, nextCursor: 3 };
    return { rows: [4], hasMore: false, nextCursor: null };
  }, 4);
  assert.deepEqual(rows, [1, 2, 3, 4]);
  assert.deepEqual(seen, [undefined, 2, 3]);
});

test("fails instead of silently truncating or losing a cursor", async () => {
  await assert.rejects(
    collectExportPages(async () => ({ rows: [1], hasMore: true, nextCursor: null }), 2),
    /finance_export_missing_cursor/,
  );
  await assert.rejects(
    collectExportPages(async (cursor: number | undefined) => ({ rows: [cursor ?? 1], hasMore: true, nextCursor: (cursor ?? 1) + 1 }), 2),
    /finance_export_exceeds_2_pages/,
  );
});

test("neutralizes formula-like text while preserving numeric Excel cells", () => {
  for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd", "  =hidden"]) {
    assert.equal(String(spreadsheetSafeCell(value)).startsWith("'"), true);
  }
  assert.equal(spreadsheetSafeCell("ordinary"), "ordinary");
  assert.equal(spreadsheetSafeCell(125000), 125000);
  assert.equal(spreadsheetSafeCell(null), "");
});

test("finance export keeps server authorization, tenant currency lookup, and a pagination sentinel", () => {
  const route = readSource("../src/app/finance/export/route.ts");
  const source = readSource("../src/lib/finance-export.ts");
  assert.match(route, /capabilities\["finance\.read"\]/);
  assert.match(route, /filter bulan harus YYYY-MM/);
  assert.match(source, /pageSize: 199/);
  assert.match(source, /\.eq\("organization_id", organizationId\)/);
  assert.match(source, /"Mata Uang"/);
  assert.match(source, /Pengeluaran - Semua/);
});
