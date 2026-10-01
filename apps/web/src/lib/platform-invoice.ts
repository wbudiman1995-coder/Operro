import type { SupabaseClient } from "@supabase/supabase-js";

export interface OperroInvoice {
  id: string;
  organization_id: string;
  organization_name: string;
  recipient_email: string | null;
  invoice_number: string;
  period_month: string;
  description: string;
  amount_idr: number;
  due_date: string;
  issued_at: string;
  status: string;
  paid_at: string | null;
}

export async function loadOperroInvoice(supabase: SupabaseClient, id: string): Promise<OperroInvoice | null> {
  const result = await supabase.schema("app").rpc("get_operro_invoice", { p_id: id });
  if (result.error) throw new Error(`operro_invoice_load_failed:${result.error.message}`);
  return result.data as OperroInvoice | null;
}

export function rupiah(value: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value));
}
