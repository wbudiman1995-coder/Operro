"use client";

import { useActionState } from "react";
import { importHomepawServicesAction, type PilotActionState } from "@/app/pilot-actions";
import { HOMEPAW_STARTER_SERVICES } from "@/lib/homepaw-starter";

const initialState: PilotActionState = { error: null, success: null };
const bands = ["XS", "S", "M", "L", "XL", "Cat"];

export function HomepawServiceStarter() {
  const [state, action, pending] = useActionState(importHomepawServicesAction, initialState);
  return <section className="mt-7 rounded-3xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:p-7">
    <h2 className="font-bold text-amber-950">Template layanan grooming rumah</h2>
    <p className="mt-1 text-sm text-amber-900">Harga dan durasi dari referensi Anda. XS &lt;5 kg, S 5–&lt;10 kg, M 10–&lt;15 kg, L 15–25 kg, XL &gt;25 kg. Kucing memakai kolom Cat. Impor hanya menambah nama layanan yang belum ada; harga lama dan booking lama tidak diubah.</p>
    <div className="mt-4 overflow-x-auto rounded-xl border border-amber-200 bg-white">
      <table className="min-w-[680px] w-full text-left text-xs"><thead className="bg-amber-100 text-amber-950"><tr><th className="p-2">Layanan</th>{bands.map(band=><th key={band} className="p-2">{band}<span className="block font-normal">Rp / menit</span></th>)}</tr></thead>
        <tbody>{HOMEPAW_STARTER_SERVICES.map(item=><tr key={item.name} className="border-t"><th className="p-2 font-semibold">{item.name}</th>{item.prices.map((price,index)=><td key={bands[index]} className="p-2">{new Intl.NumberFormat("id-ID").format(price)} / {item.durations[index]}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <form action={action} className="mt-4 flex flex-wrap items-center gap-3">
      <button disabled={pending} className="rounded-xl bg-amber-800 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{pending ? "Menambahkan…" : "Tambahkan layanan yang belum ada"}</button>
      {state.error || state.success ? <p role="status" className={`text-xs font-semibold ${state.error ? "text-rose-700" : "text-emerald-800"}`}>{state.error ?? state.success}</p> : null}
    </form>
  </section>;
}
