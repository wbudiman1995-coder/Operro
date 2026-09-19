"use client";

import { useActionState, useState } from "react";
import {
  cleanupOnboardingStorageAction,
  createOnboardingLinkAction,
  reviewOnboardingAction,
  revokeOnboardingLinkAction,
  updateOnboardingSettingsAction,
  type OnboardingActionState,
  type OnboardingSettingsState,
  type StorageCleanupState,
} from "@/app/customers/onboarding/actions";

type LinkRow={id:string;status:string;source:string|null;internal_note:string|null;expires_at:string;created_at:string};
type SubmissionRow={id:string;payload:Record<string,unknown>;created_at:string};
type Settings={whatsapp_template:string;reference_retention_days:number};
const defaultTemplate="Halo kak! Isi data kamu dan anabul untuk {business} melalui link ini:\n\n{link}\n\nLink berlaku dua hari.";
const initialLink:OnboardingActionState={error:null,success:null};
const initialSettings:OnboardingSettingsState={error:null,success:null};
const initialCleanup:StorageCleanupState={error:null,success:null};

function renderInvitation(template:string,business:string,link:string){
  return template.replaceAll("{business}",business).replaceAll("{link}",link);
}

export function OnboardingAdmin({
  organizationName,settings,links,submissions,customers,
}:{
  organizationName:string;
  settings:Settings|null;
  links:LinkRow[];
  submissions:SubmissionRow[];
  customers:Array<{id:string;name:string;phone:string|null}>;
}){
  const [state,action,pending]=useActionState(createOnboardingLinkAction,initialLink);
  const [settingsState,settingsAction,settingsPending]=useActionState(updateOnboardingSettingsAction,initialSettings);
  const [cleanupState,cleanupAction,cleanupPending]=useActionState(cleanupOnboardingStorageAction,initialCleanup);
  const [copied,setCopied]=useState(false);
  const link=state.linkPath&&typeof window!=="undefined"?`${window.location.origin}${state.linkPath}`:"";
  const template=settings?.whatsapp_template??defaultTemplate;
  const whatsappMessage=renderInvitation(template,organizationName,link);
  return <div className="space-y-6">
    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-bold">Buat link pendaftaran</h2>
      <p className="mt-1 text-xs text-slate-500">Satu kali pakai, kedaluwarsa otomatis dalam dua hari.</p>
      <form action={action} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input name="source" className="field" placeholder="Sumber, contoh Instagram"/>
        <input name="note" className="field" placeholder="Catatan lead internal"/>
        <button disabled={pending} className="rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white">{pending?"Membuat…":"Buat link"}</button>
      </form>
      {state.error||state.success?<p className={`mt-3 text-xs font-semibold ${state.error?"text-rose-700":"text-emerald-700"}`}>{state.error??state.success}</p>:null}
      {link?<div className="mt-3 flex flex-wrap gap-2"><input readOnly value={link} className="field min-w-0 flex-1"/><button type="button" onClick={async()=>{await navigator.clipboard.writeText(link);setCopied(true)}} className="rounded-xl border px-4 text-xs font-bold">{copied?"Tersalin":"Salin"}</button><a href={`https://wa.me/?text=${encodeURIComponent(whatsappMessage)}`} target="_blank" rel="noreferrer" className="grid place-items-center rounded-xl bg-emerald-50 px-4 text-xs font-bold text-emerald-800">WhatsApp</a></div>:null}
    </section>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-bold">Template undangan & retensi</h2>
      <p className="mt-1 text-xs leading-5 text-slate-500">Gunakan <code>{"{business}"}</code> untuk nama bisnis dan <code>{"{link}"}</code> untuk link unik. Link wajib ada.</p>
      <form action={settingsAction} className="mt-4 space-y-3">
        <label className="block text-xs font-semibold text-slate-600">Pesan WhatsApp<textarea name="whatsappTemplate" defaultValue={template} maxLength={1000} className="mt-1 min-h-32 w-full rounded-xl border border-slate-200 p-3 text-sm leading-6"/></label>
        <label className="block text-xs font-semibold text-slate-600">Simpan referensi gaya<select name="retentionDays" defaultValue={String(settings?.reference_retention_days??180)} className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 sm:max-w-xs"><option value="30">30 hari</option><option value="90">90 hari</option><option value="180">180 hari</option><option value="365">1 tahun</option></select></label>
        <div className="flex flex-wrap items-center justify-between gap-3">{settingsState.error||settingsState.success?<p className={`text-xs font-semibold ${settingsState.error?"text-rose-700":"text-emerald-700"}`}>{settingsState.error??settingsState.success}</p>:<span/>}<button disabled={settingsPending} className="rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-50">{settingsPending?"Menyimpan…":"Simpan pengaturan"}</button></div>
      </form>
    </section>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-bold">Menunggu review ({submissions.length})</h2>
      <div className="mt-4 space-y-3">{submissions.length===0?<p className="text-sm text-slate-400">Belum ada pendaftaran baru.</p>:submissions.map(row=>{
        const p=row.payload;const pets=Array.isArray(p.pets)?p.pets as Array<Record<string,unknown>>:[];const referenceCount=pets.reduce((sum,pet)=>sum+(Array.isArray(pet.styleReferences)?pet.styleReferences.length:0),0);const phone=String(p.phone??"");const duplicates=customers.filter(customer=>customer.phone?.replace(/\D/g,"")===phone.replace(/\D/g,""));
        return <article key={row.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex flex-wrap justify-between gap-3"><div><p className="font-bold">{String(p.customerName??"Pelanggan")}</p><p className="text-xs text-slate-500">{phone} · {String(p.kecamatan??"")}, {String(p.kabupatenKota??"")} · {pets.length} hewan{referenceCount?` · ${referenceCount} referensi gaya`:""}</p></div><span className="text-xs text-slate-400">{new Date(row.created_at).toLocaleString("id-ID")}</span></div><div className="mt-3 flex flex-wrap gap-2">{pets.map((pet,index)=><span key={index} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{String(pet.name??"?")} · {String(pet.breed??pet.species??"")}{Array.isArray(pet.styleReferences)&&pet.styleReferences.length?` · ${pet.styleReferences.length} foto`:""}</span>)}</div>{duplicates.length?<p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">Nomor ini cocok dengan: {duplicates.map(d=>d.name).join(", ")}. Pilih pelanggan tersebut untuk menambahkan hewan tanpa membuat duplikat.</p>:null}<form action={reviewOnboardingAction} className="mt-4 flex flex-wrap gap-2"><input type="hidden" name="submissionId" value={row.id}/><select name="mergeCustomerId" className="h-10 rounded-xl border px-3 text-xs"><option value="">Buat pelanggan baru</option>{duplicates.map(d=><option key={d.id} value={d.id}>Gabung ke {d.name}</option>)}</select><button name="decision" value="approve" className="rounded-xl bg-emerald-700 px-4 text-xs font-bold text-white">Setujui</button><button name="decision" value="reject" className="rounded-xl border border-rose-200 px-4 text-xs font-bold text-rose-700">Tolak</button></form></article>
      })}</div>
    </section>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold">Perawatan penyimpanan</h2><p className="mt-1 max-w-xl text-xs leading-5 text-slate-500">Hapus upload dari link yang ditolak, dicabut, atau kedaluwarsa, serta referensi yang sudah melewati masa simpan. Maksimum 1.000 link dan 1.000 metadata per proses.</p></div><form action={cleanupAction}><button disabled={cleanupPending} className="rounded-xl border border-rose-200 px-4 py-2.5 text-xs font-bold text-rose-700 disabled:opacity-50">{cleanupPending?"Membersihkan…":"Bersihkan sekarang"}</button></form></div>
      {cleanupState.error||cleanupState.success?<p className={`mt-3 rounded-xl p-3 text-xs font-semibold ${cleanupState.error?"bg-rose-50 text-rose-700":"bg-emerald-50 text-emerald-700"}`}>{cleanupState.error??cleanupState.success}</p>:null}
    </section>

    <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-bold">Riwayat link</h2>
      <div className="mt-4 space-y-2">{links.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3"><div><p className="text-xs font-bold uppercase">{row.status}{row.status==="active"&&new Date(row.expires_at)<new Date()?" · kedaluwarsa":""}</p><p className="text-xs text-slate-500">{row.source??"Tanpa sumber"}{row.internal_note?` · ${row.internal_note}`:""}</p></div>{row.status==="active"?<form action={revokeOnboardingLinkAction}><input type="hidden" name="id" value={row.id}/><button className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-bold text-rose-700">Cabut</button></form>:null}</div>)}</div>
    </section>
  </div>
}
