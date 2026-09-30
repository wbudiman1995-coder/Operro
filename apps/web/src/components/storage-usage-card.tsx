import Link from "next/link";
import { formatBytes, SUPABASE_FREE_DATABASE_BYTES, SUPABASE_FREE_FILE_BYTES, type StorageUsage } from "@/lib/storage-usage";

function Meter({ label, bytes, freeReference }: { label: string; bytes: number; freeReference: number }) {
  const percent = Math.round(bytes / freeReference * 100);
  return <div><div className="flex justify-between gap-3 text-xs"><span className="font-semibold">{label}</span><span>{formatBytes(bytes)} / {formatBytes(freeReference)} Free</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${percent >= 80 ? "bg-amber-500" : "bg-emerald-600"}`} style={{ width: `${Math.min(100, percent)}%` }} /></div><p className="mt-1 text-[11px] text-slate-500">{percent}% dari patokan Supabase Free. Kuota aktual bergantung pada paket platform.</p></div>;
}

export function StorageUsageCard({ usage, compact = false }: { usage: StorageUsage | null; compact?: boolean }) {
  return <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Pemakaian data dan penyimpanan">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">Pemakaian data</h2><p className="mt-1 text-xs text-slate-500">Ukuran file milik workspace ini, termasuk foto dan dokumen.</p></div><Link href="/settings/storage" className="text-xs font-bold text-emerald-700 underline">Lihat detail & minta kapasitas</Link></div>
    {usage ? <div className="mt-4 space-y-3"><p className="text-sm font-bold">{formatBytes(usage.organizationFileBytes)} <span className="text-xs font-normal text-slate-500">· {usage.organizationFileCount} file workspace</span></p>{usage.isPlatformAdmin && usage.projectFileBytes !== null && usage.projectDatabaseBytes !== null ? <div className="space-y-3"><Meter label="File seluruh proyek Supabase" bytes={usage.projectFileBytes} freeReference={SUPABASE_FREE_FILE_BYTES} /><Meter label="Database seluruh proyek Supabase" bytes={usage.projectDatabaseBytes} freeReference={SUPABASE_FREE_DATABASE_BYTES} /></div> : <p className="text-xs text-slate-500">Kuota Supabase berlaku untuk seluruh proyek Operro, bukan satu workspace. Metrik proyek hanya terlihat oleh admin platform.</p>}</div> : <p className="mt-3 text-xs text-slate-500">Metrik belum tersedia. Buka detail atau coba muat ulang setelah pembaruan database.</p>}
    {!compact ? <p className="mt-3 text-[11px] text-slate-500">Angka ini adalah snapshot saat halaman dibuka. Tagihan Supabase menghitung pemakaian file rata-rata selama periode tagihan; pemakaian Vercel dilihat terpisah di dashboard Vercel.</p> : null}
  </section>;
}
