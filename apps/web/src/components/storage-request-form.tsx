"use client";

import { useActionState } from "react";
import { requestStorageUpgradeAction, reviewStorageUpgradeAction, type StorageActionState } from "@/app/settings/storage/actions";

const initial: StorageActionState = { error: null, success: null };
export function StorageRequestForm({ pending }: { pending: boolean }) {
  const [state, action, saving] = useActionState(requestStorageUpgradeAction, initial);
  return <form action={action} className="space-y-3"><p className="text-xs text-slate-500">Permintaan ini tidak menambah kapasitas otomatis dan tidak menagih Anda. Tim Operro akan menghubungi Anda untuk harga dan pembayaran manual.</p><div className="grid gap-3 sm:grid-cols-[180px_1fr]"><label className="text-xs font-semibold">Tambahan yang dibutuhkan<select className="mt-1 h-10 w-full rounded-lg border px-3" name="requestedGb" defaultValue="5"><option value="1">1 GB</option><option value="5">5 GB</option><option value="10">10 GB</option><option value="25">25 GB</option><option value="50">50 GB</option><option value="100">100 GB</option></select></label><label className="text-xs font-semibold">Kebutuhan Anda<textarea className="mt-1 min-h-20 w-full rounded-lg border p-3" name="note" maxLength={1000} placeholder="Contoh: banyak foto hasil grooming per bulan" /></label></div><button disabled={saving || pending} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{saving ? "Mengirim…" : pending ? "Permintaan masih aktif" : "Minta tambahan kapasitas"}</button>{state.error || state.success ? <p className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p> : null}</form>;
}
export function StorageRequestReview({ id }: { id: string }) {
  const [state, action, saving] = useActionState(reviewStorageUpgradeAction, initial);
  return <form action={action} className="flex flex-wrap items-center gap-2"><input type="hidden" name="id" value={id} /><select name="status" className="h-9 rounded-lg border px-2 text-xs"><option value="contacted">Sudah dihubungi</option><option value="fulfilled">Selesai</option><option value="declined">Ditolak</option></select><button disabled={saving} className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">Simpan</button>{state.error || state.success ? <span className="text-xs">{state.error ?? state.success}</span> : null}</form>;
}
