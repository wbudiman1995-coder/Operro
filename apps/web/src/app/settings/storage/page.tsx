import Link from "next/link";
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { StorageRequestForm } from "@/components/storage-request-form";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { formatBytes, loadStorageUsage } from "@/lib/storage-usage";

export const metadata = { title: "Penyimpanan | Operro" };

export default async function StorageSettingsPage() {
  const workspace = await requireActiveWorkspace();
  if (!workspace.capabilities["settings.manage"]) return <WorkspaceShell {...workspace} activePath="/settings/storage"><RestrictedNotice title="Tidak ada akses pengaturan" description="Hanya pemilik atau pengelola pengaturan yang dapat melihat pemakaian data workspace." /></WorkspaceShell>;
  const [usage, requests] = await Promise.all([
    loadStorageUsage(workspace.supabase),
    workspace.supabase.from("storage_upgrade_requests").select("id,requested_gb,status,created_at").eq("organization_id", workspace.activeOrganization.id).order("created_at", { ascending: false }).limit(10),
  ]);
  const pending = (requests.data ?? []).some(row => ["requested", "contacted"].includes(row.status));
  return <WorkspaceShell {...workspace} activePath="/settings/storage">
    <PageHeader eyebrow="Pengaturan workspace" title="Data & penyimpanan" description="Lihat file organisasi Anda dan minta tambahan kapasitas." action={<Link href="/dashboard" className="rounded-lg border px-3 py-2 text-xs font-bold">Kembali</Link>} />
    <section className="mt-7 rounded-2xl border bg-white p-5"><h2 className="font-bold">File workspace ini</h2><p className="mt-2 text-lg font-bold">{usage ? formatBytes(usage.organizationFileBytes) : "Belum tersedia"}</p><p className="text-xs text-slate-500">{usage?.organizationFileCount ?? 0} file tersimpan. Angka diperbarui saat halaman dibuka.</p></section>
    <section className="mt-6 rounded-2xl border bg-white p-5"><h2 className="font-bold">Minta kapasitas tambahan</h2><p className="mt-1 text-xs leading-5 text-slate-500">Permintaan masuk ke panel internal pemilik Operro, yang akan menghubungi Anda untuk harga dan pembayaran manual. Permintaan ini belum membuat tagihan atau menambah kuota otomatis.</p><div className="mt-4"><StorageRequestForm pending={pending} /></div><h3 className="mt-6 text-xs font-bold uppercase text-slate-500">Status permintaan workspace ini</h3><div className="mt-2 space-y-2">{(requests.data ?? []).length ? (requests.data ?? []).map(row => <p key={row.id} className="rounded-lg bg-slate-50 p-3 text-xs">{new Date(row.created_at).toLocaleDateString("id-ID")} · {row.requested_gb} GB · <strong>{row.status}</strong></p>) : <p className="text-xs text-slate-500">Belum ada permintaan.</p>}</div></section>
  </WorkspaceShell>;
}
