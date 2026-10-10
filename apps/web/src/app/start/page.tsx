/**
 * Post-login / post-switch entry point. The destination comes from app.my_landing_page(), which validates the
 * saved personal default against the caller's live capabilities in the active organization.
 */
import { redirect } from "next/navigation";

import { loadAuthContext } from "@/lib/auth-context";
import { landingHref } from "@/lib/preferences";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function StartPage() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);
  if (!context) redirect("/login");
  if (!context.activeOrganization) redirect("/organizations");
  const { data, error } = await supabase.schema("app").rpc("my_landing_page");
  redirect(error ? "/dashboard" : landingHref(data));
}
