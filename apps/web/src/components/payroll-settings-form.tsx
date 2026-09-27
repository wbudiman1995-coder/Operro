"use client";

import { useState } from "react";

import { PayrollActionForm } from "@/components/payroll-action-form";
import { saveCycleSettingsAction, saveStaffSettingsAction } from "@/app/payroll/payroll-actions";
import type { PayrollCycleSettings, PayrollStaffCard as PayrollStaffCardData } from "@/lib/payroll-data";

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue: number }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-600">
      {label}
      <input name={name} type="number" min={0} step={1000} defaultValue={defaultValue} className="h-8 rounded-lg border border-slate-300 px-2 text-xs font-normal" />
    </label>
  );
}

export function PayrollCycleSettingsForm({ settings }: { settings: PayrollCycleSettings }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-bold text-slate-700">
        {open ? "Tutup pengaturan payroll" : "Pengaturan payroll (default organisasi)"}
      </button>
      {open ? (
        <PayrollActionForm action={saveCycleSettingsAction} buttonLabel="Simpan pengaturan" className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-600">
            Tanggal mulai cycle (1-28)
            <input name="cycleStartDay" type="number" min={1} max={28} defaultValue={settings.cycleStartDay} className="h-8 rounded-lg border border-slate-300 px-2 text-xs font-normal" />
          </label>
          <Field label="Gaji mingguan (Rp/minggu)" name="weeklySalaryAmountDefault" defaultValue={settings.weeklySalaryAmountDefault} />
          <Field label="Bonus no-late (Rp)" name="noLateAmountDefault" defaultValue={settings.noLateAmountDefault} />
          <Field label="Bonus no-sakit (Rp)" name="noSickAmountDefault" defaultValue={settings.noSickAmountDefault} />
          <Field label="Insentif Botak (Rp/job)" name="botakAmountDefault" defaultValue={settings.botakAmountDefault} />
          <Field label="Basic Grooming per dog (Rp)" name="perPetAmountDefault" defaultValue={settings.perPetAmountDefault} />
          <Field label="Uang harian (Rp/hari)" name="dailyAmountDefault" defaultValue={settings.dailyAmountDefault} />
          <Field label="Retensi (Rp/bulan)" name="retentionAmountPerMonthDefault" defaultValue={settings.retentionAmountPerMonthDefault} />
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-slate-600">
            Retensi jatuh tempo (bulan)
            <input name="retentionTermMonthsDefault" type="number" min={0} defaultValue={settings.retentionTermMonthsDefault} className="h-8 rounded-lg border border-slate-300 px-2 text-xs font-normal" />
          </label>
        </PayrollActionForm>
      ) : null}
    </div>
  );
}

function Toggle({ label, name, defaultChecked }: { label: string; name: string; defaultChecked: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-3.5" />
      {label}
    </label>
  );
}

export function StaffPayrollSettingsForm({ staff }: { staff: PayrollStaffCardData }) {
  const [open, setOpen] = useState(false);
  const overrideKeys = new Set(staff.overrides.map((o) => o.componentKey));
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[11px] font-bold text-slate-600">
        {open ? "Tutup komponen aktif" : "Komponen aktif untuk staf ini"}
      </button>
      {open ? (
        <PayrollActionForm action={saveStaffSettingsAction} hidden={{ membershipId: staff.membershipId }} buttonLabel="Simpan" buttonClassName="mt-2 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white" className="mt-2 grid gap-1.5 sm:grid-cols-2">
          <Toggle label="Gaji mingguan" name="weeklySalaryEnabled" defaultChecked={overrideKeys.has("weekly") || Boolean(staff.breakdown?.weekly)} />
          <Toggle label="Bonus no-late" name="noLateEnabled" defaultChecked={Boolean(staff.breakdown?.noLate)} />
          <Toggle label="Bonus no-sakit" name="noSickEnabled" defaultChecked={Boolean(staff.breakdown?.noSick)} />
          <Toggle label="Komisi styling (tier)" name="stylingEnabled" defaultChecked={Boolean(staff.breakdown?.styling)} />
          <Toggle label="Insentif Botak" name="botakEnabled" defaultChecked={true} />
          <Toggle label="Basic Grooming per dog" name="perPetEnabled" defaultChecked={true} />
          <Toggle label="Uang harian" name="dailyEnabled" defaultChecked={Boolean(staff.breakdown?.daily)} />
          <Toggle label="Deposit retensi" name="retentionEnabled" defaultChecked={staff.retentionEnabled} />
        </PayrollActionForm>
      ) : null}
    </div>
  );
}
