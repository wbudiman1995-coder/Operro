"use client";

/**
 * Function index:
 * - GlobalErrorState: provides a safe recovery path for unexpected server-data or rendering failures.
 */
import { useEffect } from "react";

import { OperroMark } from "@/components/operro-mark";

export default function GlobalErrorState({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("Operro route error", error.digest ?? error.name);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-5 py-10">
      <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-950/5 sm:p-10">
        <div className="flex justify-center">
          <OperroMark />
        </div>
        <p className="mt-8 text-xs font-bold uppercase tracking-[0.18em] text-rose-600">
          Terjadi kendala
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-[-0.04em] text-slate-950">
          Data workspace belum dapat dimuat
        </h1>
        <p className="mt-4 text-sm leading-7 text-slate-500">
          Tidak ada akses yang dianggap berhasil sebelum organisasi dan sesi Anda
          selesai diverifikasi. Silakan coba memuat ulang.
        </p>
        <button
          type="button"
          onClick={unstable_retry}
          className="mt-7 h-11 rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-500/20"
        >
          Coba lagi
        </button>
      </section>
    </main>
  );
}
