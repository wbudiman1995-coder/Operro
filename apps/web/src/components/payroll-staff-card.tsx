"use client";

import { useState } from "react";

import { PayrollActionForm } from "@/components/payroll-action-form";
import { formatRupiah } from "@/lib/pilot-data";
import type { PayrollBreakdown, PayrollCustomRow, PayrollOverride, PayrollStaffCard as PayrollStaffCardData } from "@/lib/payroll-data";
import {
  clearPayrollOverrideAction, deletePayrollCustomRowAction, payRetentionDepositAction,
  publishPayrollSnapshotAction, setPayrollOverrideAction, unpublishPayrollSnapshotAction,
  upsertPayrollCustomRowAction,
} from "@/app/payroll/payroll-actions";

const LINES: Array<[string, string]> = [
  ["basic", "Gaji pokok"], ["weekly", "Gaji mingguan"], ["noLate", "Bonus no-late"], ["noSick", "Bonus no-sakit"],
  ["styling", "Komisi styling"], ["botak", "Insentif Botak"], ["transport", "Transport fee ½"],
  ["perDog", "Basic Grooming per dog"], ["daily", "Uang harian"],
];

function ComponentRow({
  runId, membershipId, componentKey, label, computedValue, override, editable,
}: { runId: string; membershipId: string; componentKey: string; label: string; computedValue: number; override: PayrollOverride | undefined; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const displayValue = override ? override.amount : computedValue;
  return (
    <div className="border-b border-slate-100 py-1.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-600">
          {label}
          {override ? <span className="ml-1.5 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">OVERRIDE</span> : null}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold">{formatRupiah(displayValue)}</span>
          {editable ? <button type="button" onClick={() => setEditing((v) => !v)} className="text-[10px] font-bold text-sky-700">{editing ? "Tutup" : "Ubah"}</button> : null}
        </div>
      </div>
      {editing ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <PayrollActionForm action={setPayrollOverrideAction} hidden={{ runId, membershipId, component: componentKey }} buttonLabel="Simpan" className="flex items-center gap-1">
            <input name="amount" type="number" min={0} step={1000} defaultValue={displayValue} className="h-7 w-28 rounded border border-slate-300 px-1.5 text-xs" required />
            <input name="reason" placeholder="Alasan (opsional)" className="h-7 w-36 rounded border border-slate-300 px-1.5 text-xs" />
          </PayrollActionForm>
          {override ? (
            <PayrollActionForm action={clearPayrollOverrideAction} hidden={{ runId, membershipId, component: componentKey }} buttonLabel="Reset" buttonClassName="rounded border border-slate-300 px-2 py-1 text-[10px] font-bold" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CustomRows({ runId, membershipId, rows, editable }: { runId: string; membershipId: string; rows: PayrollCustomRow[]; editable: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="mt-2 border-t border-dashed border-slate-200 pt-2">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center justify-between gap-2 py-1">
          <span className="text-xs text-slate-600">{row.label || "Tambahan"}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold">{formatRupiah(row.amount)}</span>
            {editable ? (
              <PayrollActionForm action={deletePayrollCustomRowAction} hidden={{ runId, rowId: row.id }} buttonLabel="Hapus" buttonClassName="text-[10px] font-bold text-rose-700" />
            ) : null}
          </div>
        </div>
      ))}
      {editable ? (
        adding ? (
          <PayrollActionForm action={upsertPayrollCustomRowAction} hidden={{ runId, membershipId, rowId: "" }} buttonLabel="Tambah" pendingLabel="Menyimpan…" className="mt-1 flex flex-wrap items-center gap-2">
            <input name="label" placeholder="Nama (mis. Bonus event)" className="h-7 w-40 rounded border border-slate-300 px-1.5 text-xs" required />
            <input name="amount" type="number" min={0} step={1000} defaultValue={0} className="h-7 w-28 rounded border border-slate-300 px-1.5 text-xs" required />
          </PayrollActionForm>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="mt-1 text-[11px] font-bold text-sky-700">+ Tambahan pay</button>
        )
      ) : null}
    </div>
  );
}

export function PayrollStaffCard({ staff, runId, runStatus, canManage, canApprove }: {
  staff: PayrollStaffCardData; runId: string | null; runStatus: string | null; canManage: boolean; canApprove: boolean;
}) {
  const overrideByComponent = new Map(staff.overrides.map((o) => [o.componentKey, o]));
  const editable = canManage && runStatus === "draft" && Boolean(runId);
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold">{staff.name}</p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {staff.breakdown ? `${staff.breakdown.meta.basicCount} job basic · ${staff.breakdown.meta.stylingCount} styling · ${staff.breakdown.meta.botakCount} botak` : "Belum dihitung"}
          </p>
        </div>
        <p className="text-lg font-bold text-emerald-700">{formatRupiah(staff.grossPay)}</p>
      </div>

      {staff.breakdown ? (
        <div className="mt-3">
          {LINES.map(([key, label]) => (
            <ComponentRow key={key} runId={runId ?? ""} membershipId={staff.membershipId} componentKey={key} label={label} computedValue={(staff.breakdown as PayrollBreakdown)[key as keyof PayrollBreakdown] as number} override={overrideByComponent.get(key)} editable={editable} />
          ))}
          {staff.breakdown.meta.lateCount > 0 || staff.breakdown.meta.sickDays > 0 ? (
            <p className="mt-1 text-[11px] font-semibold text-amber-700">{staff.breakdown.meta.lateCount} keterlambatan · {staff.breakdown.meta.sickDays} hari sakit tercatat cycle ini</p>
          ) : null}
          {runId ? <CustomRows runId={runId} membershipId={staff.membershipId} rows={staff.customRows} editable={editable} /> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">Klik &ldquo;Hitung payroll&rdquo; untuk melihat rincian.</p>
      )}

      {staff.retentionEnabled ? (
        <div className="mt-3 rounded-xl border border-dashed border-slate-200 p-2.5">
          <p className="text-[11px] font-semibold text-slate-600">Deposit retensi{staff.retentionAlreadyPaid ? " — sudah dibayar" : staff.retentionEligible ? " — sudah jatuh tempo" : " — belum jatuh tempo"}</p>
          {canApprove && staff.retentionEligible && !staff.retentionAlreadyPaid ? (
            <PayrollActionForm action={payRetentionDepositAction} hidden={{ membershipId: staff.membershipId }} buttonLabel="Bayar deposit retensi" buttonClassName="mt-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50" confirmMessage={`Bayar deposit retensi untuk ${staff.name}? Ini adalah pembayaran lump-sum sekali seumur hidup staf.`} />
          ) : null}
        </div>
      ) : null}

      {canManage && runId && runStatus !== "draft" ? (
        <div className="mt-3 border-t border-slate-100 pt-2.5">
          {staff.published ? (
            <PayrollActionForm action={unpublishPayrollSnapshotAction} hidden={{ membershipId: staff.membershipId }} buttonLabel="Sembunyikan dari staf" buttonClassName="rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-bold" />
          ) : (
            <PayrollActionForm action={publishPayrollSnapshotAction} hidden={{ runId, membershipId: staff.membershipId }} buttonLabel="Publish ke staf" buttonClassName="rounded-lg bg-sky-700 px-3 py-1.5 text-[11px] font-bold text-white" />
          )}
          {staff.published ? <span className="ml-2 text-[10px] font-bold uppercase text-emerald-700">Dipublikasikan</span> : null}
        </div>
      ) : null}
    </article>
  );
}
