import Link from "next/link";
import { InvitationHistory, OrganizationAccessManager, type AccessInvitation } from "@/components/access-management";
import { RestrictedNotice } from "@/components/restricted-notice";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Akses tim | Operro" };

export default async function AccessSettingsPage() {
  const workspace = await requireActiveWorkspace();
  const org = workspace.activeOrganization.id;
  const owner = await workspace.supabase.schema("app").rpc("is_business_owner_member", { p_org: org });
  if (owner.error || owner.data !== true) return <WorkspaceShell {...workspace} activePath="/settings/access"><RestrictedNotice title="Hanya untuk pemilik bisnis atau Operro" description="Pemilik bisnis dan pemilik platform Operro dapat meninjau tim dan mengatur izin Admin di organisasi ini." /></WorkspaceShell>;
  const [accessResult, invitationResult] = await Promise.all([
    workspace.supabase.schema("app").rpc("list_organization_access", { p_org: org }),
    workspace.supabase.schema("app").rpc("list_access_invitations", { p_org: org }),
  ]);
  const access = accessResult.data as { members: { email: string; role: string; status: string }[]; admin_keys: string[]; options: { key: string; description: string | null }[] } | null;
  const invitations = (invitationResult.data ?? []) as AccessInvitation[];
  return <WorkspaceShell {...workspace} activePath="/settings/access"><div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-bold text-emerald-700">Pengaturan organisasi</p><h1 className="text-2xl font-bold">Akses tim · {workspace.activeOrganization.name}</h1><p className="mt-2 text-sm text-slate-500">Atur role anggota yang sudah terdaftar dan checklist izin Admin bisnis. Akses email berlaku sampai ditangguhkan. Groomer tidak memakai email: buat kode pribadi mereka dari Layanan & tim. Bantuan Operro hanya membantu organisasi ini dan tidak memberi akses platform atau payroll.</p></div><Link href="/catalog#daftar-groomer" className="rounded-lg border px-3 py-2 text-xs font-bold">Kode groomer</Link></div>{access ? <><OrganizationAccessManager organizationId={org} access={access} platform={false} /><div className="mt-5"><InvitationHistory organizationId={org} invitations={invitations} platform={false} /></div></> : <p className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">Daftar akses tidak dapat dimuat.</p>}</WorkspaceShell>;
}
