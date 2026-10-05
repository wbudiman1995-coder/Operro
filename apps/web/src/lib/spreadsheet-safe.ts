/** Preserve useful Excel types while neutralizing formula-like text cells. */
export function spreadsheetSafeCell(value: unknown): string | number | boolean | Date {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  const text = String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}
