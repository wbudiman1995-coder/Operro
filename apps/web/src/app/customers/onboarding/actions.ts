"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { loadCapabilities } from "@/lib/authorization";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface OnboardingActionState { error: string | null; success: string | null; linkPath?: string }

export async function createOnboardingLinkAction(_previous: OnboardingActionState, formData: FormData): Promise<OnboardingActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const capabilities = await loadCapabilities(workspace.supabase);
    if (!capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengelola pelanggan.", success: null };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const source = String(formData.get("source") ?? "").trim().slice(0, 80) || null;
    const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
    const { error } = await workspace.supabase.from("customer_onboarding_links").insert({ organization_id: workspace.activeOrganization.id, token_hash: tokenHash, source, internal_note: note });
    if (error) throw error;
    revalidatePath("/customers/onboarding");
    return { error: null, success: "Link aktif selama dua hari. Salin sekarang; token mentah tidak disimpan.", linkPath: `/join/${token}` };
  } catch (error) { console.error("create_onboarding_link_failed", error); return { error: "Link tidak dapat dibuat.", success: null }; }
}

export async function revokeOnboardingLinkAction(formData: FormData) {
  const workspace = await requireActiveWorkspace();
  const capabilities = await loadCapabilities(workspace.supabase);
  if (!capabilities["customer.manage"]) return;
  const id = String(formData.get("id") ?? "");
  await workspace.supabase.from("customer_onboarding_links").update({ status: "revoked" }).eq("organization_id", workspace.activeOrganization.id).eq("id", id).eq("status", "active");
  revalidatePath("/customers/onboarding");
}

export async function reviewOnboardingAction(formData: FormData) {
  const workspace = await requireActiveWorkspace();
  const decision = String(formData.get("decision") ?? "");
  const submissionId = String(formData.get("submissionId") ?? "");
  const mergeCustomer = String(formData.get("mergeCustomerId") ?? "") || null;
  const { error } = await workspace.supabase.schema("app").rpc("review_customer_onboarding", { p_submission: submissionId, p_decision: decision, p_merge_customer: mergeCustomer });
  if (error) console.error("review_onboarding_failed", error);
  revalidatePath("/customers/onboarding"); revalidatePath("/customers");
}
