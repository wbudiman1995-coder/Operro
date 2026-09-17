/**
 * Function index:
 * - createClient: creates the cookie-backed server Supabase client for Server Components and Route Handlers.
 */
import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Wrapped in React `cache()` so every Server Component in one request/render
 * pass gets the SAME client instance instead of a fresh one per call. This is
 * what makes caching `loadAuthContext`/`requireActiveWorkspace` actually
 * effective — `cache()` dedupes by argument identity, and a fresh client
 * per caller would defeat it even if the downstream functions were cached.
 */
export const createClient = cache(async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot always write cookies; proxy.ts refreshes them.
          }
        },
      },
    },
  );
});
