/**
 * Function index:
 * - LoginPage: redirects existing sessions and renders the secure email/password sign-in screen.
 */
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { OperroMark } from "@/components/operro-mark";
import { loadAuthContext } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Masuk" };

export default async function LoginPage() {
  const supabase = await createClient();
  const context = await loadAuthContext(supabase);

  if (context) {
    redirect("/organizations");
  }

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[0.95fr_1.05fr]">
      <section className="flex items-center justify-center px-5 py-10 sm:px-8 lg:px-12">
        <div className="w-full max-w-md">
          <OperroMark />
          <p className="mt-12 text-xs font-bold uppercase tracking-[0.18em] text-[#0f8a72]">Selamat datang kembali</p>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.05em] text-slate-950">Masuk ke workspace Anda</h1>
          <p className="mt-4 text-sm leading-7 text-slate-500">Gunakan email dan kata sandi yang terdaftar. Organisasi aktif akan diverifikasi sebelum dashboard dibuka.</p>
          <LoginForm />
          <p className="mt-8 text-xs leading-5 text-slate-400">Dengan masuk, Anda mengakses data sesuai membership dan kebijakan keamanan organisasi Anda.</p>
        </div>
      </section>
      <aside className="relative hidden overflow-hidden bg-[#0f1b2d] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-[#0f8a72]/25 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 size-80 rounded-full bg-[#f2994a]/10 blur-3xl" />
        <div className="relative">
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-[#57c9ad]">Sistem operasional untuk pemilik bisnis</span>
          <blockquote className="mt-10 max-w-xl text-4xl font-semibold leading-tight tracking-[-0.045em]">“Satu tempat untuk melihat apa yang terjadi, apa yang tertunda, dan apa yang harus dilakukan berikutnya.”</blockquote>
        </div>
        <div className="relative grid grid-cols-3 gap-3">
          {["Booking", "Pelanggan", "Operasional"].map((label) => (
            <div key={label} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-semibold text-slate-300">{label}</div>
          ))}
        </div>
      </aside>
    </main>
  );
}
