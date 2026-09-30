"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function AcceptInvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function claim() {
    const supabase = createClient();
    const { error } = await supabase.schema("app").rpc("claim_access_invitation", { p_token: token });
    if (error) {
      setMessage(error.message.includes("wrong_or_unverified_email") ? "Masuk menggunakan email penerima undangan yang sudah diverifikasi." : "Link tidak tersedia, kedaluwarsa, atau sudah digunakan. Minta link baru kepada pemilik.");
      return;
    }
    await supabase.auth.refreshSession();
    router.replace("/organizations");
    router.refresh();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const supabase = createClient();
      if (mode === "login") {
        const result = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (result.error) { setMessage("Email atau kata sandi salah, atau email belum diverifikasi."); return; }
        await claim();
      } else {
        if (password.length < 8) { setMessage("Gunakan kata sandi minimal 8 karakter."); return; }
        const result = await supabase.auth.signUp({ email: email.trim().toLowerCase(), password });
        if (result.error) { setMessage("Akun belum dapat dibuat. Jika email sudah terdaftar, gunakan tab Masuk."); return; }
        if (result.data.session) await claim();
        else setMessage("Periksa email untuk verifikasi, lalu buka kembali link undangan ini dan masuk. Jangan bagikan link ke orang lain.");
      }
    } catch { setMessage("Koneksi gagal. Coba lagi."); }
    finally { setBusy(false); }
  }

  return <div className="mt-6 space-y-4">
    <div className="flex rounded-xl bg-slate-100 p-1"><button type="button" onClick={() => { setMode("login"); setMessage(""); }} className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold ${mode === "login" ? "bg-white shadow-sm" : "text-slate-500"}`}>Sudah punya akun</button><button type="button" onClick={() => { setMode("register"); setMessage(""); }} className={`flex-1 rounded-lg px-3 py-2 text-sm font-bold ${mode === "register" ? "bg-white shadow-sm" : "text-slate-500"}`}>Buat akun</button></div>
    <form onSubmit={submit} className="space-y-4"><label className="block text-sm font-semibold">Email penerima<input type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><label className="block text-sm font-semibold">Kata sandi<input type="password" required minLength={mode === "register" ? 8 : undefined} autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={event => setPassword(event.target.value)} className="mt-1 h-11 w-full rounded-lg border px-3" /></label><button disabled={busy} className="h-11 w-full rounded-lg bg-emerald-700 px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? "Memproses…" : mode === "login" ? "Masuk & terima undangan" : "Buat akun & lanjutkan"}</button></form>
    <button type="button" disabled={busy} onClick={() => { setBusy(true); setMessage(""); claim().finally(() => setBusy(false)); }} className="text-xs font-bold text-emerald-700 underline">Sudah masuk? Terima undangan sekarang</button>
    {message ? <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{message}</p> : null}
  </div>;
}
