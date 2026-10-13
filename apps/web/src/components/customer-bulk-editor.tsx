"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import { bulkUpdateCustomersAction, type BulkUpdateCustomersState } from "@/app/customers/actions";
import {
  BULK_SELECTION_LIMIT,
  allVisibleSelected,
  toggleAllVisible,
  toggleSelectedId,
  visibleSelectedIds,
} from "@/lib/customer-bulk-selection";
import type { CustomerWorkspace } from "@/lib/pilot-data";

type Customer = CustomerWorkspace["customers"][number];
type SortKey = "name" | "code" | "location" | "source" | "pets";

const initialState: BulkUpdateCustomersState = { error: null, success: null };
const defaultAddress = (customer: Customer) => customer.addresses.find((address) => address.isDefault) ?? customer.addresses[0];
const hasCoordinates = (customer: Customer) => customer.addresses.some((address) => address.latitude !== null && address.longitude !== null);
const whatsapp = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "62")}`;

export function CustomerBulkEditor({
  customers,
  canManage,
  sort,
  descending,
  onSort,
}: {
  customers: Customer[];
  canManage: boolean;
  sort: SortKey;
  descending: boolean;
  onSort: (key: SortKey) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("");
  const [sourceMode, setSourceMode] = useState<"unchanged" | "set" | "clear">("unchanged");
  const [source, setSource] = useState("");
  const [state, action, pending] = useActionState(async (previous: BulkUpdateCustomersState, formData: FormData) => {
    const result = await bulkUpdateCustomersAction(previous, formData);
    if (result.updated && result.updated > 0) setSelectedIds(new Set());
    return result;
  }, initialState);
  const visibleIds = useMemo(() => customers.map((customer) => customer.id), [customers]);
  const selectedVisible = useMemo(() => visibleSelectedIds(selectedIds, visibleIds), [selectedIds, visibleIds]);
  const allVisible = allVisibleSelected(selectedIds, visibleIds);
  const limitReached = selectedIds.size >= BULK_SELECTION_LIMIT;
  const hasChange = status !== "" || sourceMode === "clear" || (sourceMode === "set" && source.trim() !== "");

  const heading = (label: string, key: SortKey) => (
    <button type="button" onClick={() => onSort(key)} className="font-bold hover:text-emerald-700">
      {label} {sort === key ? (descending ? "↓" : "↑") : "↕"}
    </button>
  );

  return <>
    {canManage ? <form action={action} className="flex flex-wrap items-center gap-3 border-b bg-slate-50 p-4 text-xs">
      <input type="hidden" name="customerIds" value={JSON.stringify(selectedVisible)} />
      <span className="font-semibold text-slate-700">Edit massal</span>
      <span>{selectedVisible.length} terlihat dipilih{selectedIds.size > selectedVisible.length ? `, ${selectedIds.size - selectedVisible.length} tersembunyi` : ""}</span>
      {selectedVisible.length > 0 ? <button type="button" onClick={() => setSelectedIds((current) => toggleAllVisible(current, visibleIds, false))} className="h-9 rounded-lg border px-3 font-bold">Bersihkan pilihan terlihat</button> : null}
      <select name="status" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Ubah status pelanggan" className="h-9 rounded-lg border px-2">
        <option value="">Status: tidak berubah</option><option value="lead">Lead</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option>
      </select>
      <select name="sourceMode" value={sourceMode} onChange={(event) => setSourceMode(event.target.value as typeof sourceMode)} aria-label="Ubah sumber pelanggan" className="h-9 rounded-lg border px-2">
        <option value="unchanged">Sumber: tidak berubah</option><option value="set">Sumber: isi</option><option value="clear">Sumber: kosongkan</option>
      </select>
      {sourceMode === "set" ? <input name="source" list="source-label-suggestions" value={source} onChange={(event) => setSource(event.target.value)} maxLength={80} placeholder="Sumber akuisisi" aria-label="Sumber pelanggan" className="h-9 rounded-lg border px-2" /> : null}
      <button type="submit" disabled={pending || selectedVisible.length === 0 || !hasChange} className="h-9 rounded-lg bg-emerald-700 px-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">{pending ? "Menyimpan..." : "Terapkan"}</button>
      {state.error ? <span className="font-semibold text-rose-700">{state.error}</span> : null}
      {state.success ? <span className="font-semibold text-emerald-700">{state.success}</span> : null}
      {limitReached ? <span className="font-semibold text-amber-700">Batas {BULK_SELECTION_LIMIT} pelanggan tercapai.</span> : null}
    </form> : null}
    <table className="w-full min-w-[760px] text-left text-xs">
      <thead className="bg-slate-50 text-slate-600"><tr>
        {canManage ? <th className="p-3"><input type="checkbox" checked={allVisible} disabled={customers.length === 0} onChange={(event) => setSelectedIds((current) => toggleAllVisible(current, visibleIds, event.target.checked))} aria-label="Pilih semua pelanggan terlihat" /></th> : null}
        <th className="p-3">{heading("Kode", "code")}</th><th className="p-3">{heading("Pelanggan", "name")}</th><th className="p-3">WhatsApp</th><th className="p-3">{heading("Alamat / area", "location")}</th><th className="p-3">{heading("Sumber", "source")}</th><th className="p-3">{heading("Pet", "pets")}</th><th className="p-3">Profil</th>
      </tr></thead>
      <tbody>{customers.map((customer) => { const address = defaultAddress(customer); return <tr key={customer.id} className="border-t align-top">
        {canManage ? <td className="p-3"><input type="checkbox" checked={selectedIds.has(customer.id)} disabled={!selectedIds.has(customer.id) && limitReached} onChange={(event) => setSelectedIds((current) => toggleSelectedId(current, customer.id, event.target.checked))} aria-label={`Pilih ${customer.name}`} /></td> : null}
        <td className="p-3 font-mono">{customer.customerCode}</td><td className="p-3"><Link href={`/customers/${customer.id}`} className="font-bold text-emerald-800 hover:underline">{customer.name}</Link></td><td className="p-3">{customer.phone ? <a href={whatsapp(customer.phone)} target="_blank" rel="noreferrer" className="text-emerald-800 underline">{customer.phone}</a> : "—"}</td><td className="max-w-72 p-3">{address?.formattedLine ?? "Belum ada alamat"}{address && !hasCoordinates(customer) ? <span className="ml-2 font-semibold text-amber-700">Koordinat belum ada</span> : null}{address?.latitude !== null && address?.latitude !== undefined && address.longitude !== null ? <a href={`https://www.google.com/maps?q=${address.latitude},${address.longitude}`} target="_blank" rel="noreferrer" className="ml-2 text-emerald-800 underline">Peta</a> : null}</td><td className="p-3">{customer.source ?? "—"}</td><td className="p-3">{customer.pets.length}</td><td className="p-3"><Link href={`/customers/${customer.id}`} className="text-emerald-800 underline">Profil 360</Link></td>
      </tr>; })}</tbody>
    </table>
  </>;
}
