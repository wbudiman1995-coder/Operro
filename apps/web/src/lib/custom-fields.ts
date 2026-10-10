/**
 * Function index:
 * - validateCustomFieldInput: client-side mirror of the RPC value rules (the database stays authoritative).
 * - parseCustomFieldValuesForm: turns a submitted form into the {definitionId: text|null} payload.
 * - parseCustomFieldDefinitionForm: validates a definition form (type/entity are set only on creation).
 * - loadCustomFieldDefinitions / loadCustomFieldValues: RLS-scoped reads.
 * - displayCustomFieldValue: human text for a stored value, flagging options that no longer exist.
 *
 * Boundary: five scalar types only. Values are typed columns in `custom_field_values`; there is no JSON value,
 * no formula evaluation, and nothing here feeds search or export. The organization is never sent from the
 * browser: the RPCs use the authenticated session's active organization.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_ENTITIES = ["customer", "pet"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Teks singkat",
  number: "Angka",
  date: "Tanggal",
  boolean: "Ya / tidak",
  select: "Pilihan tunggal",
};
export const CUSTOM_FIELD_ENTITY_LABELS: Record<CustomFieldEntity, string> = { customer: "Pelanggan", pet: "Hewan" };

export const CUSTOM_FIELD_LABEL_MAX = 60;
export const CUSTOM_FIELD_OPTION_MAX = 40;
export const CUSTOM_FIELD_OPTIONS_LIMIT = 12;
export const CUSTOM_FIELD_TEXT_MAX = 200;

export interface CustomFieldOption { key: string; label: string }
export interface CustomFieldDefinition {
  id: string;
  entityType: CustomFieldEntity;
  label: string;
  fieldType: CustomFieldType;
  options: CustomFieldOption[];
  sortOrder: number;
  status: "active" | "archived";
  updatedAt: string;
}
export interface CustomFieldValue {
  definitionId: string;
  customerId: string | null;
  petId: string | null;
  text: string | null;
  number: number | null;
  date: string | null;
  boolean: boolean | null;
  option: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^-?[0-9]{1,12}(\.[0-9]{1,4})?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isCustomFieldId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  const year = date.getUTCFullYear();
  return year >= 1900 && year <= 2100;
}

/** Returns an error message, or null when the (already trimmed, non-empty) text is acceptable for the definition. */
export function validateCustomFieldInput(definition: Pick<CustomFieldDefinition, "fieldType" | "options" | "label">, text: string): string | null {
  const name = definition.label;
  switch (definition.fieldType) {
    case "text":
      if (Array.from(text).length > CUSTOM_FIELD_TEXT_MAX) return `${name}: maksimal ${CUSTOM_FIELD_TEXT_MAX} karakter.`;
      if (CONTROL.test(text)) return `${name}: karakter kontrol tidak diizinkan.`;
      if (/^[=+@-]/.test(text)) return `${name}: tidak boleh diawali = + - atau @.`;
      return null;
    case "number":
      return NUMBER.test(text) ? null : `${name}: isi angka biasa (maksimal 4 desimal).`;
    case "date":
      return validDate(text) ? null : `${name}: tanggal tidak valid.`;
    case "boolean":
      return text === "true" || text === "false" ? null : `${name}: pilih ya atau tidak.`;
    case "select":
      return definition.options.some((option) => option.key === text) ? null : `${name}: pilihan tidak tersedia.`;
  }
}

export type CustomFieldParseResult =
  | { ok: true; values: Record<string, string | null> }
  | { ok: false; message: string };

/**
 * Reads `cf_<definitionId>` entries. Only definitions the caller supplies (active, correct entity) are accepted;
 * repeated or unknown keys are errors. A blank value clears the stored value.
 */
export function parseCustomFieldValuesForm(formData: FormData, definitions: CustomFieldDefinition[]): CustomFieldParseResult {
  const known = new Map(definitions.filter((definition) => definition.status === "active").map((definition) => [definition.id, definition]));
  const values: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const [name, raw] of formData.entries()) {
    if (!name.startsWith("cf_")) continue;
    const id = name.slice(3);
    const definition = known.get(id);
    if (!definition || typeof raw !== "string" || seen.has(id)) return { ok: false, message: "Isian tambahan tidak dikenali. Muat ulang halaman lalu coba lagi." };
    seen.add(id);
    const text = raw.trim();
    if (!text) { values[id] = null; continue; }
    const problem = validateCustomFieldInput(definition, text);
    if (problem) return { ok: false, message: problem };
    values[id] = text;
  }
  return { ok: true, values };
}

export interface CustomFieldDefinitionInput {
  id: string | null;
  entityType: CustomFieldEntity | null;
  label: string;
  fieldType: CustomFieldType | null;
  optionLabels: string[] | null;
  sortOrder: number;
  expectedUpdatedAt: string | null;
}

