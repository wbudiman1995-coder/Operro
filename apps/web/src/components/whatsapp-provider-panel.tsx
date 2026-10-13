"use client";

import Link from "next/link";
import { useActionState } from "react";

import { saveProviderSettingsAction, type ProviderActionState } from "@/app/settings/whatsapp-provider/actions";
import { PROVIDER_LABELS, PROVIDER_REQUIREMENTS, PROVIDERS, type ProviderState } from "@/lib/whatsapp-provider-settings";

const initial: ProviderActionState = { error: null, success: null };
const input = "mt-1 block h-9 w-full rounded-lg border border-slate-200 px-2 text-xs";
const label = "text-[11px] font-semibold text-slate-500";

/** Settings for the official provider boundary. Even when enabled, this release sends no messages. */
export function WhatsAppProviderPanel({ state, error }: { state: ProviderState | null; error: string | null }) {
  const [result, action, pending] = useActionState(saveProviderSettingsAction, initial);
  return (
    <div className="mt-6 space-y-6">
      <p role="note" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-5 text-amber-900">
        <strong>{state?.platformAvailable ? "Pengaturan dibuka, pengiriman belum ada." : "Belum dibuka platform."}</strong> Operro tidak mengirim pesan WhatsApp dan tidak menerima status pengiriman dari penyedia mana pun pada rilis ini. Halaman ini mencatat ID non-rahasia dan pernyataan persetujuan pelanggan sebagai persiapan. Status &ldquo;terkirim&rdquo; atau &ldquo;dibaca&rdquo; otomatis baru mungkin setelah penyedia resmi, kredensial, webhook, dan identitas layanan diputuskan. Sampai saat itu, draf tetap dibuka dan dilaporkan manual di <Link href="/whatsapp" className="font-bold underline">Pusat WhatsApp</Link>.
      </p>
      {error ? <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm font-semibold text-rose-700">{error}</p> : null}
      {state === null ? null : (
        <section aria-label="Pengaturan penyedia" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="font-bold">Persiapan penyedia resmi</h2>
          <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
            <div><dt className="font-semibold text-slate-500">Dibuka platform</dt><dd className="font-bold text-slate-900">{state.platformAvailable ? "Ya" : "Belum"}</dd></div>
            <div><dt className="font-semibold text-slate-500">Status penyedia</dt><dd className="font-bold text-slate-900">{state.enabled ? "Aktif" : "Nonaktif"}</dd></div>
            <div><dt className="font-semibold text-slate-500">Pernyataan persetujuan</dt><dd className="font-bold text-slate-900">{state.consentAttested ? `Dicatat ${state.consentAttestedAt?.slice(0, 10) ?? ""}` : "Belum dicatat"}</dd></div>
          </dl>
          <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Pengaturan penyedia WhatsApp">
            <input type="hidden" name="version" value={state.version} />
            <label className={label}>Penyedia
              <select name="provider" defaultValue={state.provider} className={input}>{PROVIDERS.map((key) => <option key={key} value={key}>{PROVIDER_LABELS[key]}</option>)}</select>
            </label>
            <label className={label}>ID nomor telepon (angka saja)<input name="phoneNumberId" defaultValue={state.phoneNumberId ?? ""} inputMode="numeric" pattern="[0-9]{5,20}" maxLength={20} className={input} /></label>
            <label className={label}>ID akun bisnis WhatsApp (angka saja)<input name="businessAccountId" defaultValue={state.businessAccountId ?? ""} inputMode="numeric" pattern="[0-9]{5,20}" maxLength={20} className={input} /></label>
            <label className="flex items-start gap-2 text-xs font-semibold text-slate-700 sm:col-span-2">
              <input type="checkbox" name="consentAttested" defaultChecked={state.consentAttested} className="mt-0.5" />
              <span>Saya menyatakan bahwa pelanggan yang akan dihubungi telah memberi persetujuan tertulis untuk menerima pesan WhatsApp dari bisnis ini dan dapat berhenti kapan saja. Pernyataan ini dicatat dengan tanggal dan nama saya.</span>
            </label>
            <label className={`flex items-start gap-2 text-xs sm:col-span-2 ${state.platformAvailable ? "text-slate-700" : "text-slate-400"}`}>
              <input type="checkbox" name="enabled" defaultChecked={state.enabled} disabled={!state.platformAvailable} aria-describedby="provider-enable-note" className="mt-0.5" />
              <span id="provider-enable-note">Aktifkan pengaturan penyedia. {state.platformAvailable ? "Ini hanya menyimpan kesiapan organisasi; Operro belum mengirim WhatsApp." : "Belum dapat dipilih: pemilik platform Operro belum membuka pengaturan resmi."}</span>
            </label>
            <div className="flex items-end"><button type="submit" disabled={pending} className="h-9 rounded-lg bg-emerald-700 px-3 text-xs font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Simpan persiapan"}</button></div>
            <p aria-live="polite" className="text-xs font-semibold sm:col-span-2">{result.error ? <span className="text-rose-700">{result.error}</span> : result.success ? <span className="text-emerald-700">{result.success}</span> : null}</p>
          </form>
        </section>
      )}
      <section aria-label="Syarat sebelum aktif" className="rounded-3xl border border-slate-200 bg-white p-5 text-xs leading-5 text-slate-600 shadow-sm sm:p-6">
        <h2 className="text-sm font-bold text-slate-900">Yang harus ada sebelum penyedia dapat diaktifkan</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">{PROVIDER_REQUIREMENTS.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
    </div>
  );
}
