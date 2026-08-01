"use client";

/**
 * Function index:
 * - LogoutButton: signs out the browser session and returns to the login route.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogout() {
    setLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const { error: logoutError } = await supabase.auth.signOut();

      if (logoutError) {
        setError("Gagal keluar. Silakan coba lagi.");
        setLoading(false);
        return;
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setError("Koneksi terputus. Silakan coba lagi.");
      setLoading(false);
    }
  }

  return (
    <div className={compact ? "w-full" : "inline-flex flex-col items-end"}>
      <button
        type="button"
        disabled={loading}
        onClick={handleLogout}
        className={
          compact
            ? "flex h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-slate-200 disabled:opacity-50"
            : "rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-slate-200 disabled:opacity-50"
        }
      >
        {loading ? "Keluar…" : "Keluar"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
