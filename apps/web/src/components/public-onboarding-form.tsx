"use client";

import { useEffect, useState } from "react";
import { compressPhoto } from "@/lib/image-compression";
import { createClient } from "@/lib/supabase/client";

type StyleFile = { file: File; caption: string };
type Pet = { clientId: string; name: string; species: "dog"|"cat"; breed: string; age: string; weightKg: string; color: string; notes: string; styleFiles: StyleFile[] };
type LinkState = { valid:boolean; status:string; organization_name?:string; organization_id?:string };
const emptyPet=():Pet=>({clientId:crypto.randomUUID(),name:"",species:"dog",breed:"",age:"",weightKg:"",color:"",notes:"",styleFiles:[]});
const field="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10";
async function sha256(value:string){const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("")}
function extensionFor(type:string){return type==="image/png"?"png":type==="image/webp"?"webp":"jpg"}

export function PublicOnboardingForm({token}:{token:string}){
  const [link,setLink]=useState<LinkState|null>(null);
  const [pets,setPets]=useState<Pet[]>([emptyPet()]);
  const [form,setForm]=useState({customerName:"",phone:"",addressLine:"",kabupatenKota:"",kecamatan:"",customerNotes:"",latitude:"",longitude:""});
  const [state,setState]=useState<"idle"|"sending"|"done"|"error">("idle");
  const [message,setMessage]=useState("");
  useEffect(()=>{fetch(`/api/onboarding/${encodeURIComponent(token)}`).then(r=>r.json()).then(setLink).catch(()=>setLink({valid:false,status:"invalid"}))},[token]);
  if(!link)return <PublicScreen icon="…" title="Memuat pendaftaran" text="Mohon tunggu sebentar."/>;
  if(!link.valid)return <PublicScreen icon={link.status==="expired"?"⏰":"🔗"} title={link.status==="expired"?"Link kedaluwarsa":link.status==="submitted"?"Link sudah digunakan":"Link tidak valid"} text="Hubungi bisnis untuk mendapatkan link pendaftaran baru."/>;
  if(state==="done")return <PublicScreen icon="🎉" title="Terima kasih!" text="Data Anda, anabul, dan referensi gaya sudah diterima dan akan diperiksa sebelum masuk ke CRM."/>;

  const patch=(key:string,value:string)=>setForm(c=>({...c,[key]:value}));
  const patchPet=(i:number,key:keyof Pet,value:string)=>setPets(c=>c.map((p,n)=>n===i?{...p,[key]:value}:p));
  const patchCaption=(petIndex:number,fileIndex:number,caption:string)=>setPets(current=>current.map((pet,index)=>index===petIndex?{...pet,styleFiles:pet.styleFiles.map((item,n)=>n===fileIndex?{...item,caption}:item)}:pet));
  const addFiles=(petIndex:number,files:FileList|null)=>{if(!files)return;setPets(current=>current.map((pet,index)=>index===petIndex?{...pet,styleFiles:[...pet.styleFiles,...[...files].filter(file=>["image/jpeg","image/png","image/webp"].includes(file.type)).map(file=>({file,caption:""}))].slice(0,2)}:pet))};
  const removeFile=(petIndex:number,fileIndex:number)=>setPets(current=>current.map((pet,index)=>index===petIndex?{...pet,styleFiles:pet.styleFiles.filter((_,n)=>n!==fileIndex)}:pet));

  async function submit(){
    if(form.customerName.trim().length<2||form.phone.replace(/\D/g,"").length<7||!form.addressLine.trim()||pets.some(p=>!p.name.trim())){setState("error");setMessage("Periksa nama, WhatsApp, alamat, dan nama setiap anabul.");return}
    const organizationId=link?.organization_id;
    if(!organizationId){setState("error");setMessage("Workspace tujuan tidak tersedia. Minta link baru.");return}
    setState("sending");setMessage("Mengompresi dan mengunggah foto…");
    try{
      const supabase=createClient();const tokenHash=await sha256(token);const uploadedPets=[];
      for(const pet of pets){
        const styleReferences=[];
        for(const item of pet.styleFiles){
          const photo=await compressPhoto(item.file);
          if(photo.size>1572864)throw new Error("Foto referensi masih lebih besar dari 1,5 MB setelah kompresi.");
          const path=`${organizationId}/${tokenHash}/${pet.clientId}/${crypto.randomUUID()}.${extensionFor(photo.type)}`;
          const uploaded=await supabase.storage.from("onboarding-styling").upload(path,photo,{contentType:photo.type,upsert:false});
          if(uploaded.error)throw new Error("Salah satu foto tidak dapat diunggah. Coba foto yang lebih kecil.");
          styleReferences.push({path,filename:photo.name.slice(0,200),mimeType:photo.type,sizeBytes:photo.size,caption:item.caption.slice(0,300)});
        }
        uploadedPets.push({clientId:pet.clientId,name:pet.name,species:pet.species,breed:pet.breed,age:pet.age,weightKg:pet.weightKg||null,color:pet.color,notes:pet.notes,styleReferences});
      }
      setMessage("Mengirim data ke admin…");
      const response=await fetch(`/api/onboarding/${encodeURIComponent(token)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...form,latitude:form.latitude?Number(form.latitude):null,longitude:form.longitude?Number(form.longitude):null,pets:uploadedPets})});
      if(!response.ok)throw new Error("Data tidak dapat dikirim. Periksa link lalu coba lagi.");
      setState("done");
    }catch(error){setState("error");setMessage(error instanceof Error?error.message:"Pendaftaran tidak dapat dikirim.")}
  }

  return <main className="min-h-screen bg-[#f4f7f6] px-4 py-8"><div className="mx-auto max-w-xl">
    <div className="rounded-3xl bg-[#0f1b2d] p-6 text-white"><p className="text-xs font-bold uppercase tracking-[.16em] text-[#57c9ad]">{link.organization_name??"Operro"}</p><h1 className="mt-2 text-2xl font-bold">Pendaftaran pelanggan baru</h1><p className="mt-2 text-sm text-slate-300">Isi sekali dari ponsel. Admin akan memeriksa data sebelum menyimpannya.</p></div>
    <div className="mt-5 space-y-5 rounded-3xl border bg-white p-5 shadow-sm sm:p-7">
      <h2 className="font-bold">Data pemilik</h2>
      {([['customerName','Nama lengkap'],['phone','Nomor WhatsApp'],['addressLine','Alamat lengkap'],['kabupatenKota','Kabupaten/Kota'],['kecamatan','Kecamatan']] as const).map(([key,label])=><label key={key} className="block text-xs font-semibold text-slate-600">{label}<input value={form[key]} onChange={e=>patch(key,e.target.value)} className={`${field} mt-1`} /></label>)}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-slate-600">Latitude (opsional)<input value={form.latitude} onChange={e=>patch('latitude',e.target.value)} className={`${field} mt-1`} inputMode="decimal"/></label><label className="text-xs font-semibold text-slate-600">Longitude (opsional)<input value={form.longitude} onChange={e=>patch('longitude',e.target.value)} className={`${field} mt-1`} inputMode="decimal"/></label></div>
      <label className="block text-xs font-semibold text-slate-600">Catatan lokasi atau preferensi<textarea value={form.customerNotes} onChange={e=>patch('customerNotes',e.target.value)} className="mt-1 min-h-20 w-full rounded-xl border p-3 text-sm"/></label>
      <h2 className="pt-3 font-bold">Anabul</h2>
      {pets.map((pet,i)=><section key={pet.clientId} className="space-y-3 rounded-2xl bg-slate-50 p-4">
        <div className="flex justify-between"><strong className="text-sm">Anabul {i+1}</strong>{pets.length>1?<button type="button" onClick={()=>setPets(c=>c.filter((_,n)=>n!==i))} className="text-xs font-bold text-rose-600">Hapus</button>:null}</div>
        <div className="grid gap-3 sm:grid-cols-2"><input className={field} value={pet.name} onChange={e=>patchPet(i,'name',e.target.value)} placeholder="Nama"/><select className={field} value={pet.species} onChange={e=>patchPet(i,'species',e.target.value)}><option value="dog">Anjing</option><option value="cat">Kucing</option></select><input className={field} value={pet.breed} onChange={e=>patchPet(i,'breed',e.target.value)} placeholder="Ras"/><input className={field} value={pet.weightKg} onChange={e=>patchPet(i,'weightKg',e.target.value)} placeholder="Berat kg" inputMode="decimal"/><input className={field} value={pet.color} onChange={e=>patchPet(i,'color',e.target.value)} placeholder="Warna bulu"/><input className={field} value={pet.age} onChange={e=>patchPet(i,'age',e.target.value)} placeholder="Umur"/></div>
        <textarea className="min-h-20 w-full rounded-xl border p-3 text-sm" value={pet.notes} onChange={e=>patchPet(i,'notes',e.target.value)} placeholder="Catatan khusus untuk groomer"/>
        <div className="rounded-xl border border-violet-100 bg-violet-50 p-3"><p className="text-xs font-bold text-violet-900">Referensi gaya (opsional, maks. 2)</p><p className="mt-1 text-[11px] leading-5 text-violet-700">Kirim contoh model potongan yang diinginkan. Foto disimpan privat.</p>{pet.styleFiles.map((item,fileIndex)=><div key={`${item.file.name}-${fileIndex}`} className="mt-2 rounded-lg bg-white p-2"><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-xs font-semibold">{item.file.name}</span><button type="button" onClick={()=>removeFile(i,fileIndex)} className="text-[11px] font-bold text-rose-600">Hapus</button></div><input value={item.caption} onChange={e=>patchCaption(i,fileIndex,e.target.value)} maxLength={300} placeholder="Contoh: telinga tetap panjang" className="mt-2 h-9 w-full rounded-lg border px-2 text-xs"/></div>)}{pet.styleFiles.length<2?<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{addFiles(i,e.target.files);e.currentTarget.value=""}} className="mt-2 w-full rounded-lg bg-white p-2 text-xs"/>:null}</div>
      </section>)}
      {pets.length<5?<button type="button" onClick={()=>setPets(c=>[...c,emptyPet()])} className="w-full rounded-xl border-2 border-dashed border-emerald-300 py-3 text-sm font-bold text-emerald-700">+ Tambah anabul</button>:null}
      {state==="error"?<p className="rounded-xl bg-rose-50 p-3 text-xs font-semibold text-rose-700">{message}</p>:state==="sending"?<p className="rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-700">{message}</p>:null}
      <button type="button" onClick={submit} disabled={state==="sending"} className="h-12 w-full rounded-xl bg-emerald-700 text-sm font-bold text-white disabled:opacity-50">{state==="sending"?"Mengirim…":"Kirim ke admin"}</button>
      <p className="text-center text-[11px] text-slate-400">Data baru masuk ke CRM setelah disetujui admin.</p>
    </div>
  </div></main>
}

function PublicScreen({icon,title,text}:{icon:string;title:string;text:string}){return <main className="grid min-h-screen place-items-center bg-[#f4f7f6] p-6"><div className="max-w-sm text-center"><div className="text-5xl">{icon}</div><h1 className="mt-4 text-xl font-bold">{title}</h1><p className="mt-2 text-sm text-slate-500">{text}</p></div></main>}