export function parseCustomFieldDefinitionForm(formData: FormData): { ok: true; input: CustomFieldDefinitionInput } | { ok: false; message: string } {
  const one = (key: string): string | null => {
    const values = formData.getAll(key);
    return values.length === 1 && typeof values[0] === "string" ? values[0] : values.length === 0 ? "" : null;
  };
  const id = one("id"); const entity = one("entityType"); const label = one("label"); const type = one("fieldType");
  const options = one("options"); const sort = one("sortOrder"); const expected = one("expectedUpdatedAt");
  if ([id, entity, label, type, options, sort, expected].some((value) => value === null)) return { ok: false, message: "Data isian tidak lengkap atau dikirim berulang." };
  const creating = !id;
  if (!creating && !isCustomFieldId(id)) return { ok: false, message: "Isian tidak valid." };
  if (creating && !CUSTOM_FIELD_ENTITIES.includes(entity as CustomFieldEntity)) return { ok: false, message: "Pilih lingkup pelanggan atau hewan." };
  if (creating && !CUSTOM_FIELD_TYPES.includes(type as CustomFieldType)) return { ok: false, message: "Pilih tipe isian." };
  const cleanLabel = label!.trim();
  if (!cleanLabel || Array.from(cleanLabel).length > CUSTOM_FIELD_LABEL_MAX || CONTROL.test(cleanLabel)) return { ok: false, message: `Nama isian wajib diisi dan maksimal ${CUSTOM_FIELD_LABEL_MAX} karakter.` };
  const sortOrder = Number(sort || "0");
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) return { ok: false, message: "Urutan harus bilangan bulat 0–9999." };
  const isSelect = (creating ? type : formData.get("fieldType")) === "select";
  let optionLabels: string[] | null = null;
  if (isSelect) {
    optionLabels = options!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const lowered = optionLabels.map((option) => option.toLowerCase());
    if (optionLabels.length < 1 || optionLabels.length > CUSTOM_FIELD_OPTIONS_LIMIT) return { ok: false, message: `Isi 1–${CUSTOM_FIELD_OPTIONS_LIMIT} pilihan, satu per baris.` };
    if (new Set(lowered).size !== lowered.length) return { ok: false, message: "Pilihan tidak boleh kembar." };
    if (optionLabels.some((option) => Array.from(option).length > CUSTOM_FIELD_OPTION_MAX || CONTROL.test(option))) return { ok: false, message: `Setiap pilihan maksimal ${CUSTOM_FIELD_OPTION_MAX} karakter.` };
  } else if (options!.trim()) {
    return { ok: false, message: "Pilihan hanya untuk isian bertipe pilihan tunggal." };
  }
  return {
    ok: true,
    input: {
      id: creating ? null : id,
      entityType: creating ? (entity as CustomFieldEntity) : null,
      label: cleanLabel,
      fieldType: creating ? (type as CustomFieldType) : null,
      optionLabels,
      sortOrder,
      expectedUpdatedAt: creating ? null : expected || null,
    },
  };
}

interface DefinitionRow {
  id: string; entity_type: CustomFieldEntity; label: string; field_type: CustomFieldType;
  options: unknown; sort_order: number; status: "active" | "archived"; updated_at: string;
}
function readOptions(raw: unknown): CustomFieldOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const item = entry as { key?: unknown; label?: unknown };
    return typeof item?.key === "string" && typeof item?.label === "string" ? [{ key: item.key, label: item.label }] : [];
  });
}

export async function loadCustomFieldDefinitions(
  supabase: SupabaseClient,
  organizationId: string,
  entity: CustomFieldEntity | null,
  options: { includeArchived?: boolean } = {},
): Promise<CustomFieldDefinition[]> {
  let query = supabase.from("custom_field_definitions")
    .select("id,entity_type,label,field_type,options,sort_order,status,updated_at")
    .eq("organization_id", organizationId)
    .order("sort_order").order("label").limit(200);
  if (entity) query = query.eq("entity_type", entity);
  if (!options.includeArchived) query = query.eq("status", "active");
  const { data, error } = await query;
  if (error) throw new Error(`custom_field_definitions_failed:${error.message}`);
  return ((data ?? []) as DefinitionRow[]).map((row) => ({
    id: row.id, entityType: row.entity_type, label: row.label, fieldType: row.field_type,
    options: readOptions(row.options), sortOrder: row.sort_order, status: row.status, updatedAt: row.updated_at,
  }));
}

export async function loadCustomFieldValues(
  supabase: SupabaseClient,
  organizationId: string,
  entity: CustomFieldEntity,
  entityIds: string[],
): Promise<CustomFieldValue[]> {
  if (entityIds.length === 0) return [];
  const column = entity === "customer" ? "customer_id" : "pet_id";
  const { data, error } = await supabase.from("custom_field_values")
    .select("definition_id,customer_id,pet_id,value_text,value_number,value_date,value_boolean,value_option")
    .eq("organization_id", organizationId).eq("entity_type", entity).in(column, entityIds.slice(0, 200)).limit(2000);
  if (error) throw new Error(`custom_field_values_failed:${error.message}`);
  return (data ?? []).map((row) => ({
    definitionId: row.definition_id, customerId: row.customer_id, petId: row.pet_id,
    text: row.value_text, number: row.value_number === null ? null : Number(row.value_number),
    date: row.value_date, boolean: row.value_boolean, option: row.value_option,
  }));
}

/** The value as the editing form submits it (select -> option key, boolean -> "true"/"false"). */
export function customFieldFormValue(definition: Pick<CustomFieldDefinition, "fieldType">, value: CustomFieldValue | undefined): string {
  if (!value) return "";
  switch (definition.fieldType) {
    case "text": return value.text ?? "";
    case "number": return value.number === null ? "" : String(value.number);
    case "date": return value.date ?? "";
    case "boolean": return value.boolean === null ? "" : String(value.boolean);
    case "select": return value.option ?? "";
  }
}

/** Display text; a select value whose option was removed is shown as unavailable rather than hidden or guessed. */
export function displayCustomFieldValue(definition: Pick<CustomFieldDefinition, "fieldType" | "options">, value: CustomFieldValue | undefined): string | null {
  if (!value) return null;
  if (definition.fieldType === "boolean") return value.boolean === null ? null : value.boolean ? "Ya" : "Tidak";
  if (definition.fieldType === "select") {
    if (value.option === null) return null;
    const option = definition.options.find((item) => item.key === value.option);
    return option ? option.label : "Pilihan lama (tidak lagi tersedia)";
  }
  const raw = customFieldFormValue(definition, value);
  return raw === "" ? null : raw;
}
