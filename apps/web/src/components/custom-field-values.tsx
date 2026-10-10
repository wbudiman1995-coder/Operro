import { displayCustomFieldValue, type CustomFieldDefinition, type CustomFieldValue } from "@/lib/custom-fields";

/** Read-only list of an entity's defined fields. Fields with no value are omitted; old records simply show nothing. */
export function CustomFieldValues({ definitions, values, className = "" }: { definitions: CustomFieldDefinition[]; values: CustomFieldValue[]; className?: string }) {
  const byDefinition = new Map(values.map((value) => [value.definitionId, value]));
  const rows = definitions.flatMap((definition) => {
    const text = displayCustomFieldValue(definition, byDefinition.get(definition.id));
    return text === null ? [] : [{ id: definition.id, label: definition.label, text }];
  });
  if (rows.length === 0) return null;
  return <dl className={`space-y-1 text-xs ${className}`} aria-label="Isian tambahan">
    {rows.map((row) => <div key={row.id} className="flex justify-between gap-3"><dt className="text-slate-400">{row.label}</dt><dd className="truncate font-semibold text-slate-600">{row.text}</dd></div>)}
  </dl>;
}
