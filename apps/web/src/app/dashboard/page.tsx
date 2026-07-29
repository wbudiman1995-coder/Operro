import { redirect } from "next/navigation";

import { LogoutButton } from "@/components/logout-button";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen bg-zinc-950 p-8 text-white">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center justify-between border-b border-zinc-800 pb-6">
          <div>
            <p className="text-sm font-medium text-zinc-400">OPERRO</p>
            <h1 className="mt-1 text-3xl font-semibold">Dashboard</h1>
          </div>

          <LogoutButton />
        </header>

        <section className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Signed in as</p>
          <p className="mt-1 font-medium">{user.email}</p>

          <div className="mt-6 rounded-lg border border-amber-900 bg-amber-950 p-4 text-sm text-amber-200">
            Organization selection will be added after authentication is
            verified.
          </div>
        </section>
      </div>
    </main>
  );
}
