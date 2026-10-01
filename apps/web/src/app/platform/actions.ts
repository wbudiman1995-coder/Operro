"use server";

import { revalidatePath } from "next/cache";
import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export type AccessState = { error: string | null; success: string | null; linkPath?: string | null };
const denied = { error: "Akses tidak diizinkan atau data tidak valid.", success: null };

async function session() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  return context ? supabase : null;
}

async function isPlatformOwner() {
  const supabase = await session();
  if (!supabase) return null;
  const { data, error } = await supabase.schema("app").rpc("is_operro_owner");
  return !error && data === true ? supabase : null;
}

export async function prepareOrganizationAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await isPlatformOwner();
  if (!supabase) return denied;
  const name = String(data.get("name") ?? "").trim();
  const slug = String(data.get("slug") ?? "").trim().toLowerCase();
  if (name.length < 2 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return { error: "Isi nama dan slug huruf kecil tanpa spasi.", success: null };
  const result = await supabase.schema("app").rpc("prepare_operro_organization", { p_name: name, p_slug: slug });
  if (result.error) return { error: result.error.code === "23505" ? "Slug sudah dipakai. Pilih slug lain." : "Organisasi belum dapat dibuat.", success: null };
  revalidatePath("/platform");
  return { error: null, success: `Organisasi ${name} disiapkan. Sekarang buat link untuk pemiliknya.` };
}

export async function issueAccessInviteAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await session();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  const email = String(data.get("email") ?? "").trim().toLowerCase();
  const role = String(data.get("role") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(org) || !/^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(email) || !["Pemilik", "Admin", "Bantuan Operro", "Groomer"].includes(role)) return denied;
  const result = await supabase.schema("app").rpc("issue_access_invitation", { p_org: org, p_email: email, p_role: role });
  if (result.error) return { error: result.error.message.includes("invalid_invitation") ? "Organisasi tidak aktif atau peran belum tersedia. Aktifkan organisasi lalu coba lagi." : "Link undangan belum dapat dibuat. Coba masuk ulang; jika berulang, laporkan kepada Operro.", success: null };
  if (typeof result.data !== "string") return { error: "Link undangan belum dapat dibuat. Coba lagi.", success: null };
  revalidatePath("/platform");
  revalidatePath("/settings/access");
  return { error: null, success: `Link satu kali untuk ${email}, berlaku tujuh hari. Kirim hanya ke alamat ini.`, linkPath: `/accept/${result.data}` };
}

export async function setOrganizationStatusAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await isPlatformOwner();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  const status = String(data.get("status") ?? "");
  const reason = String(data.get("reason") ?? "").trim().slice(0, 500);
  if (!/^[0-9a-f-]{36}$/i.test(org) || !["active", "suspended"].includes(status) || (status === "suspended" && !reason)) return { error: "Pilih status dan isi alasan penangguhan.", success: null };
  const result = await supabase.schema("app").rpc("set_operro_organization_status", { p_org: org, p_status: status, p_reason: reason });
  if (result.error) return denied;
  revalidatePath("/platform");
  revalidatePath("/organizations");
  return { error: null, success: status === "suspended" ? "Organisasi ditangguhkan. Akses dan langganan dijeda." : "Organisasi diaktifkan kembali." };
}

export async function setBillingPeriodAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await isPlatformOwner();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  const month = String(data.get("month") ?? "");
  const due = String(data.get("due") ?? "");
  const amount = Number(data.get("amount") ?? NaN);
  const status = String(data.get("status") ?? "");
  const note = String(data.get("note") ?? "").trim().slice(0, 500);
  if (!/^[0-9a-f-]{36}$/i.test(org) || !/^\d{4}-\d{2}$/.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(due)
    || !Number.isFinite(amount) || amount < 0 || !["awaiting_payment", "paid", "overdue", "waived"].includes(status)) return denied;
  const result = await supabase.schema("app").rpc("set_operro_billing_period", {
    p_org: org, p_month: `${month}-01`, p_amount: amount, p_due: due, p_status: status, p_note: note || null,
  });
  if (result.error) return { error: result.error.message.includes("issued_invoice_terms_locked") ? "Invoice sudah terbit. Nominal dan jatuh tempo terkunci; ubah hanya status pembayaran." : "Catatan pembayaran belum dapat disimpan.", success: null };
  revalidatePath("/platform");
  return { error: null, success: `Pembayaran ${month} tersimpan.` };
}

export async function issueOperroInvoiceAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await isPlatformOwner();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  const month = String(data.get("month") ?? "");
  const description = String(data.get("description") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(org) || !/^\d{4}-\d{2}-\d{2}$/.test(month) || description.length > 300) return denied;
  const result = await supabase.schema("app").rpc("issue_operro_invoice", { p_org: org, p_month: month, p_description: description || null });
  if (result.error) return { error: result.error.message.includes("invoice_already_issued_with_different_terms") ? "Invoice bulan ini sudah terbit dengan rincian berbeda. Buka invoice yang ada." : "Invoice belum dapat diterbitkan. Pastikan catatan bulan memiliki nominal positif dan bukan dibebaskan.", success: null };
  revalidatePath("/platform");
  return { error: null, success: "Invoice Operro diterbitkan. Salin tautan dan kirim kepada pemilik bisnis.", linkPath: `/billing/${result.data}` };
}

export async function setMemberRoleAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await session();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  const email = String(data.get("email") ?? "");
  const role = String(data.get("role") ?? "");
  const status = String(data.get("status") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(org) || !email.includes("@") || !["Pemilik", "Admin", "Bantuan Operro", "Groomer"].includes(role) || !["active", "suspended"].includes(status)) return denied;
  const result = await supabase.schema("app").rpc("set_organization_member_role", { p_org: org, p_email: email, p_role: role, p_status: status });
  if (result.error) return { error: result.error.message.includes("last_owner") ? "Pemilik terakhir tidak boleh dinonaktifkan." : "Perubahan akses ditolak.", success: null };
  revalidatePath("/platform");
  revalidatePath("/settings/access");
  return { error: null, success: `Akses ${email} diperbarui.` };
}

export async function setAdminPermissionsAction(_state: AccessState, data: FormData): Promise<AccessState> {
  const supabase = await session();
  if (!supabase) return denied;
  const org = String(data.get("organizationId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(org)) return denied;
  const keys = data.getAll("permissions").map(String);
  const result = await supabase.schema("app").rpc("set_business_admin_permissions", { p_org: org, p_keys: keys });
  if (result.error) return denied;
  revalidatePath("/settings/access");
  return { error: null, success: "Checklist izin Admin tersimpan." };
}
