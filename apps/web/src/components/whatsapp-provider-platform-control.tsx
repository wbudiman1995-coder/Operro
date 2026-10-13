"use client";

import { useActionState } from "react";

import { setWhatsAppProviderPlatformGateAction, type AccessState } from "@/app/platform/actions";

export interface WhatsAppProviderPlatformGate { enabled: boolean; note: string | null; updatedAt: string | null }

const initial: AccessState = { error: null, success: null };

/** Platform-wide safety gate. It permits setup only; no code sends WhatsApp messages. */
export function WhatsAppProviderPlatformControl({ gate, error }: { gate: WhatsAppProviderPlatformGate | null; error: string | null }) {
  const [result, action, pending] = useActionState(setWhatsAppProviderPlatformGateAction, initial);
  return <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-labelledby="whatsapp-platform-title">
    <h2 id="whatsapp-platform-title" className="font-bold">Saklar penyedia WhatsApp resmi</h2>
    <p className="mt-1 text-xs leading-5 text-amber-950">Saklar ini hanya mengizinkan pemilik bisnis menyelesaikan pengaturan penyedia dan memilih “aktif”. Operro tetap <strong>tidak mengirim pesan</strong>, tidak menyimpan token, dan tidak menerima status terkirim/dibaca sampai integrasi resmi dibangun dan dikonfigurasi.</p>
    {error ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{error}</p> : null}
    {gate ? <form action={action} className="mt-3 flex flex-wrap items-center gap-3">
      <p className="text-xs"><strong>Status:</strong> {gate.enabled ? "Pengaturan resmi dibuka" : "Ditutup — draf manual tetap tersedia"}</p>
      <input type="hidden" name="enabled" value={gate.enabled ? "false" : "true"} />
      <button type="submit" disabled={pending} className={`rounded-lg px-3 py-2 text-xs font-bold text-white disabled:opacity-60 ${gate.enabled ? "bg-rose-700" : "bg-emerald-700"}`}>{pending ? "Menyimpan…" : gate.enabled ? "Tutup pengaturan resmi" : "Buka pengaturan resmi"}</button>
      {gate.note ? <p className="w-full text-[11px] text-amber-900">{gate.note}</p> : null}
      <p aria-live="polite" className="w-full text-xs font-semibold">{result.error ? <span className="text-rose-700">{result.error}</span> : result.success ? <span className="text-emerald-800">{result.success}</span> : null}</p>
    </form> : null}
  </section>;
}
