"use server";

import "server-only";
import { revalidatePath } from "next/cache";

import { issueInvoiceForBookingAction, type PilotActionState } from "@/app/pilot-actions";
import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (message: string): PilotActionState => ({ error: message, success: null });
const success = (message: string): PilotActionState => ({ error: null, success: message });
const value = (form: FormData, key: string, max = 200) => String(form.get(key) ?? "").trim().slice(0, max);
const id = (form: FormData, key: string) => { const candidate = value(form, key, 36); return UUID.test(candidate) ? candidate : null; };

async function invoiceContext() {
  const supabase = await createClient();
  const auth = await loadAuthContext(supabase);
  if (!auth?.activeOrganization) return null;
  const capabilities = await loadCapabilities(supabase);
  return { supabase, organizationId: auth.activeOrganization.id, capabilities };
}

export async function createBookingInvoiceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await invoiceContext();
  if (!context) return failure("Sesi atau organisasi aktif tidak tersedia.");
  if (!context.capabilities["invoice.issue"]) return failure("Peran Anda tidak diizinkan menerbitkan invoice.");
  const bookingId = id(formData, "bookingId");
  if (!bookingId) return failure("Pilih appointment yang valid.");
  await issueInvoiceForBookingAction(formData);
  const orders = await context.supabase.from("orders").select("id").eq("organization_id", context.organizationId).eq("booking_id", bookingId).is("deleted_at", null);
  const orderIds = (orders.data ?? []).map((row) => row.id);
  if (!orderIds.length) return failure("Invoice belum dapat dibuat. Pastikan appointment sudah selesai dan memiliki baris layanan.");
  const invoice = await context.supabase.from("invoices").select("invoice_number").eq("organization_id", context.organizationId).in("order_id", orderIds).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!invoice.data) return failure("Invoice belum dapat dibuat. Periksa detail appointment lalu coba lagi.");
  revalidatePath("/invoices/new"); revalidatePath("/finance"); revalidatePath("/operations");
  return success(`${invoice.data.invoice_number} berhasil diterbitkan.`);
}

export async function createPackageInvoiceAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await invoiceContext();
  if (!context) return failure("Sesi atau organisasi aktif tidak tersedia.");
  if (!context.capabilities["invoice.issue"] || !context.capabilities["membership.manage"]) return failure("Peran Anda tidak memiliki izin invoice dan paket.");
  const branchId = id(formData, "branchId"); const customerId = id(formData, "customerId"); const packageId = id(formData, "packageId");
  const petId = id(formData, "petId");
  const requestKey = id(formData, "requestKey");
  const issuedDate = value(formData, "invoiceDate", 10); const dueDate = value(formData, "dueDate", 10);
  if (!branchId || !customerId || !packageId || !requestKey || !issuedDate) return failure("Cabang, pelanggan, paket, dan tanggal invoice wajib diisi.");
  const issuedAt = new Date(`${issuedDate}T09:00:00+07:00`).toISOString();
  const dueAt = dueDate ? new Date(`${dueDate}T23:59:59+07:00`).toISOString() : null;
  if (dueAt && new Date(dueAt) < new Date(issuedAt)) return failure("Tanggal jatuh tempo tidak boleh sebelum tanggal invoice.");
  const result = await context.supabase.schema("app").rpc("create_package_invoice", {
    p_branch: branchId, p_customer: customerId, p_package: packageId, p_issued_at: issuedAt, p_due_at: dueAt,
    p_admin_notes: value(formData, "adminNotes", 2000) || null, p_request_key: requestKey, p_pet: petId,
  });
  if (result.error) { console.error("create_package_invoice_failed", result.error); return failure("Invoice paket gagal dibuat. Periksa data dan coba lagi."); }
  const row = result.data as { invoice_number?: string } | null;
  revalidatePath("/invoices/new"); revalidatePath("/finance"); revalidatePath("/programs"); revalidatePath(`/customers/${customerId}`);
  return success(`${row?.invoice_number ?? "Invoice paket"} berhasil diterbitkan dan saldo sesi dibuat.`);
}

export async function updateInvoiceDetailsAction(_previous: PilotActionState, formData: FormData): Promise<PilotActionState> {
  const context = await invoiceContext();
  if (!context) return failure("Sesi atau organisasi aktif tidak tersedia.");
  if (!context.capabilities["invoice.issue"]) return failure("Peran Anda tidak diizinkan mengubah invoice.");
  const invoiceId = id(formData, "invoiceId"); const groomerId = id(formData, "groomerId");
  const revision = Number(formData.get("revision")); const issuedDate = value(formData, "invoiceDate", 10); const dueDate = value(formData, "dueDate", 10);
  const documentType = value(formData, "documentType", 30);
  if (!invoiceId || !Number.isInteger(revision) || revision < 1 || !issuedDate || !["invoice", "service_report"].includes(documentType)) return failure("Detail invoice tidak valid.");
  const result = await context.supabase.schema("app").rpc("update_unpaid_invoice_details", {
    p_invoice: invoiceId, p_revision: revision,
    p_issued_at: new Date(`${issuedDate}T09:00:00+07:00`).toISOString(),
    p_due_at: dueDate ? new Date(`${dueDate}T23:59:59+07:00`).toISOString() : null,
    p_document_type: documentType, p_groomer: groomerId,
    p_manual_groomer: value(formData, "manualGroomer", 160) || null,
    p_admin_notes: value(formData, "adminNotes", 2000) || null,
  });
  if (result.error) {
    console.error("update_invoice_details_failed", result.error);
    if (result.error.message.includes("stale_invoice")) return failure("Invoice berubah di tab lain. Muat ulang sebelum menyimpan kembali.");
    if (result.error.message.includes("invoice_locked")) return failure("Invoice sudah dibayar atau memiliki pembayaran dan tidak dapat diubah.");
    return failure("Detail invoice gagal disimpan.");
  }
  revalidatePath("/finance"); revalidatePath("/invoices/new");
  return success("Detail invoice diperbarui.");
}
