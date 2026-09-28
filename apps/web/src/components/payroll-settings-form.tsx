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

type Tier = { min_jobs: number; pct: number };

/** Editable list of {min_jobs, pct} retroactive styling-tier rows. Submits as a single hidden
 *  JSON field so it saves together with the rest of whichever PayrollActionForm it's nested
 *  in -- there is no separate save action for tiers, per the existing settings-form pattern. */
function StylingTiersEditor({ name, initialTiers, hint }: { name: string; initialTiers: Tier[]; hint: string }) {
  const [tiers, setTiers] = useState<Tier[]>(initialTiers.length > 0 ? initialTiers : []);

  function updateRow(index: number, patch: Partial<Tier>) {
    setTiers((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="sm:col-span-3">
      <p className="text-[11px] font-semibold text-slate-600">Tier komisi styling (retroaktif)</p>
      <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>
      <div className="mt-1.5 space-y-1.5">
        {tiers.map((tier, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-500">Mulai job ke-</span>
            <input type="number" min={1} step={1} value={tier.min_jobs}
              onChange={(e) => updateRow(i, { min_jobs: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              className="h-7 w-16 rounded border border-slate-300 px-1.5 text-xs" />
            <span className="text-[10px] text-slate-500">→</span>
            <input type="number" min={0} step={0.5} value={tier.pct}
              onChange={(e) => updateRow(i, { pct: Math.max(0, Number(e.target.value) || 0) })}
              className="h-7 w-16 rounded border border-slate-300 px-1.5 text-xs" />
            <span className="text-[10px] text-slate-500">%</span>
            <button type="button" onClick={() => setTiers((rows) => rows.filter((_, ix) => ix !== i))} className="text-[10px] font-bold text-rose-700">Hapus</button>
          </div>
        ))}
        {tiers.length === 0 ? <p className="text-[10px] text-slate-400">Belum ada tier -- akan mewarisi default di atas ini.</p> : null}
      </div>
      <button type="button" onClick={() => setTiers((rows) => [...rows, { min_jobs: rows.length ? Math.max(...rows.map((r) => r.min_jobs)) + 1 : 1, pct: 0 }])} className="mt-1.5 text-[11px] font-bold text-sky-700">
        + Tambah tier
      </button>
      <input type="hidden" name={name} value={JSON.stringify(tiers)} />
    </div>
  );
}

const SIZE_LABELS: Array<[string, string]> = [["small", "Kecil"], ["medium", "Sedang"], ["large", "Besar"], ["extra_large", "Extra besar"]];

/** Editable per-pet-size Basic Grooming rate matrix. Blank fields are omitted from the
 *  submitted JSON (not sent as 0) so the save action can tell "not configured" apart from
 *  "deliberately set to zero". */
function SizeMatrixEditor({ name, initial, hint }: { name: string; initial: Record<string, number>; hint: string }) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(SIZE_LABELS.map(([key]) => [key, initial[key] != null ? String(initial[key]) : ""])),
  );
  const serialized = JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)])));

  return (
    <div className="sm:col-span-3">
      <p className="text-[11px] font-semibold text-slate-600">Matriks Basic Grooming per ukuran hewan</p>
      <p className="mt-0.5 text-[10px] text-slate-400">{hint}</p>
      <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {SIZE_LABELS.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1 text-[10px] text-slate-500">
            {label}
            <input type="number" min={0} step={1000} value={values[key]} placeholder="mewarisi"
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              className="h-7 rounded border border-slate-300 px-1.5 text-xs" />
          </label>
        ))}
      </div>
      <input type="hidden" name={name} value={serialized} />
    </div>
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
          <StylingTiersEditor name="stylingTiersJson" initialTiers={settings.stylingTiersDefault} hint="Job styling ke-N memakai tier dengan “mulai job” terbesar yang masih ≤ jumlah job styling groomer pada cycle ini. Berlaku retroaktif ke seluruh revenue styling cycle tersebut, bukan bertingkat." />
          <SizeMatrixEditor name="perPetSizeMatrixJson" initial={settings.perPetSizeMatrixDefault} hint="Kosong = pakai nominal flat Basic Grooming per dog di atas untuk ukuran itu." />
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
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[11px] font-bold text-slate-600">
        {open ? "Tutup komponen aktif" : "Komponen aktif untuk staf ini"}
      </button>
      {open ? (
        <PayrollActionForm action={saveStaffSettingsAction} hidden={{ membershipId: staff.membershipId }} buttonLabel="Simpan" buttonClassName="mt-2 rounded-lg bg-slate-900 px-3 py-1.5 text-[11px] font-bold text-white" className="mt-2 grid gap-1.5 sm:grid-cols-2">
          <Toggle label="Gaji mingguan" name="weeklySalaryEnabled" defaultChecked={staff.componentEnabled.weekly} />
          <Toggle label="Bonus no-late" name="noLateEnabled" defaultChecked={staff.componentEnabled.noLate} />
          <Toggle label="Bonus no-sakit" name="noSickEnabled" defaultChecked={staff.componentEnabled.noSick} />
          <Toggle label="Komisi styling (tier)" name="stylingEnabled" defaultChecked={staff.componentEnabled.styling} />
          <Toggle label="Insentif Botak" name="botakEnabled" defaultChecked={staff.componentEnabled.botak} />
          <Toggle label="Basic Grooming per dog" name="perPetEnabled" defaultChecked={staff.componentEnabled.perPet} />
          <Toggle label="Uang harian" name="dailyEnabled" defaultChecked={staff.componentEnabled.daily} />
          <Toggle label="Deposit retensi" name="retentionEnabled" defaultChecked={staff.retentionEnabled} />
          <StylingTiersEditor name="stylingTiersJson" initialTiers={staff.stylingTiers ?? []} hint="Kosong = pakai tier default organisasi. Isi untuk override tier khusus groomer ini." />
          <SizeMatrixEditor name="perPetSizeMatrixJson" initial={staff.perPetSizeMatrix ?? {}} hint="Kosong semua = pakai matriks/rate default organisasi. Isi salah satu ukuran akan menggantikan SELURUH matriks default untuk groomer ini." />
        </PayrollActionForm>
      ) : null}
    </div>
  );
}
