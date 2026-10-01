import Link from "next/link";
import { redirect } from "next/navigation";
import { BillingPeriodForm, OrganizationAccessManager, OrganizationPreparationForm, OrganizationStatusForm } from "@/components/access-management";
import { OperroMark } from "@/components/operro-mark";
import { StorageRequestReview } from "@/components/storage-request-form";
import { loadAuthContext } from "@/lib/auth-context";
import { formatBytes, SUPABASE_FREE_DATABASE_BYTES, SUPABASE_FREE_FILE_BYTES } from "@/lib/storage-usage";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Platform Operro" };

export default async function PlatformPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  const ownerCheck = await supabase.schema("app").rpc("is_operro_owner");
  if (ownerCheck.error || ownerCheck.data !== true) return <main className="mx-auto max-w-xl p-8"><h1 className="text-xl font-bold">Akses platform ditolak</h1><p className="mt-2 text-sm">Panel ini hanya untuk pemilik Operro.</p><Link href="/organizations" className="mt-4 inline-block text-emerald-700 underline">Kembali ke workspace</Link></main>;
  const [orgResult, requestResult, storageResult] = await Promise.all([
    supabase.from("organizations").select("id,name,slug,status,settings").is("deleted_at", null).order("name"),
    supabase.from("storage_upgrade_requests").select("id,organization_id,requested_gb,note,status,created_at").order("created_at", { ascending: false }).limit(100),
    supabase.schema("app").rpc("platform_storage_snapshot"),
  ]);
  const organizations = orgResult.data ?? [];
  const { org } = await searchParams;
  const selected = organizations.find(row => row.id === org) ?? organizations[0] ?? null;
  const [accessResult, inviteResult, billingResult] = selected ? await Promise.all([
    supabase.schema("app").rpc("list_organization_access", { p_org: selected.id }),
    supabase.schema("app").rpc("list_access_invitations", { p_org: selected.id }),
    supabase.schema("app").rpc("list_operro_billing", { p_org: selected.id }),
  ]) : [null, null, null];
  const access = accessResult?.data as { members: { email: string; role: string; status: string }[]; admin_keys: string[]; options: { key: string; description: string | null }[] } | null;
  const billing = (billingResult?.data ?? []) as { month: string; amount: number; due: string; status: string; paid_at: string | null; note: string | null; invoice_id: string | null; invoice_number: string | null }[];
  const invites = (inviteResult?.data ?? []) as { email: string; role: string; status: string; created_at: string }[];
  const usage = storageResult.data as { file_count?: number; file_bytes?: number; database_bytes?: number; measured_at?: string } | null;
  const requests = requestResult.data ?? [];
  const orgName = new Map(organizations.map(row => [row.id, row.name]));
  return <main className="min-h-screen bg-slate-50 px-4 py-7 text-slate-900"><div className="mx-auto max-w-6xl space-y-6"><header className="flex flex-wrap items-center justify-between gap-3"><OperroMark /><Link href="/organizations" className="rounded-lg border bg-white px-3 py-2 text-xs font-bold">Buka workspace</Link></header><div><p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Hanya wbudiman1995@gmail.com</p><h1 className="mt-1 text-3xl font-bold">Operro · pengelolaan platform</h1><p className="mt-2 text-sm text-slate-600">Siapkan bisnis, undang pemilik dan staf, kelola akses per organisasi, dan tinjau pembayaran manual.</p></div>
    <section className="grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border bg-white p-4"><p className="text-xs text-slate-500">Database seluruh proyek</p><p className="mt-1 font-bold">{usage ? formatBytes(Number(usage.database_bytes ?? 0)) : "Tidak tersedia"}</p><p className="text-[11px] text-slate-500">Patokan Free {formatBytes(SUPABASE_FREE_DATABASE_BYTES)}</p></div><div className="rounded-2xl border bg-white p-4"><p className="text-xs text-slate-500">File seluruh proyek</p><p className="mt-1 font-bold">{usage ? formatBytes(Number(usage.file_bytes ?? 0)) : "Tidak tersedia"}</p><p className="text-[11px] text-slate-500">{usage?.file_count ?? 0} file · patokan Free {formatBytes(SUPABASE_FREE_FILE_BYTES)}</p></div><div className="rounded-2xl border bg-white p-4"><p className="text-xs text-slate-500">Permintaan tambahan aktif</p><p className="mt-1 font-bold">{requests.filter(row => ["requested", "contacted"].includes(row.status)).length}</p><p className="text-[11px] text-slate-500">Masuk ke antrean di bawah; penagihan tetap manual.</p></div></section>
    <p className="text-xs text-slate-600">Database mencakup jadwal, pelanggan, metadata dan indeks seluruh proyek; file mencakup foto dan dokumen Storage. Ini bukan angka kuota Vercel, egress, atau tagihan resmi penyedia.</p>
    <div className="flex flex-wrap gap-4 text-xs font-bold"><a href="https://supabase.com/dashboard/org/ftwuxwriwgphoyttcmmp/usage" target="_blank" rel="noreferrer" className="text-emerald-700 underline">Pemakaian Supabase ↗</a><a href="https://vercel.com/wbudiman1995-coders-projects/~/usage" target="_blank" rel="noreferrer" className="text-emerald-700 underline">Pemakaian Vercel ↗</a></div>
    <OrganizationPreparationForm />
    <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">Organisasi ({organizations.length})</h2><div className="mt-3 flex flex-wrap gap-2">{organizations.map(row => <Link key={row.id} href={`/platform?org=${row.id}`} className={`rounded-lg border px-3 py-2 text-xs font-bold ${selected?.id === row.id ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "bg-white"}`}>{row.name} · {row.status}</Link>)}</div>{orgResult.error ? <p className="mt-2 text-xs text-rose-700">Daftar organisasi tidak dapat dimuat.</p> : null}</section>
    {selected ? <><section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">{selected.name}</h2><p className="mb-4 text-xs text-slate-500">/{selected.slug} · {selected.status} · {selected.id}</p><OrganizationStatusForm key={`${selected.id}:${selected.status}`} organizationId={selected.id} status={selected.status} /></section><BillingPeriodForm organizationId={selected.id} rows={billing} />{access ? <OrganizationAccessManager key={selected.id} organizationId={selected.id} access={access} platform organizationStatus={selected.status} /> : <p className="rounded-xl bg-rose-50 p-4 text-xs text-rose-700">Akses anggota belum dapat dimuat.</p>}<section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">Riwayat undangan</h2><div className="mt-2 space-y-2 text-xs">{invites.length ? invites.map((invite, index) => <p key={`${invite.email}-${index}`} className="rounded-lg bg-slate-50 p-2">{invite.email} · {invite.role} · {invite.status} · {new Date(invite.created_at).toLocaleDateString("id-ID")}</p>) : <p className="text-slate-500">Belum ada undangan.</p>}</div></section></> : null}
    <section className="rounded-2xl border bg-white p-5"><h2 className="font-bold">Permintaan kapasitas semua organisasi</h2><p className="mt-1 text-xs text-slate-500">Permintaan dari Pengaturan → Data & penyimpanan masuk ke sini; tidak ada email otomatis atau tagihan otomatis.</p><div className="mt-4 space-y-3">{requests.length ? requests.map(row => <div key={row.id} className="rounded-xl border p-3 text-xs"><p className="font-bold">{orgName.get(row.organization_id) ?? row.organization_id} · {row.requested_gb} GB · {row.status}</p><p className="mt-1 text-slate-500">{new Date(row.created_at).toLocaleString("id-ID")}{row.note ? ` · ${row.note}` : ""}</p>{["requested", "contacted"].includes(row.status) ? <div className="mt-2"><StorageRequestReview id={row.id} /></div> : null}</div>) : <p className="text-xs text-slate-500">Belum ada permintaan.</p>}</div>{requestResult.error ? <p className="text-xs text-rose-700">Daftar permintaan gagal dimuat.</p> : null}</section>
  </div></main>;
}
