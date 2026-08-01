"use client";

/**
 * Function index:
 * - LoginForm: validates credentials, signs in with Supabase, and routes to organization resolution.
 * - translateLoginError: converts safe Supabase Auth outcomes into Indonesian-facing copy.
 */
import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

function translateLoginError(message: string): string {
  if (/invalid login credentials/i.test(message)) {
    return "Email atau kata sandi belum tepat.";
  }

  if (/email not confirmed/i.test(message)) {
    return "Email belum dikonfirmasi. Periksa kotak masuk Anda.";
  }

  return "Tidak dapat masuk saat ini. Silakan coba lagi.";
}

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    if (!email) {
      setError("Masukkan alamat email Anda.");
      return;
    }

    if (!password) {
      setError("Masukkan kata sandi Anda.");
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (loginError) {
        setError(translateLoginError(loginError.message));
        setLoading(false);
        return;
      }

      router.replace("/organizations");
      router.refresh();
    } catch {
      setError("Koneksi ke Operro gagal. Periksa jaringan lalu coba lagi.");
      setLoading(false);
    }
  }

  return (
    <form className="mt-8 space-y-5" method="post" onSubmit={handleSubmit}>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"
        >
          {error}
        </div>
      ) : null}

      <div>
        <label
          htmlFor="email"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          disabled={loading}
          placeholder="nama@bisnis.com"
          className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 disabled:cursor-not-allowed disabled:bg-slate-50"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-4">
          <label htmlFor="password" className="text-sm font-semibold text-slate-700">
            Kata sandi
          </label>
          <span className="text-xs font-medium text-slate-400">
            Gunakan akun Operro Anda
          </span>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={loading}
          placeholder="••••••••"
          className="h-12 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 disabled:cursor-not-allowed disabled:bg-slate-50"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className="inline-flex h-12 w-full items-center justify-center rounded-xl bg-slate-950 px-5 text-sm font-semibold text-white shadow-lg shadow-slate-950/10 transition hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="size-4 animate-spin rounded-full border-2 border-white/35 border-t-white" />
            Memproses…
          </span>
        ) : (
          "Masuk ke Operro"
        )}
      </button>
    </form>
  );
}
