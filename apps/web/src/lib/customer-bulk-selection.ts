export const BULK_SELECTION_LIMIT = 100;

export function toggleSelectedId(current: ReadonlySet<string>, id: string, checked: boolean): Set<string> {
  const next = new Set(current);
  if (!checked) {
    next.delete(id);
    return next;
  }
  if (!next.has(id) && next.size < BULK_SELECTION_LIMIT) next.add(id);
  return next;
}

export function toggleAllVisible(current: ReadonlySet<string>, visibleIds: readonly string[], checked: boolean): Set<string> {
  const next = new Set(current);
  if (!checked) {
    for (const id of visibleIds) next.delete(id);
    return next;
  }
  for (const id of visibleIds) {
    if (next.has(id)) continue;
    if (next.size >= BULK_SELECTION_LIMIT) break;
    next.add(id);
  }
  return next;
}

export function visibleSelectedIds(selected: ReadonlySet<string>, visibleIds: readonly string[]): string[] {
  return visibleIds.filter((id) => selected.has(id));
}

export function allVisibleSelected(selected: ReadonlySet<string>, visibleIds: readonly string[]): boolean {
  return visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
}
