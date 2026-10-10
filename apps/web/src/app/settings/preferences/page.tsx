/** E1.4: personal defaults (user-owned). Business-owned settings live under /settings/storage and /settings/documents. */
import { LandingPreferenceForm } from "@/components/landing-preference-form";
import { PageHeader } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { LANDING_PAGES } from "@/lib/preferences";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Preferensi saya" };

export default async function PreferencesPage() {
  const workspace = await requireActiveWorkspace();
  const { data } = await workspace.supabase.from("user_preferences").select("landing_page").eq("user_id", workspace.userId).maybeSingle();
  const available = LANDING_PAGES.filter((page) => page.capability === null || workspace.capabilities[page.capability]).map((page) => page.key);
  return <WorkspaceShell {...workspace} activePath="/settings/preferences">
    <PageHeader eyebrow="Akun" title="Preferensi saya" description="Pengaturan pribadi untuk akun Anda. Berbeda dari pengaturan bisnis yang dikelola pemilik." />
    <section className="mt-7 max-w-xl rounded-2xl border border-slate-200 bg-white p-5">
      <LandingPreferenceForm saved={data?.landing_page ?? null} available={available} />
    </section>
  </WorkspaceShell>;
}
