export interface ExportPage<Row, Cursor> {
  rows: Row[];
  hasMore: boolean;
  nextCursor: Cursor | null;
}

/** Collect a bounded keyset-paginated export without silently truncating it. */
export async function collectExportPages<Row, Cursor>(
  loadPage: (cursor: Cursor | undefined) => Promise<ExportPage<Row, Cursor>>,
  maxPages: number,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: Cursor | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await loadPage(cursor);
    rows.push(...result.rows);
    if (!result.hasMore) return rows;
    if (!result.nextCursor) throw new Error("finance_export_missing_cursor");
    cursor = result.nextCursor;
  }

  throw new Error(`finance_export_exceeds_${maxPages}_pages`);
}
