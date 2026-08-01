/**
 * Function index:
 * - OrganizationsPage: protects organization resolution, renders live memberships, and handles the no-organization state.
 */
import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/logout-button";
import { NoOrganizationState } from "@/components/no-organization-state";
import { OperroMark } from "@/components/operro-mark";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Pilih organisasi" };

export default async function OrganizationsPage() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);

  if (!context) {
    return redirect("/login");
  }

  if (context.organizations.length === 0) {
    return <NoOrganizationState email={context.user.email ?? "akun Operro"} />;
  }

  if (context.organizations.length === 1 && context.activeOrganization) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-7 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between gap-4">
          <OperroMark />
          <div className="flex items-center gap-4">
            <p className="hidden max-w-56 truncate text-sm font-medium text-slate-500 sm:block">{context.user.email}</p>
            <LogoutButton />
          </div>
        </header>

        <section className="mt-16">
          <p className="text-sm font-bold text-emerald-700">Pilih workspace</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-bold tracking-[-0.05em] text-slate-950 sm:text-5xl">Organisasi mana yang ingin Anda buka?</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-500">Kami hanya menampilkan organisasi dengan membership aktif dan status operasional yang masih valid.</p>

          <div className="mt-10">
            <OrganizationSwitcher
              organizations={context.organizations}
              activeOrganizationId={context.activeOrganization?.id ?? null}
            />
          </div>
        </section>
      </div>
    </main>
  );
}
