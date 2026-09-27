"use client";

import { useState } from "react";
import Link from "next/link";

import { buildWhatsAppUrl } from "@/components/customer-360";
import { buildFollowupMessage } from "@/lib/followup-messages";
import type { OverdueCustomerGroup } from "@/lib/followup-retention";

function urgencyBand(days: number, thresholdDays: number): { label: string; className: string } {
  const over = days - thresholdDays;
  if (over <= 6) return { label: "Jatuh tempo", className: "bg-amber-50 text-amber-700" };
  if (over <= 15) return { label: "Overdue", className: "bg-orange-50 text-orange-700" };
  return { label: "Sangat overdue", className: "bg-rose-50 text-rose-700" };
}

function MessageDraft({ text, phone, onClose }: { text: string; phone: string | null; onClose: () => void }) {
  const [value, setValue] = useState(text);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const waUrl = buildWhatsAppUrl(phone, value);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
      <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={4} className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs" />
      <p className="mt-1 text-[10px] text-slate-500">Perubahan di kotak ini hanya untuk pesan kali ini, bukan templat organisasi.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {waUrl ? (
          <a href={waUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white">Buka WhatsApp</a>
        ) : (
          <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-400" title="nomor tidak valid atau kosong">Nomor tidak valid</span>
        )}
        <button type="button" onClick={copy} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700">Salin teks</button>
        {copyState === "copied" ? <span className="text-[11px] font-semibold text-emerald-700">Disalin</span> : null}
        {copyState === "failed" ? <span className="text-[11px] font-semibold text-rose-700">Gagal menyalin -- pilih teks lalu salin manual</span> : null}
        <button type="button" onClick={onClose} className="ml-auto text-[11px] font-semibold text-slate-500">Tutup</button>
      </div>
      <p className="mt-2 text-[10px] text-slate-400">Membuka atau menyalin draft ini bukan bukti pesan sudah terkirim atau dibaca.</p>
    </div>
  );
}

export function OverdueQueueList({
  groups, thresholdDays, businessName, followupTemplate, hasFullBranchAccess,
}: { groups: OverdueCustomerGroup[]; thresholdDays: number; businessName: string; followupTemplate: string; hasFullBranchAccess: boolean }) {
  const neverGroomedLabel = hasFullBranchAccess ? "Belum pernah digroom" : "Tidak ada catatan grooming di cabang yang bisa Anda akses";
  const [openCustomer, setOpenCustomer] = useState<string | null>(null);

  if (groups.length === 0) {
    return <div className="p-6 text-sm text-slate-500">Tidak ada pelanggan yang cocok dengan filter ini.</div>;
  }

  return (
    <ul className="divide-y">
      {groups.map((group) => {
        const draftablePets = group.pets.filter((pet) => pet.daysSince !== null);
        const canDraft = draftablePets.length > 0;
        const draft = canDraft
          ? buildFollowupMessage(followupTemplate, {
              customerName: group.customerName, businessName,
              pets: draftablePets.map((pet) => ({ name: pet.petName, daysSince: pet.daysSince as number })),
            })
          : { text: null, blockedReason: "hewan pada pelanggan ini belum pernah digroom -- jumlah hari tidak dapat dihitung" };

        return (
          <li key={group.customerId} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/customers/${group.customerId}`} className="font-bold text-slate-900 hover:underline">{group.customerName}</Link>
                <p className="mt-0.5 text-xs text-slate-500">{group.phone ?? "Nomor belum diisi"}</p>
                <ul className="mt-2 space-y-1">
                  {group.pets.map((pet) => (
                    <li key={pet.petId} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-800">{pet.petName}</span>
                      {pet.daysSince !== null ? (
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${urgencyBand(pet.daysSince, thresholdDays).className}`}>
                          {urgencyBand(pet.daysSince, thresholdDays).label} · {pet.daysSince} hari
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{neverGroomedLabel}</span>
                      )}
                      {pet.hasUpcomingBooking ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">Ada booking mendatang</span> : null}
                      {pet.anomalyFutureDated ? <span className="rounded-full bg-fuchsia-50 px-2 py-0.5 text-[10px] font-bold text-fuchsia-700" title="Ada catatan servis bertanggal masa depan -- perlu ditinjau">Anomali tanggal</span> : null}
                    </li>
                  ))}
                  {group.petsTruncatedCount > 0 ? (
                    <li className="text-[11px] text-slate-400">+{group.petsTruncatedCount} hewan lain pada pelanggan ini tidak ditampilkan (lihat profil pelanggan).</li>
                  ) : null}
                </ul>
              </div>
              <button
                type="button" disabled={!canDraft}
                onClick={() => setOpenCustomer(openCustomer === group.customerId ? null : group.customerId)}
                title={canDraft ? undefined : draft.blockedReason ?? undefined}
                className="shrink-0 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 disabled:opacity-40"
              >
                {openCustomer === group.customerId ? "Tutup draft" : "Buat draft pesan"}
              </button>
            </div>
            {openCustomer === group.customerId ? (
              draft.text ? (
                <MessageDraft text={draft.text} phone={group.phone} onClose={() => setOpenCustomer(null)} />
              ) : (
                <p className="mt-3 text-xs font-semibold text-rose-700">{draft.blockedReason}</p>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
