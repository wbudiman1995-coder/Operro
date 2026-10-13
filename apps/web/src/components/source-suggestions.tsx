import { SOURCE_SUGGESTION_LIST_ID } from "@/lib/business-defaults";

/** The suggestion list a customer "source" input points at (list="source-label-suggestions"). Suggestions only; any value is accepted. */
export function SourceSuggestions({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return <datalist id={SOURCE_SUGGESTION_LIST_ID}>{labels.map((label) => <option key={label} value={label} />)}</datalist>;
}
