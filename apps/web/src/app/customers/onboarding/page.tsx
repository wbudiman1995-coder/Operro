import Link from "next/link";
import { OnboardingAdmin } from "@/components/onboarding-admin";
import { PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata={title:"Onboarding pelanggan"};
export default async function Page(){const workspace=await requireActiveWorkspace();const org=workspace.activeOrganization.id;const [links,subs,customers]=await Promise.all([workspace.supabase.from("customer_onboarding_links").select("id,status,source,internal_note,expires_at,created_at").eq("organization_id",org).order("created_at",{ascending:false}),workspace.supabase.from("customer_onboarding_submissions").select("id,payload,created_at").eq("organization_id",org).eq("status","submitted").order("created_at",{ascending:false}),workspace.supabase.from("customers").select("id,display_name,phone").eq("organization_id",org).is("deleted_at",null)]);return <WorkspaceShell {...workspace} activePath="/customers"><PageHeader eyebrow="Akuisisi pelanggan" title="Pendaftaran mandiri" description="Buat link WhatsApp, review data dan hewan, lalu setujui ke CRM." action={<Link href="/customers" className="rounded-xl border px-4 py-2 text-sm font-bold">Kembali</Link>}/><div className="mt-7"><OnboardingAdmin links={(links.data??[]) as never} submissions={(subs.data??[]) as never} customers={(customers.data??[]).map(c=>({id:c.id,name:c.display_name,phone:c.phone}))}/></div></WorkspaceShell>}
