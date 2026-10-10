"use server";

import { revalidatePath } from "next/cache";
import { parseLandingChoice } from "@/lib/preferences";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface PreferenceState { error: string | null; success: string | null }

/** Saves the caller's own landing page. The user and organization come from the session, never the form. */
export async function saveLandingPageAction(_previous: PreferenceState, formData: FormData): Promise<PreferenceState> {
  try {
    const workspace = await requireActiveWorkspace();
    const values = formData.getAll("landing");
    if (values.length !== 1) return { error: "Pilihan halaman awal tidak valid.", success: null };
    const choice = parseLandingChoice(values[0]);
    if (choice === undefined) return { error: "Pilihan halaman awal tidak valid.", success: null };
    const { error } = await workspace.supabase.schema("app").rpc("set_my_landing_page", { p_landing: choice });
    if (error) {
      console.error("landing_page_save_failed", error);
      if (error.code === "42501") return { error: "Peran Anda saat ini tidak dapat membuka halaman itu. Pilih halaman lain.", success: null };
      if (error.code === "22023") return { error: "Pilihan halaman awal tidak valid.", success: null };
      return { error: "Preferensi belum tersimpan. Coba lagi.", success: null };
    }
    revalidatePath("/settings/preferences");
    return { error: null, success: choice ? "Halaman awal disimpan untuk akun Anda." : "Halaman awal dikembalikan ke Ringkasan." };
  } catch (error) {
    console.error("landing_page_save_unexpected", error);
    return { error: "Preferensi belum tersimpan. Coba lagi.", success: null };
  }
}
