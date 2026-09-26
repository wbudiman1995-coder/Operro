"use client";

import { useMemo, useState } from "react";

import { MembershipManager } from "@/components/membership-manager";
import type { MembershipPackageRow, MembershipUrgency } from "@/lib/membership-admin";

const URGENCY_OPTIONS: Array<{ value: MembershipUrgency | "all"; label: string }> = [
  { value: "all", label: "Semua" }, { value: "urgent", label: "Segera berakhir" }, { value: "expired", label: "Kedaluwarsa" },
  { value: "normal", label: "Normal" }, { value: "canceled", label: "Diarsipkan" },
];

/** Section 25: status/urgency filters over the membership administration list. */
export function MembershipFilterList({ rows, canManage, branches, services }: { rows: MembershipPackageRow[]; canManage: boolean; branches: Array<{ id: string; name: string }>; services: Array<{ id: string; name: string }> }) {
  const [urgency, setUrgency] = useState<MembershipUrgency | "all">("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => rows.filter((row) => {
    if (urgency !== "all" && row.urgency !== urgency) return false;
    if (search && !`${row.customerName} ${row.petName ?? ""} ${row.packageName}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [rows, urgency, search]);

  return <div>
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-5">
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari pelanggan, hewan, atau paket" className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10" />
      <div className="flex flex-wrap gap-1">
        {URGENCY_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => setUrgency(option.value)} className={`rounded-full px-3 py-1.5 text-xs font-bold ${urgency === option.value ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>{option.label}</button>)}
      </div>
    </div>
    {filtered.length === 0 ? <p className="p-5 text-sm text-slate-500">Tidak ada paket yang cocok dengan filter ini.</p> : <div className="divide-y">{filtered.map((row) => <MembershipManager key={`${row.id}-${row.revision}-${row.renewalCount}-${row.expiresAt ?? ""}-${row.petId ?? ""}-${row.serviceId ?? ""}`} row={row} canManage={canManage} branches={branches} services={services} />)}</div>}
  </div>;
}
