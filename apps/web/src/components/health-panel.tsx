import type { CountResult, HealthSummary, Readiness, ReconciliationCounts, RecoveryStatus } from "@/lib/health";

const DRILL_TONE: Record<Readiness["drillState"], string> = {
  never: "border-rose-200 bg-rose-50 text-rose-900",
  latest_not_passed: "border-rose-200 bg-rose-50 text-rose-900",
  stale: "border-amber-200 bg-amber-50 text-amber-900",
  recent_pass: "border-emerald-200 bg-emerald-50 text-emerald-900",
};

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString("id-ID") : "—";
}

function Count({ label, result }: { label: string; result: CountResult }) {
  return <li className="flex flex-wrap justify-between gap-2 text-xs">
    <span className="text-slate-600">{label}</span>
    <span className="font-bold text-slate-800">{result.count === null ? <span className="font-semibold text-slate-500">{result.note ?? "Tidak tersedia"}</span> : <>{result.capped ? `${result.count}+` : result.count}{result.note ? <span className="ml-1 font-normal text-slate-500">({result.note})</span> : null}</>}</span>
  </li>;
}

/**
 * Read-only. Every number is a count or timestamp of something Operro already stores; provider status, backups and
 * billing are explicitly out of view, and recovery is never described as proven without a passed drill on record.
 */
export function HealthPanel({ summary, recovery, reconciliation, readiness, version, platform }: {
  summary: HealthSummary; recovery: RecoveryStatus; reconciliation: ReconciliationCounts; readiness: Readiness; version: string; platform: boolean;
}) {
  return <div className="mt-7 space-y-6">
    <section aria-labelledby="recovery-title" className={`rounded-2xl border p-5 ${DRILL_TONE[readiness.drillState]}`}>
      <h2 id="recovery-title" className="font-bold">Kesiapan pemulihan: {readiness.headline}</h2>
      <p className="mt-1 text-xs leading-5">{readiness.detail}</p>
      <p className="mt-2 text-[11px] leading-5 opacity-80">Export organisasi adalah arsip yang dapat diverifikasi integritasnya, <strong>bukan cadangan yang terbukti dapat dipulihkan</strong>. Hanya uji pemulihan ke proyek percobaan yang membuktikan pemulihan.</p>
      {platform && recovery.detail ? <dl className="mt-3 grid gap-1 text-[11px] sm:grid-cols-2">
        <div><dt className="inline font-semibold">Pemulihan ke: </dt><dd className="inline">{recovery.detail.restored_to}</dd></div>
        <div><dt className="inline font-semibold">RPO / RTO terukur: </dt><dd className="inline">{recovery.detail.rpo_minutes ?? "—"} / {recovery.detail.rto_minutes ?? "—"} menit</dd></div>
        <div className="sm:col-span-2"><dt className="inline font-semibold">Catatan: </dt><dd className="inline">{recovery.detail.notes ?? "—"}</dd></div>
        <div className="sm:col-span-2"><dt className="inline font-semibold">Referensi bukti: </dt><dd className="inline">{recovery.detail.evidence_ref ?? "—"}</dd></div>
      </dl> : null}
    </section>

    <section aria-labelledby="signals-title" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="signals-title" className="font-bold">Sinyal kesehatan</h2>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div><dt className="inline font-semibold text-slate-500">Versi aplikasi: </dt><dd className="inline">{version}</dd></div>
        <div><dt className="inline font-semibold text-slate-500">Versi skema database: </dt><dd className="inline">{summary.schema_version} {readiness.schemaMatches ? "(sesuai aplikasi)" : <strong className="text-rose-700">(tidak sesuai)</strong>}</dd></div>
        <div><dt className="inline font-semibold text-slate-500">Export terakhir selesai: </dt><dd className="inline">{when(summary.exports.last_completed_at)}</dd></div>
        <div><dt className="inline font-semibold text-slate-500">Pembersihan terakhir: </dt><dd className="inline">{summary.cleanup.last_apply_at ? `${when(summary.cleanup.last_apply_at)} (${summary.cleanup.last_apply_status})` : "belum pernah"}</dd></div>
        <div><dt className="inline font-semibold text-slate-500">Permintaan kapasitas menunggu: </dt><dd className="inline">{summary.capacity_requests.pending}{summary.capacity_requests.oldest_pending_at ? ` (tertua ${when(summary.capacity_requests.oldest_pending_at)})` : ""}</dd></div>
        <div><dt className="inline font-semibold text-slate-500">Dibuat pada: </dt><dd className="inline">{when(summary.generated_at)}</dd></div>
      </dl>
      <h3 className="mt-4 text-xs font-bold uppercase text-slate-500">Perlu perhatian</h3>
      {readiness.attention.length === 0 ? <p className="mt-1 text-xs text-slate-600">Tidak ada sinyal bermasalah dari data yang dibaca. Ini bukan jaminan: penyedia tidak dipantau dari sini.</p>
        : <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-rose-800">{readiness.attention.map((item) => <li key={item}>{item}</li>)}</ul>}
      {platform && summary.platform ? <p className="mt-4 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">Seluruh platform (hanya jumlah): {summary.platform.pending_capacity_requests} permintaan kapasitas menunggu · {summary.platform.failed_exports_30d} export gagal (30 hari) · {summary.platform.problem_cleanup_runs_30d} pembersihan bermasalah (30 hari).</p> : null}
    </section>

    <section aria-labelledby="reconciliation-title" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="reconciliation-title" className="font-bold">Rekonsiliasi belum selesai</h2>
      <p className="mt-1 text-xs text-slate-500">Dihitung baca-saja dari halaman Rekonsiliasi (maksimal 100 per pemeriksaan).</p>
      <ul className="mt-3 space-y-1.5">
        <Count label="Kunjungan selesai tanpa invoice valid" result={reconciliation.unbilledVisits} />
        <Count label="Invoice dan pembayaran valid tidak cocok" result={reconciliation.invoicePayments} />
        <Count label="Payroll dipublikasikan dengan sumber bermasalah" result={reconciliation.payrollSources} />
      </ul>
    </section>

    <section aria-labelledby="provider-title" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="provider-title" className="font-bold">Penyedia layanan</h2>
      <p className="mt-1 text-xs leading-5 text-slate-600">{readiness.providerNote}</p>
      <ul className="mt-2 space-y-1 text-xs">
        <li><a className="text-emerald-700 underline" href="https://supabase.com/docs/guides/platform/backups" rel="noreferrer" target="_blank">Supabase: backup dan point-in-time recovery</a></li>
        <li><a className="text-emerald-700 underline" href="https://vercel.com/docs/deployments/rollback" rel="noreferrer" target="_blank">Vercel: rollback deployment</a></li>
      </ul>
      <p className="mt-2 text-[11px] text-slate-500">Runbook lengkap: <code>docs/runbooks/RECOVERY_READINESS.md</code> (latihan pemulihan manual, apa yang harus dicatat, dan batasan).</p>
    </section>
  </div>;
}
