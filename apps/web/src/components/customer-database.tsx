"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CustomerWorkspace } from "@/lib/pilot-data";

type Customer = CustomerWorkspace["customers"][number];
type SortKey = "name" | "code" | "location" | "source" | "pets";

const customerCode = (id: string) => `CUS-${id.slice(0, 8).toUpperCase()}`;
const defaultAddress = (customer: Customer) => customer.addresses.find((address) => address.isDefault) ?? customer.addresses[0];
const hasCoordinates = (customer: Customer) => customer.addresses.some((address) => address.latitude !== null && address.longitude !== null);
const whatsapp = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "").replace(/^0/, "62")}`;

export function CustomerDatabase({ customers }: { customers: CustomerWorkspace["customers"] }) {
  const [tab, setTab] = useState<"customers" | "pets">("customers");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [missingCoordinates, setMissingCoordinates] = useState(false);
  const [sort, setSort] = useState<SortKey>("name");
  const [descending, setDescending] = useState(false);
  const sources = useMemo(() => [...new Set(customers.map((customer) => customer.source).filter((value): value is string => Boolean(value)))].sort(), [customers]);
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("id-ID");
    return customers.filter((customer) => {
      if (source === "__none__" ? Boolean(customer.source) : source && customer.source !== source) return false;
      if (missingCoordinates && hasCoordinates(customer)) return false;
      if (!needle) return true;
      const address = defaultAddress(customer)?.formattedLine ?? "";
      return [customer.name, customer.phone, customerCode(customer.id), customer.source, address, ...customer.pets.map((pet) => pet.name)].join(" ").toLocaleLowerCase("id-ID").includes(needle);
    }).sort((a, b) => {
      const value = (row: Customer) => sort === "code" ? customerCode(row.id) : sort === "location" ? defaultAddress(row)?.formattedLine ?? "" : sort === "source" ? row.source ?? "" : sort === "pets" ? row.pets.length : row.name;
      const av = value(a), bv = value(b);
      const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "id-ID");
      return comparison * (descending ? -1 : 1);
    });
  }, [customers, query, source, missingCoordinates, sort, descending]);
  const missingCount = customers.filter((customer) => !hasCoordinates(customer)).length;
  const petRows = matching.flatMap((customer) => customer.pets.map((pet) => ({ customer, pet })));
  const sortBy = (key: SortKey) => { if (sort === key) setDescending((previous) => !previous); else { setSort(key); setDescending(false); } };
  const heading = (label: string, key: SortKey) => <button type="button" onClick={() => sortBy(key)} className="font-bold hover:text-emerald-700">{label} {sort === key ? descending ? "↓" : "↑" : "↕"}</button>;
  return <section className="mt-7 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b p-5"><div><h2 className="font-bold">Database pelanggan</h2><p className="mt-1 text-xs text-slate-500">Cari, urutkan, tinjau hewan dan alamat, lalu buka profil 360. {customers.length - missingCount}/{customers.length} pelanggan memiliki koordinat.</p></div><div className="flex flex-wrap gap-2"><Link prefetch={false} href="/customers/export?format=xlsx" className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-800">Export pelanggan & pet</Link><Link prefetch={false} href="/customers/export?format=all" className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-bold text-emerald-800">Export semua (8 sheet)</Link><Link href="/customers/onboarding" className="rounded-lg border px-3 py-2 text-xs font-bold">Pendaftaran masuk</Link></div></div>
    <div className="flex flex-wrap gap-2 border-b p-4 text-xs"><button type="button" onClick={() => setTab("customers")} className={`rounded-lg px-3 py-2 font-bold ${tab === "customers" ? "bg-emerald-700 text-white" : "border"}`}>Pelanggan ({matching.length})</button><button type="button" onClick={() => setTab("pets")} className={`rounded-lg px-3 py-2 font-bold ${tab === "pets" ? "bg-emerald-700 text-white" : "border"}`}>Pet ({petRows.length})</button></div>
    <div className="flex flex-wrap items-center gap-3 p-4"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama, WA, area, alamat, kode, atau pet…" aria-label="Cari database pelanggan" className="h-10 min-w-56 flex-1 rounded-lg border px-3 text-sm" /><select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Filter sumber pelanggan" className="h-10 rounded-lg border px-2 text-xs"><option value="">Semua sumber</option>{sources.map((item) => <option key={item} value={item}>{item}</option>)}<option value="__none__">Belum diisi</option></select><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={missingCoordinates} onChange={(event) => setMissingCoordinates(event.target.checked)} />Belum ada koordinat ({missingCount})</label></div>
    <div className="overflow-x-auto">{tab === "customers" ? <table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">{heading("Kode", "code")}</th><th className="p-3">{heading("Pelanggan", "name")}</th><th className="p-3">WhatsApp</th><th className="p-3">{heading("Alamat / area", "location")}</th><th className="p-3">{heading("Sumber", "source")}</th><th className="p-3">{heading("Pet", "pets")}</th><th className="p-3">Profil</th></tr></thead><tbody>{matching.map((customer) => { const address = defaultAddress(customer); return <tr key={customer.id} className="border-t align-top"><td className="p-3 font-mono">{customerCode(customer.id)}</td><td className="p-3"><Link href={`/customers/${customer.id}`} className="font-bold text-emerald-800 hover:underline">{customer.name}</Link></td><td className="p-3">{customer.phone ? <a href={whatsapp(customer.phone)} target="_blank" rel="noreferrer" className="text-emerald-800 underline">{customer.phone}</a> : "—"}</td><td className="max-w-72 p-3">{address?.formattedLine ?? "Belum ada alamat"}{address && !hasCoordinates(customer) ? <span className="ml-2 font-semibold text-amber-700">Koordinat belum ada</span> : null}{address?.latitude !== null && address?.latitude !== undefined && address.longitude !== null ? <a href={`https://www.google.com/maps?q=${address.latitude},${address.longitude}`} target="_blank" rel="noreferrer" className="ml-2 text-emerald-800 underline">Peta</a> : null}</td><td className="p-3">{customer.source ?? "—"}</td><td className="p-3">{customer.pets.length}</td><td className="p-3"><Link href={`/customers/${customer.id}`} className="text-emerald-800 underline">Profil 360</Link></td></tr>; })}</tbody></table> : <table className="w-full min-w-[600px] text-left text-xs"><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">Pet</th><th className="p-3">Jenis</th><th className="p-3">Ras</th><th className="p-3">Pemilik</th><th className="p-3">Alamat</th></tr></thead><tbody>{petRows.map(({ customer, pet }) => <tr key={pet.id} className="border-t"><td className="p-3 font-bold">{pet.name}</td><td className="p-3">{pet.species}</td><td className="p-3">{pet.breed ?? "—"}</td><td className="p-3"><Link href={`/customers/${customer.id}`} className="text-emerald-800 underline">{customer.name}</Link></td><td className="p-3">{defaultAddress(customer)?.formattedLine ?? "—"}</td></tr>)}</tbody></table>}{(tab === "customers" ? matching.length : petRows.length) === 0 ? <p className="p-5 text-sm text-slate-500">Tidak ada hasil. Ubah pencarian atau filter.</p> : null}</div>
  </section>;
}
