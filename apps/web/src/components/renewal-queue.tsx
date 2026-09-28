"use client";

import { useState, useTransition } from "react";
import Link from "next/link";

import { previewPackageRenewalAction, type PackageRenewalPreview } from "@/app/pilot-actions";
import { buildWhatsAppUrl } from "@/components/customer-360";
import { buildRenewalMessage } from "@/lib/followup-messages";
import type { RenewalCustomerGroup, RenewalMembership } from "@/lib/followup-retention";

function Badge({ label, className }: { label: string; className: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${className}`}>{label}</span>;
}

function membershipBadges(m: RenewalMembership) {
  const badges: Array<{ label: string; className: string }> = [];
  if (!m.isRecurring) badges.push({ label: "Token sekali pakai", className: "bg-slate-100 text-slate-600" });
  if (m.status === "canceled") badges.push({ label: "Diarsipkan", className: "bg-slate-100 text-slate-500" });
  if (m.isExpired) badges.push({ label: "Kedaluwarsa", className: "bg-rose-50 text-rose-700" });
  else if (m.isExpiringSoon) badges.push({ label: "Segera berakhir", className: "bg-amber-50 text-amber-700" });
  if (m.noAvailableSessions) badges.push({ label: "Sesi habis (terpakai)", className: "bg-rose-50 text-rose-700" });
  else if (m.allReserved) badges.push({ label: "Semua sesi dipesan", className: "bg-orange-50 text-orange-700" });
  else if (m.oneAvailable) badges.push({ label: "Sisa 1 sesi", className: "bg-amber-50 text-amber-700" });
  return badges;
}

type PreviewState = { status: "loading" } | { status: "ok"; preview: PackageRenewalPreview } | { status: "error"; message: string };

function DraftPanel({
  group, selected, previews, businessName, renewalTemplate, onClose,
}: {
  group: RenewalCustomerGroup; selected: RenewalMembership[]; previews: Map<string, PreviewState>;
  businessName: string; renewalTemplate: string; onClose: () => void;
}) {
  // Derived, not effect-driven: `value` is the auto-built draft unless the user has typed a
  // manual edit (manualEdit), which always wins so a later preview resolving never clobbers
  // an in-progress edit. No useEffect needed -- this is a pure function of props/state.
  const [manualEdit, setManualEdit] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const resolved = selected.map((m) => ({ membership: m, state: previews.get(m.id) }));
  const pending = resolved.some((r) => !r.state || r.state.status === "loading");
  const errored = resolved.filter((r) => r.state?.status === "error");
  const oks = resolved.filter((r): r is { membership: RenewalMembership; state: { status: "ok"; preview: PackageRenewalPreview } } => r.state?.status === "ok");

  const currencies = new Set(oks.map((r) => r.state.preview.currency));
  const canCombine = errored.length === 0 && !pending && currencies.size <= 1 && oks.length === selected.length;

  const computedDraft = canCombine
    ? buildRenewalMessage(renewalTemplate, {
        customerName: group.customerName,
        petLabel: selected.map((m) => m.petName).some((n) => !n) ? null : selected.map((m) => m.petName).join(", "),
        tierName: selected.map((m) => m.packageName).join(", "), businessName,
        amount: oks.reduce((sum, r) => sum + r.state.preview.price, 0), currency: [...currencies][0] ?? "IDR", amountBlockedReason: null,
      }).text
    : null;
  const value = manualEdit ?? computedDraft;

  const waUrl = value ? buildWhatsAppUrl(group.phone, value) : null;

  async function copy() {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setCopyState("copied"); } catch { setCopyState("failed"); }
  }

  return (
    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 text-xs">
      {pending ? <p className="text-slate-500">Memuat pratinjau perpanjangan…</p> : null}
      {errored.length > 0 ? (
        <div className="rounded-lg bg-rose-50 p-2 text-rose-700">
          <p className="font-semibold">Beberapa paket terpilih tidak dapat diperpanjang -- batal pilih agar total tetap akurat:</p>
          <ul className="mt-1 list-disc pl-4">
            {errored.map((r) => <li key={r.membership.id}>{r.membership.packageName} ({r.membership.petName ?? "semua hewan"}): {r.state && r.state.status === "error" ? r.state.message : ""}</li>)}
          </ul>
        </div>
      ) : null}
      {!pending && errored.length === 0 && currencies.size > 1 ? (
        <p className="font-semibold text-rose-700">Paket terpilih memakai mata uang berbeda -- tidak dapat digabung menjadi satu total. Pilih paket dengan mata uang yang sama.</p>
      ) : null}
      {value ? (
        <>
          <textarea value={value} onChange={(event) => setManualEdit(event.target.value)} rows={4} className="block w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs" />
          <p className="mt-1 text-[10px] text-slate-500">Estimasi, bukan invoice -- perpanjangan tetap harus dikonfirmasi melalui alur perpanjangan resmi.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {waUrl ? <a href={waUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white">Buka WhatsApp</a>
              : <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-[11px] font-bold text-slate-400">Nomor tidak valid</span>}
            <button type="button" onClick={copy} className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-700">Salin teks</button>
            {copyState === "copied" ? <span className="text-[11px] font-semibold text-emerald-700">Disalin</span> : null}
            {copyState === "failed" ? <span className="text-[11px] font-semibold text-rose-700">Gagal menyalin -- pilih teks lalu salin manual</span> : null}
          </div>
        </>
      ) : null}
      <button type="button" onClick={onClose} className="mt-2 text-[11px] font-semibold text-slate-500">Tutup</button>
    </div>
  );
}

export function RenewalQueueList({
  groups, businessName, renewalTemplate, returnTo,
}: { groups: RenewalCustomerGroup[]; businessName: string; renewalTemplate: string; returnTo: string }) {
  const [selectedByCustomer, setSelectedByCustomer] = useState<Map<string, Set<string>>>(new Map());
  const [previewsByCustomer, setPreviewsByCustomer] = useState<Map<string, Map<string, PreviewState>>>(new Map());
  const [draftOpenFor, setDraftOpenFor] = useState<string | null>(null);
  const [, startPreviewLoad] = useTransition();

  function toggle(customerId: string, membershipId: string) {
    setSelectedByCustomer((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(customerId) ?? []);
      if (set.has(membershipId)) set.delete(membershipId); else set.add(membershipId);
      next.set(customerId, set);
      return next;
    });
  }

  function openDraft(group: RenewalCustomerGroup) {
    const selected = [...(selectedByCustomer.get(group.customerId) ?? [])];
    if (selected.length === 0) return;
    setDraftOpenFor(group.customerId);
    setPreviewsByCustomer((prev) => {
      const next = new Map(prev);
      const map = new Map(next.get(group.customerId) ?? []);
      for (const id of selected) map.set(id, { status: "loading" });
      next.set(group.customerId, map);
      return next;
    });
    startPreviewLoad(async () => {
      const results = await Promise.all(selected.map(async (id) => {
        const result = await previewPackageRenewalAction(id);
        return [id, result] as const;
      }));
      setPreviewsByCustomer((prev) => {
        const next = new Map(prev);
        const map = new Map(next.get(group.customerId) ?? []);
        for (const [id, result] of results) {
          if (result.error || !result.preview) {
            map.set(id, { status: "error", message: result.error ?? "gagal memuat pratinjau" });
          } else if (result.preview.blockingReason) {
            map.set(id, { status: "error", message: result.preview.blockingReason });
          } else {
            map.set(id, { status: "ok", preview: result.preview });
          }
        }
        next.set(group.customerId, map);
        return next;
      });
    });
  }

  if (groups.length === 0) {
    return <div className="p-6 text-sm text-slate-500">Tidak ada membership yang cocok dengan filter ini.</div>;
  }

  return (
    <ul className="divide-y">
      {groups.map((group) => {
        const selected = [...(selectedByCustomer.get(group.customerId) ?? [])];
        const selectedMemberships = group.memberships.filter((m) => selected.includes(m.id));
        const previews = previewsByCustomer.get(group.customerId) ?? new Map();
        return (
          <li key={group.customerId} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/customers/${group.customerId}`} className="font-bold text-slate-900 hover:underline">{group.customerName}</Link>
                <p className="mt-0.5 text-xs text-slate-500">{group.phone ?? "Nomor belum diisi"}</p>
              </div>
              <button
                type="button" disabled={selected.length === 0}
                onClick={() => openDraft(group)}
                className="shrink-0 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 disabled:opacity-40"
              >
                Muat pratinjau &amp; buat draft ({selected.length})
              </button>
            </div>
            <ul className="mt-3 space-y-2">
              {group.memberships.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 p-2 text-xs">
                  <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(group.customerId, m.id)} className="h-4 w-4" />
                  <span className="font-semibold text-slate-800">{m.packageName}</span>
                  <span className="text-slate-400">{m.petName ?? "semua hewan"}{m.serviceName ? ` · ${m.serviceName}` : ""}</span>
                  <span className="text-slate-400">{m.availableCount} tersedia{m.reservedCount > 0 ? ` (${m.reservedCount} dipesan)` : ""} · {m.consumedCount} terpakai</span>
                  {membershipBadges(m).map((b) => <Badge key={b.label} {...b} />)}
                  <Link
                    href={`/programs/memberships?membershipId=${m.id}&return=${encodeURIComponent(returnTo)}`}
                    className="ml-auto rounded-lg border border-emerald-200 px-2 py-1 text-[11px] font-bold text-emerald-700"
                  >
                    Perpanjang / kelola
                  </Link>
                </li>
              ))}
            </ul>
            {draftOpenFor === group.customerId && selectedMemberships.length > 0 ? (
              <DraftPanel
                group={group} selected={selectedMemberships} previews={previews}
                businessName={businessName} renewalTemplate={renewalTemplate}
                onClose={() => setDraftOpenFor(null)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
