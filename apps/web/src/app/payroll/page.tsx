/**
 * Payroll route for the HomePaw pilot.
 *
 * No hours-worked/attendance table exists anywhere in this schema, so hourly pay_type
 * cannot be computed from real hours — staff_compensation.base_amount is used as-is.
 */
import { approvePayrollRunAction, markPayrollRunPaidAction, recomputePayrollRunAction } from "@/app/pilot-actions";
import { ActionSubmitButton } from "@/components/action-submit-button";
import { EmptyState, PageHeader, StatCard } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { formatRupiah, loadPayrollWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Payroll" };

const RUN_STATUS_LABEL: Record<string, string> = { draft: "Draft", approved: "Disetujui", paid: "Lunas" };

function currentMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label: start.toLocaleDateString("id-ID", { month: "long", year: "numeric" }) };
}

export default async function PayrollPage() {
  const workspace = await requireActiveWorkspace();
  const period = currentMonthBounds();
  const data = await loadPayrollWorkspace(workspace.supabase, workspace.activeOrganization.id, period.start, period.end);
  const totalGross = data.staff.reduce((sum, s) => sum + s.grossPay, 0);

  return <WorkspaceShell {...workspace} activePath="/payroll"><PageHeader eyebrow={period.label} title="Payroll" description="Gaji pokok dari staff compensation, ditambah komisi yang sudah terakru dari booking selesai." />
    <div className="mt-7 grid gap-4 sm:grid-cols-3">
      <StatCard label="Staf aktif" value={String(data.staff.length)} helper="Dengan konfigurasi gaji." />
      <StatCard label="Total payroll" value={formatRupiah(totalGross)} helper="Estimasi bulan berjalan." tone="success" />
      <StatCard label="Status cycle" value={data.run ? RUN_STATUS_LABEL[data.run.status] ?? data.run.status : "Belum dihitung"} helper={data.run?.status === "paid" || data.run?.status === "approved" ? `Total tersimpan: ${formatRupiah(data.run.totalGross)}` : "Klik hitung untuk membuat draft."} />
    </div>

    <div className="mt-7 flex flex-wrap gap-2">
      {!data.run || data.run.status === "draft" ? (
        <form action={recomputePayrollRunAction}>
          <input type="hidden" name="periodStart" value={period.start} />
          <input type="hidden" name="periodEnd" value={period.end} />
          <ActionSubmitButton pendingLabel="Menghitung…" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60" disabled={data.staff.length === 0}>{data.run ? "Hitung ulang" : "Hitung payroll"}</ActionSubmitButton>
        </form>
      ) : null}
      {data.run?.status === "draft" ? (
        <form action={approvePayrollRunAction}>
          <input type="hidden" name="runId" value={data.run.id} />
          <ActionSubmitButton pendingLabel="Menyetujui…" className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60">Setujui</ActionSubmitButton>
        </form>
      ) : null}
      {data.run?.status === "approved" ? (
        <form action={markPayrollRunPaidAction}>
          <input type="hidden" name="runId" value={data.run.id} />
          <ActionSubmitButton pendingLabel="Menyimpan…" className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60">Tandai sudah dibayar</ActionSubmitButton>
        </form>
      ) : null}
    </div>

    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm">
      {data.staff.length === 0 ? (
        <div className="p-6"><EmptyState title="Belum ada staf" description="Tambahkan konfigurasi gaji (staff_compensation) untuk groomer terlebih dahulu." /></div>
      ) : (
        <div className="divide-y">{data.staff.map((s) => (
          <div key={s.membershipId} className="flex items-center justify-between gap-4 p-5">
            <div><p className="font-bold">{s.name}</p><p className="mt-1 text-xs text-slate-500">Pokok {formatRupiah(s.basePay)} · Komisi {formatRupiah(s.commissionTotal)}</p></div>
            <p className="text-lg font-bold text-emerald-700">{formatRupiah(s.grossPay)}</p>
          </div>
        ))}</div>
      )}
    </section>
  </WorkspaceShell>;
}
