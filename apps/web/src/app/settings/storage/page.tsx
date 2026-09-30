import Link from "next/link";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { StorageRequestForm, StorageRequestReview } from "@/components/storage-request-form";
import { StorageUsageCard } from "@/components/storage-usage-card";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { loadStorageUsage } from "@/lib/storage-usage";

export const metadata = { title: "Penyimpanan | Operro" };

export default async function StorageSettingsPage() {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["settings.manage"]) return <WorkspaceShell {...workspace} activePath="/settings/storage"><RestrictedNotice title="Tidak ada akses pengaturan" description="Hanya pemilik atau pengelola pengaturan yang dapat melihat pemakaian data workspace." /></WorkspaceShell>;
  const org = workspace.activeOrganization.id;
  const [usage, ownRequests] = await Promise.all([
    loadStorageUsage(workspace.supabase),
    workspace.supabase.from("storage_upgrade_requests").select("id,requested_gb,status,created_at").eq("organization_id", org).order("created_at", { ascending: false }).limit(10),
  ]);
  const adminRequests = usage?.isPlatformAdmin ? await workspace.supabase.from("storage_upgrade_requests").select("id,organization_id,requested_gb,status,created_at,note").in("status", ["requested", "contacted"]).order("created_at", { ascending: false }).limit(50) : null;
  const pending = (ownRequests.data ?? []).some((row) => ["requested", "contacted"].includes(row.status));
  return <WorkspaceShell {...workspace} activePath="/settings/storage"><PageHeader eyebrow="Pengaturan workspace" title="Data & penyimpanan" description="Pantau file milik organisasi dan minta tambahan kapasitas sebelum kebutuhan meningkat." action={<Link href="/dashboard" className="rounded-lg border px-3 py-2 text-xs font-bold">Kembali</Link>} />
    <div className="mt-7"><StorageUsageCard usage={usage} /></div>
    <section className="mt-6 rounded-2xl border bg-white p-5"><h2 className="font-bold">Minta kapasitas tambahan</h2><div className="mt-4"><StorageRequestForm pending={pending} /></div><h3 className="mt-6 text-xs font-bold uppercase text-slate-500">Permintaan workspace ini</h3><div className="mt-2 space-y-2">{(ownRequests.data ?? []).length ? (ownRequests.data ?? []).map((row) => <p key={row.id} className="rounded-lg bg-slate-50 p-3 text-xs">{new Date(row.created_at).toLocaleDateString("id-ID")} · {row.requested_gb} GB · <strong>{row.status}</strong></p>) : <p className="text-xs text-slate-500">Belum ada permintaan.</p>}</div></section>
    <section className="mt-6 rounded-2xl border bg-white p-5"><h2 className="font-bold">Batas platform</h2><p className="mt-2 text-xs leading-5 text-slate-600">Supabase Free saat ini menyediakan patokan 500 MB database dan 1 GB file untuk seluruh proyek, bukan per organisasi. Vercel menyimpan build dan menjalankan aplikasi; file pelanggan Operro disimpan di Supabase. Angka Vercel tidak termasuk di meter workspace.</p>{usage?.isPlatformAdmin ? <div className="mt-3 flex flex-wrap gap-3 text-xs font-bold"><a href="https://supabase.com/dashboard/project/tekgjynseoetoxestweb/settings/billing/usage" target="_blank" rel="noreferrer" className="text-emerald-700 underline">Buka penggunaan Supabase</a><a href="https://vercel.com/wbudiman1995-coders-projects/~/usage" target="_blank" rel="noreferrer" className="text-emerald-700 underline">Buka penggunaan Vercel</a></div> : null}</section>
    {usage?.isPlatformAdmin ? <section className="mt-6 rounded-2xl border bg-white p-5"><h2 className="font-bold">Permintaan kapasitas semua organisasi</h2><div className="mt-4 space-y-3">{(adminRequests?.data ?? []).length ? (adminRequests?.data ?? []).map((row) => <div key={row.id} className="rounded-xl border p-3 text-xs"><p className="font-bold">Organisasi {row.organization_id} · {row.requested_gb} GB · {row.status}</p>{row.note ? <p className="mt-1 text-slate-600">{row.note}</p> : null}<div className="mt-2"><StorageRequestReview id={row.id} /></div></div>) : <p className="text-xs text-slate-500">Tidak ada permintaan aktif.</p>}</div></section> : null}
  </WorkspaceShell>;
}
