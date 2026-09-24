"use server";

import "server-only";

import { revalidatePath } from "next/cache";

import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(["service_quality", "injury", "behavior", "billing", "lateness", "communication", "other"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["investigating", "resolved", "closed"]);
type State = { error: string | null; success: string | null };

function text(formData: FormData, key: string, max: number) { return String(formData.get(key) ?? "").trim().slice(0, max); }
function id(formData: FormData, key: string) { const value = text(formData, key, 36); return UUID.test(value) ? value : null; }
function optionalId(formData: FormData, key: string) { const value = text(formData, key, 36); return value ? (UUID.test(value) ? value : "invalid") : null; }
function error(scope: string, detail: string): State { return { error: `${scope}: ${detail}`, success: null }; }
function knownMessage(message: string) {
  if (/not_authorized|42501/i.test(message)) return "izin atau akses cabang tidak mencukupi";
  if (/customer_not_found|booking_mismatch|pet_mismatch|resource_mismatch/i.test(message)) return "tautan pelanggan, booking, hewan, atau groomer tidak cocok";
  if (/resolution_notes_required/i.test(message)) return "catatan penyelesaian wajib diisi";
  if (/invalid_complaint_transition/i.test(message)) return "perubahan status tidak diperbolehkan";
  if (/complaint_not_found/i.test(message)) return "keluhan tidak ditemukan";
  return null;
}

async function context() {
  const supabase = await createClient(); const auth = await loadAuthContext(supabase);
  return auth?.activeOrganization ? { supabase, organizationId: auth.activeOrganization.id } : null;
}

export async function createComplaintAction(_previous: State, formData: FormData): Promise<State> {
  try {
    const ctx = await context(); if (!ctx) return error("Keluhan", "workspace aktif tidak tersedia");
    const branchId = id(formData, "branchId"); const customerId = id(formData, "customerId"); const bookingId = optionalId(formData, "bookingId"); const petId = optionalId(formData, "petId"); const resourceId = optionalId(formData, "resourceId");
    const category = text(formData, "category", 40); const severity = text(formData, "severity", 20); const title = text(formData, "title", 160); const description = text(formData, "description", 4000);
    if (!branchId || !customerId || bookingId === "invalid" || petId === "invalid" || resourceId === "invalid" || !CATEGORIES.has(category) || !SEVERITIES.has(severity) || title.length < 3 || description.length < 3) return error("Keluhan", "data wajib atau tautan tidak valid");
    const result = await ctx.supabase.schema("app").rpc("create_complaint", { p_branch: branchId, p_customer: customerId, p_booking: bookingId, p_pet: petId, p_resource: resourceId, p_category: category, p_severity: severity, p_title: title, p_description: description });
    if (result.error) { const known = knownMessage(result.error.message); if (!known) console.error("create complaint failed", { code: result.error.code, message: result.error.message }); return error("Keluhan gagal dibuat", known ?? "server tidak dapat menyimpan keluhan"); }
    revalidatePath("/complaints"); revalidatePath("/leaderboard"); if (customerId) revalidatePath(`/customers/${customerId}`);
    return { error: null, success: "Keluhan dibuat dan jejak audit tersimpan." };
  } catch (caught) { console.error("create complaint action failed", caught); return error("Keluhan", "terjadi gangguan server"); }
}

export async function updateComplaintAction(_previous: State, formData: FormData): Promise<State> {
  try {
    const ctx = await context(); if (!ctx) return error("Keluhan", "workspace aktif tidak tersedia");
    const complaintId = id(formData, "complaintId"); const resourceId = optionalId(formData, "resourceId"); const severity = text(formData, "severity", 20); const resolutionNotes = text(formData, "resolutionNotes", 4000); const recoveryAction = text(formData, "recoveryAction", 2000);
    if (!complaintId || resourceId === "invalid" || !SEVERITIES.has(severity)) return error("Keluhan", "data perubahan tidak valid");
    const result = await ctx.supabase.schema("app").rpc("update_complaint", { p_complaint: complaintId, p_severity: severity, p_resource: resourceId, p_resolution_notes: resolutionNotes || null, p_recovery_action: recoveryAction || null });
    if (result.error) { const known = knownMessage(result.error.message); if (!known) console.error("update complaint failed", { code: result.error.code, message: result.error.message }); return error("Keluhan gagal diperbarui", known ?? "server tidak dapat memperbarui keluhan"); }
    revalidatePath("/complaints"); revalidatePath("/leaderboard"); return { error: null, success: "Detail dan tindakan pemulihan tersimpan." };
  } catch (caught) { console.error("update complaint action failed", caught); return error("Keluhan", "terjadi gangguan server"); }
}

export async function transitionComplaintAction(_previous: State, formData: FormData): Promise<State> {
  try {
    const ctx = await context(); if (!ctx) return error("Keluhan", "workspace aktif tidak tersedia");
    const complaintId = id(formData, "complaintId"); const to = text(formData, "to", 20); const resolutionNotes = text(formData, "resolutionNotes", 4000); const recoveryAction = text(formData, "recoveryAction", 2000);
    if (!complaintId || !STATUSES.has(to)) return error("Keluhan", "status tujuan tidak valid");
    if (["resolved", "closed"].includes(to) && resolutionNotes.length < 3) return error("Keluhan", "catatan penyelesaian wajib diisi");
    const result = await ctx.supabase.schema("app").rpc("transition_complaint", { p_complaint: complaintId, p_to: to, p_resolution_notes: resolutionNotes || null, p_recovery_action: recoveryAction || null });
    if (result.error) { const known = knownMessage(result.error.message); if (!known) console.error("transition complaint failed", { code: result.error.code, message: result.error.message }); return error("Status gagal diubah", known ?? "server tidak dapat mengubah status"); }
    revalidatePath("/complaints"); revalidatePath("/leaderboard"); return { error: null, success: "Status keluhan dan audit diperbarui." };
  } catch (caught) { console.error("transition complaint action failed", caught); return error("Keluhan", "terjadi gangguan server"); }
}
