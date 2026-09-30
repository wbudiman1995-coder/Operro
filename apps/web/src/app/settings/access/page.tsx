import Link from "next/link";
import { OrganizationAccessManager } from "@/components/access-management";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Akses tim | Operro" };

export default async function AccessSettingsPage() {
  const workspace = await requireActiveWorkspace();
  const org = workspace.activeOrganization.id;
  const owner = await workspace.supabase.schema("app").rpc("is_business_owner", { p_org: org });
  if (owner.error || owner.data !== true) return <WorkspaceShell {...workspace} activePath="/settings/access"><RestrictedNotice title="Hanya untuk pemilik bisnis" description="Pemilik organisasi mengatur akses anggota dan izin Admin. Link undangan diterbitkan oleh pemilik Operro." /></WorkspaceShell>;
  const accessResult = await workspace.supabase.schema("app").rpc("list_organization_access", { p_org: org });
  const access = accessResult.data as { members: { email: string; role: string; status: string }[]; admin_keys: string[]; options: { key: string; description: string | null }[] } | null;
  return <WorkspaceShell {...workspace} activePath="/settings/access"><div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold text-emerald-700">Pengaturan organisasi</p><h1 className="text-2xl font-bold">Akses tim · {workspace.activeOrganization.name}</h1><p className="mt-2 text-sm text-slate-500">Atur role anggota yang sudah terdaftar dan checklist izin Admin bisnis. Untuk link undangan akun baru, hubungi pemilik Operro.</p></div><Link href="/catalog" className="rounded-lg border px-3 py-2 text-xs font-bold">Layanan & tim</Link></div>{access ? <OrganizationAccessManager organizationId={org} access={access} platform={false} /> : <p className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">Daftar akses tidak dapat dimuat.</p>}</WorkspaceShell>;
}
