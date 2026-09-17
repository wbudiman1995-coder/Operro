/**
 * Function index:
 * - PageHeader: consistent route heading and optional action area.
 * - StatCard: compact business metric card.
 * - StatusBadge: localized operational state badge.
 * - EmptyState: honest empty-data treatment.
 */
import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#0f8a72]">{eyebrow}</p><h1 className="mt-2 text-[28px] font-bold tracking-[-0.035em] text-[#1a2233] sm:text-[34px]">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#5b6472]">{description}</p></div>{action}</div>;
}

export function StatCard({ label, value, helper, tone = "default" }: { label: string; value: string; helper: string; tone?: "default" | "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-[#0f8a72]" : tone === "warning" ? "text-amber-700" : "text-[#1a2233]";
  return <article className="rounded-[14px] border border-[#e4e7ec] bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.06)]"><p className="text-[12px] font-semibold text-[#5b6472]">{label}</p><p className={`mt-2 text-[28px] font-bold tracking-[-0.035em] ${toneClass}`}>{value}</p><p className="mt-2 text-[11px] leading-5 text-[#8a93a3]">{helper}</p></article>;
}

const statusLabels: Record<string, string> = {
  draft: "Draft", requested: "Diminta", confirmed: "Dikonfirmasi", in_progress: "Berjalan", completed: "Selesai", canceled: "Dibatalkan", no_show: "Tidak hadir",
  todo: "Belum dikerjakan", done: "Selesai", active: "Aktif", inactive: "Tidak aktif", issued: "Terbit", paid: "Lunas", void: "Batal", pending: "Menunggu", succeeded: "Berhasil", failed: "Gagal", recorded: "Tercatat", approved: "Disetujui", reimbursed: "Diganti",
};

export function StatusBadge({ status }: { status: string }) {
  const positive = ["active", "completed", "done", "paid", "succeeded"].includes(status);
  const warning = ["todo", "pending", "issued", "requested", "in_progress"].includes(status);
  return <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${positive ? "bg-[#e3f5f1] text-[#0b6e5a]" : warning ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}><span className="size-1.5 rounded-full bg-current opacity-70" />{statusLabels[status] ?? status.replaceAll("_", " ")}</span>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="rounded-[14px] border border-dashed border-[#d0d5dd] bg-[#fbfbfc] px-6 py-12 text-center"><p className="font-bold text-[#1a2233]">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#5b6472]">{description}</p></div>;
}
