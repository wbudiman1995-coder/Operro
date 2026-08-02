/**
 * Function index:
 * - PageHeader: consistent route heading and optional action area.
 * - StatCard: compact business metric card.
 * - StatusBadge: localized operational state badge.
 * - EmptyState: honest empty-data treatment.
 */
import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-sm font-semibold text-emerald-700">{eyebrow}</p><h1 className="mt-2 text-3xl font-bold tracking-[-0.04em] sm:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p></div>{action}</div>;
}

export function StatCard({ label, value, helper, tone = "default" }: { label: string; value: string; helper: string; tone?: "default" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-emerald-700" : tone === "warning" ? "text-amber-700" : "text-slate-950";
  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-semibold text-slate-500">{label}</p><p className={`mt-3 text-3xl font-bold tracking-[-0.04em] ${toneClass}`}>{value}</p><p className="mt-3 text-xs leading-5 text-slate-400">{helper}</p></article>;
}

const statusLabels: Record<string, string> = {
  draft: "Draft", requested: "Diminta", confirmed: "Dikonfirmasi", in_progress: "Berjalan", completed: "Selesai", canceled: "Dibatalkan", no_show: "Tidak hadir",
  todo: "Belum dikerjakan", done: "Selesai", active: "Aktif", inactive: "Tidak aktif", issued: "Terbit", paid: "Lunas", void: "Batal", pending: "Menunggu", succeeded: "Berhasil", failed: "Gagal", recorded: "Tercatat", approved: "Disetujui", reimbursed: "Diganti",
};

export function StatusBadge({ status }: { status: string }) {
  const positive = ["active", "completed", "done", "paid", "succeeded"].includes(status);
  const warning = ["todo", "pending", "issued", "requested", "in_progress"].includes(status);
  return <span className={`inline-flex w-fit rounded-full px-2.5 py-1 text-[11px] font-bold ${positive ? "bg-emerald-50 text-emerald-700" : warning ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>{statusLabels[status] ?? status.replaceAll("_", " ")}</span>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 px-6 py-12 text-center"><p className="font-bold text-slate-700">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p></div>;
}
