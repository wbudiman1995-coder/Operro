"use server";

import { revalidatePath } from "next/cache";

import { DASHBOARD_CARD_KEYS } from "@/lib/dashboard-read-model";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface DashboardCardSettingsState {
  error: string | null;
  success: string | null;
}

export async function updateDashboardCardsAction(
  expectedOrganizationId: string,
  _previous: DashboardCardSettingsState,
  formData: FormData,
): Promise<DashboardCardSettingsState> {
  const workspace = await requireActiveWorkspace();
  if (workspace.activeOrganization.id !== expectedOrganizationId) {
    return { error: "Workspace aktif berubah. Muat ulang dashboard sebelum menyimpan.", success: null };
  }
  if (!workspace.capabilities["settings.manage"]) {
    return { error: "Anda tidak memiliki izin mengubah pengaturan dashboard.", success: null };
  }

  const cards: Record<string, boolean> = {};
  for (const key of DASHBOARD_CARD_KEYS) {
    const value = formData.get(`card_${key}`);
    if (value !== "true" && value !== "false") {
      return { error: "Pilihan kartu dashboard tidak valid.", success: null };
    }
    cards[key] = value === "true";
  }

  const { error } = await workspace.supabase.schema("app").rpc("update_dashboard_card_settings", { p_cards: cards });
  if (error) {
    if (error.code === "42501") return { error: "Anda tidak memiliki izin mengubah pengaturan dashboard.", success: null };
    if (error.code === "22023") return { error: "Pilihan kartu dashboard tidak valid.", success: null };
    console.error("dashboard_card_settings_update_failed", error);
    return { error: "Pengaturan belum tersimpan. Coba lagi.", success: null };
  }
  revalidatePath("/dashboard");
  return { error: null, success: "Pengaturan kartu dashboard disimpan." };
}
