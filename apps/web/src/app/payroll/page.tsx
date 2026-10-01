/**
 * Payroll route (sections 32-33). Configurable cycle (org-wide, business-timezone-safe
 * bounds from app.payroll_cycle_bounds), per-groomer component breakdown with draft
 * overrides/custom rows, approve/pay/undo lifecycle, retention deposits, and
 * publish/hide to the staff's own page. Attendance exceptions stay visible alongside
 * compensation so payroll review can resolve late/missing-photo records before approval.
 */
import Link from "next/link";

import { PayrollActionForm } from "@/components/payroll-action-form";
import { PayrollCycleSettingsForm, StaffPayrollSettingsForm } from "@/components/payroll-settings-form";
import { PayrollStaffCard } from "@/components/payroll-staff-card";
import { EmptyState, PageHeader, StatCard } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah } from "@/lib/pilot-data";
import { loadPayrollWorkspace } from "@/lib/payroll-data";
import { recomputePayrollAction, approvePayrollAction, payPayrollAction, undoPayrollPaymentAction } from "@/app/payroll/payroll-actions";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Payroll" };

const RUN_STATUS_LABEL: Record<string, string> = { draft: "Draft", approved: "Disetujui", paid: "Lunas" };

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ anchor?: string }> }) {
  const workspace = await requireActiveWorkspace();
  const header = <PageHeader eyebrow="Payroll" title="Payroll" description="Konfigurasi cycle, komponen gaji per groomer, dan siklus persetujuan/pembayaran." />;
  if (!workspace.capabilities["payroll.read"]) {
    return <WorkspaceShell {...workspace} activePath="/payroll">{header}<div className="mt-7"><RestrictedNotice title="Tidak ada izin payroll" description="Peran ini memerlukan payroll.read." /></div></WorkspaceShell>;
  }
  const params = await searchParams;
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(params.anchor ?? "") ? params.anchor! : null;
  const [data, bandsResult] = await Promise.all([
    loadPayrollWorkspace(workspace.supabase, workspace.activeOrganization.id, anchor),
    workspace.supabase.from("organization_dog_size_bands").select("key,label").eq("organization_id", workspace.activeOrganization.id).order("sort_order"),
  ]);
  const dogSizeBands = bandsResult.data ?? [];
  const canManage = workspace.capabilities["payroll.manage"];
  const canApprove = workspace.capabilities["payroll.approve"];
  const run = data.run;
  const runId = run?.id ?? null;

  return <WorkspaceShell {...workspace} activePath="/payroll">{header}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Link href={`/payroll?anchor=${data.previousAnchor}`} className="rounded-lg border px-3 py-2 text-xs font-bold">← Cycle sebelumnya</Link>
        <span className="px-2 text-sm font-bold">{data.label}</span>
        <Link href={`/payroll?anchor=${data.nextAnchor}`} className="rounded-lg border px-3 py-2 text-xs font-bold">Cycle berikutnya →</Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/attendance?month=${data.periodStart.slice(0, 7)}`} className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm font-bold text-sky-800">Periksa kehadiran</Link>
        {workspace.capabilities["payroll.read"] ? (
          <>
            <a href={`/payroll/export?format=xlsx&anchor=${data.periodStart}`} className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-800">Export Excel</a>
            <a href={`/payroll/export?format=csv&anchor=${data.periodStart}`} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700">Export CSV</a>
          </>
        ) : null}
        {canManage && (!run || run.status === "draft") ? (
          <PayrollActionForm action={recomputePayrollAction} hidden={{ periodStart: data.periodStart, periodEnd: data.periodEnd }} buttonLabel={run ? "Hitung ulang" : "Hitung payroll"} pendingLabel="Menghitung…" buttonClassName="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" />
        ) : null}
        {canApprove && run?.status === "draft" ? (
          <PayrollActionForm action={approvePayrollAction} hidden={{ runId: run.id }} buttonLabel="Setujui" pendingLabel="Menyetujui…" buttonClassName="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" />
        ) : null}
        {canApprove && run?.status === "approved" ? (
          <PayrollActionForm action={payPayrollAction} hidden={{ runId: run.id }} buttonLabel="Tandai sudah dibayar" pendingLabel="Menyimpan…" buttonClassName="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" />
        ) : null}
      </div>
    </div>

    <div className="mt-5 grid gap-4 sm:grid-cols-3">
      <StatCard label="Staf aktif" value={String(data.staff.length)} helper="Dengan konfigurasi gaji." />
      <StatCard label="Total payroll" value={formatRupiah(run?.totalGross ?? data.staff.reduce((sum, s) => sum + s.grossPay, 0))} helper="Cycle berjalan." tone="success" />
      <StatCard label="Status cycle" value={run ? RUN_STATUS_LABEL[run.status] ?? run.status : "Belum dihitung"} helper={run?.status === "paid" || run?.status === "approved" ? `Total tersimpan: ${formatRupiah(run.totalGross)}` : "Klik hitung untuk membuat draft."} />
    </div>

    {run?.status === "paid" && canApprove ? (
      <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <PayrollActionForm
          action={undoPayrollPaymentAction} hidden={{ runId: run.id }}
          buttonLabel="Undo pembayaran (koreksi)" pendingLabel="Membatalkan…"
          buttonClassName="rounded-lg bg-amber-700 px-4 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
          confirmMessage="Undo pembayaran cycle ini? Ini akan tercatat sebagai koreksi beraudit (bukan penghapusan), dan cycle kembali ke draft untuk diperbaiki."
        >
          <textarea name="reason" required minLength={3} placeholder="Alasan koreksi (wajib)" className="mb-2 block h-16 w-full max-w-md rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs" />
        </PayrollActionForm>
        {run.correctionCount > 0 ? <p className="mt-2 text-[11px] font-semibold text-amber-800">{run.correctionCount}x dikoreksi sebelumnya.</p> : null}
      </div>
    ) : null}

    {canManage ? <div className="mt-5"><PayrollCycleSettingsForm settings={data.settings} dogSizeBands={dogSizeBands} /></div> : null}

    {data.missing.length > 0 ? (
      <section className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-amber-800">Selesai tapi belum ada invoice ({data.missing.length})</h2>
        <p className="mt-1 text-[11px] text-amber-700">Pekerjaan ini tidak masuk hitungan payroll sampai invoice dibuat.</p>
        <div className="mt-2 space-y-1">
          {data.missing.map((m) => (
            <div key={m.groomingJobPetId} className="flex items-center justify-between rounded-lg bg-white px-3 py-1.5 text-xs">
              <span>{m.staffName} · {new Date(m.startsAt).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" })}</span>
              <Link href={`/bookings?id=${m.bookingId}`} className="font-bold text-sky-700">Buka booking</Link>
            </div>
          ))}
        </div>
      </section>
    ) : null}

    <section className="mt-6">
      {data.staff.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><EmptyState title="Belum ada staf" description="Tambahkan konfigurasi gaji (staff_compensation) untuk groomer terlebih dahulu." /></div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.staff.map((staff) => (
            <div key={staff.membershipId}>
              <PayrollStaffCard staff={staff} runId={runId} runStatus={run?.status ?? null} periodStart={data.periodStart} canManage={Boolean(canManage)} canApprove={Boolean(canApprove)} />
              {canManage ? <StaffPayrollSettingsForm staff={staff} dogSizeBands={dogSizeBands} /> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  </WorkspaceShell>;
}
