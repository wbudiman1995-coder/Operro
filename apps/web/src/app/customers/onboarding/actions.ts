"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { loadCapabilities } from "@/lib/authorization";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export interface OnboardingActionState { error: string | null; success: string | null; linkPath?: string }
export interface OnboardingSettingsState { error: string | null; success: string | null }
export interface StorageCleanupState { error: string | null; success: string | null; removed?: number; expired?: number }

export async function createOnboardingLinkAction(_previous: OnboardingActionState, formData: FormData): Promise<OnboardingActionState> {
  try {
    const workspace = await requireActiveWorkspace();
    const capabilities = await loadCapabilities(workspace.supabase);
    if (!capabilities["customer.manage"]) return { error: "Anda tidak memiliki izin mengelola pelanggan.", success: null };
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const source = String(formData.get("source") ?? "").trim().slice(0, 80) || null;
    const note = String(formData.get("note") ?? "").trim().slice(0, 500) || null;
    const { error } = await workspace.supabase.from("customer_onboarding_links").insert({ organization_id: workspace.activeOrganization.id, token_hash: tokenHash, source, internal_note: note });
    if (error) throw error;
    revalidatePath("/customers/onboarding");
    return { error: null, success: "Link aktif selama dua hari. Salin sekarang; token mentah tidak disimpan.", linkPath: `/join/${token}` };
  } catch (error) { console.error("create_onboarding_link_failed", error); return { error: "Link tidak dapat dibuat.", success: null }; }
}

export async function revokeOnboardingLinkAction(formData: FormData) {
  const workspace = await requireActiveWorkspace();
  const capabilities = await loadCapabilities(workspace.supabase);
  if (!capabilities["customer.manage"]) return;
  const id = String(formData.get("id") ?? "");
  await workspace.supabase.from("customer_onboarding_links").update({ status: "revoked" }).eq("organization_id", workspace.activeOrganization.id).eq("id", id).eq("status", "active");
  revalidatePath("/customers/onboarding");
}

export async function reviewOnboardingAction(formData: FormData) {
  const workspace = await requireActiveWorkspace();
  const decision = String(formData.get("decision") ?? "");
  const submissionId = String(formData.get("submissionId") ?? "");
  const mergeCustomer = String(formData.get("mergeCustomerId") ?? "") || null;
  const { error } = await workspace.supabase.schema("app").rpc("review_customer_onboarding", { p_submission: submissionId, p_decision: decision, p_merge_customer: mergeCustomer });
  if (error) console.error("review_onboarding_failed", error);
  revalidatePath("/customers/onboarding"); revalidatePath("/customers");
}

export async function updateOnboardingSettingsAction(_previous: OnboardingSettingsState, formData: FormData): Promise<OnboardingSettingsState> {
  try {
    const workspace=await requireActiveWorkspace(); const capabilities=await loadCapabilities(workspace.supabase);
    if(!capabilities["customer.manage"])return {error:"Anda tidak memiliki izin mengelola pelanggan.",success:null};
    const template=String(formData.get("whatsappTemplate")??"").trim(); const retentionDays=Number(formData.get("retentionDays")??180);
    if(template.length<20||template.length>1000||!template.includes("{link}"))return {error:"Template harus 20–1.000 karakter dan memuat {link}.",success:null};
    if(!Number.isInteger(retentionDays)||retentionDays<30||retentionDays>365)return {error:"Retensi harus antara 30 dan 365 hari.",success:null};
    const {error}=await workspace.supabase.from("customer_onboarding_settings").upsert({organization_id:workspace.activeOrganization.id,whatsapp_template:template,reference_retention_days:retentionDays},{onConflict:"organization_id"});
    if(error)throw error; revalidatePath("/customers/onboarding");
    return {error:null,success:"Template undangan dan retensi berhasil disimpan."};
  }catch(error){console.error("update_onboarding_settings_failed",error);return {error:"Pengaturan onboarding tidak dapat disimpan.",success:null}}
}

async function listStoragePaths(supabase: Awaited<ReturnType<typeof requireActiveWorkspace>>["supabase"], bucket:string, prefix:string, depth=0):Promise<string[]>{
  if(depth>3)return [];
  const {data,error}=await supabase.storage.from(bucket).list(prefix,{limit:1000,sortBy:{column:"name",order:"asc"}});
  if(error)throw error; const paths:string[]=[];
  for(const item of data??[]){const path=`${prefix}/${item.name}`;if(item.id===null)paths.push(...await listStoragePaths(supabase,bucket,path,depth+1));else paths.push(path)}
  return paths;
}

export async function cleanupOnboardingStorageAction(previous: StorageCleanupState):Promise<StorageCleanupState>{
  try{
    void previous;
    const workspace=await requireActiveWorkspace();const capabilities=await loadCapabilities(workspace.supabase);
    if(!capabilities["customer.manage"])return {error:"Anda tidak memiliki izin mengelola pelanggan.",success:null};
    const org=workspace.activeOrganization.id;const now=Date.now();let removed=0;
    const links=await workspace.supabase.from("customer_onboarding_links").select("token_hash,status,expires_at").eq("organization_id",org).limit(1000);
    if(links.error)throw links.error;
    for(const link of links.data??[]){const dead=["rejected","revoked"].includes(link.status)||(link.status==="active"&&Date.parse(link.expires_at)<=now);if(!dead)continue;const paths=await listStoragePaths(workspace.supabase,"onboarding-styling",`${org}/${link.token_hash}`);if(paths.length){const deletion=await workspace.supabase.storage.from("onboarding-styling").remove(paths);if(deletion.error)throw deletion.error;removed+=paths.length}}
    const attachments=await workspace.supabase.from("attachments").select("id,storage_bucket,storage_path,metadata").eq("organization_id",org).in("storage_bucket",["styling-references","onboarding-styling"]).is("deleted_at",null).limit(1000);
    if(attachments.error)throw attachments.error;
    const expired=(attachments.data??[]).filter(row=>{const metadata=row.metadata&&typeof row.metadata==="object"&&!Array.isArray(row.metadata)?row.metadata as Record<string,unknown>:{};return metadata.kind==="styling_reference"&&typeof metadata.expires_at==="string"&&Date.parse(metadata.expires_at)<=now});
    for(const bucket of ["styling-references","onboarding-styling"]){const rows=expired.filter(row=>row.storage_bucket===bucket);if(!rows.length)continue;const deletion=await workspace.supabase.storage.from(bucket).remove(rows.map(row=>row.storage_path));if(deletion.error)throw deletion.error;const update=await workspace.supabase.from("attachments").update({deleted_at:new Date().toISOString()}).eq("organization_id",org).in("id",rows.map(row=>row.id));if(update.error)throw update.error}
    revalidatePath("/customers/onboarding");revalidatePath("/my-schedule");
    return {error:null,success:`Pembersihan selesai: ${removed} unggahan terbengkalai dan ${expired.length} referensi kedaluwarsa dihapus.`,removed,expired:expired.length};
  }catch(error){console.error("cleanup_onboarding_storage_failed",error);return {error:"Penyimpanan tidak dapat dibersihkan. Tidak ada hasil parsial yang dilaporkan sebagai sukses.",success:null}}
}
