"use client";

/**
 * Section 28: multi-image grooming evidence capture. Browse (multi-select),
 * drag-and-drop, and clipboard paste all feed the same upload queue, which
 * is compressed and uploaded ONE FILE PER CALL through the existing,
 * unchanged uploadGroomingEvidenceAction (server-side validation/assignment
 * check untouched) - only the client-side collection of files is new.
 */
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";

import { deleteGroomingEvidenceAction, uploadGroomingEvidenceAction, type PilotActionState } from "@/app/pilot-actions";
import { compressPhoto } from "@/lib/image-compression";

const initialState: PilotActionState = { error: null, success: null };

const otherCategories: Array<{ value: string; label: string }> = [
  { value: "attendance", label: "Kehadiran" }, { value: "ear", label: "Telinga" },
  { value: "hygiene", label: "Area higienis" }, { value: "dematting", label: "Dematting" },
  { value: "fungal", label: "Kondisi jamur" }, { value: "injury", label: "Cedera" }, { value: "other", label: "Lainnya" },
];
const categoryLabels: Record<string, string> = { before: "Sebelum", after: "Sesudah", ...Object.fromEntries(otherCategories.map((c) => [c.value, c.label])) };

/**
 * One upload zone: browse (multi-select), drag-and-drop, and clipboard
 * paste all feed the same client-side queue, compressed and uploaded ONE
 * FILE PER CALL through the existing, unchanged uploadGroomingEvidenceAction
 * (server-side validation/assignment check untouched). `category` is either
 * a fixed string (the Before/After zones, always visible and always that
 * category) or a `{ options, value, onChange }` selector (the "other
 * categories" zone) — same upload mechanics either way.
 */
function EvidenceUploadZone({ bookingId, petJobId, label, category }: {
  bookingId: string; petJobId: string; label: string;
  category: { kind: "fixed"; value: string } | { kind: "selectable"; options: Array<{ value: string; label: string }>; value: string; onChange: (value: string) => void };
}) {
  const router = useRouter();
  const [queue, setQueue] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<PilotActionState>(initialState);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeCategory = category.kind === "fixed" ? category.value : category.value;

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length) setQueue((prev) => [...prev, ...images]);
  }

  async function uploadAll() {
    if (queue.length === 0 || uploading) return;
    setUploading(true);
    const files = queue;
    setQueue([]);
    let lastResult: PilotActionState = initialState;
    let failures = 0;
    for (let i = 0; i < files.length; i += 1) {
      setProgress({ done: i, total: files.length });
      const compressed = await compressPhoto(files[i]);
      const data = new FormData();
      data.set("bookingId", bookingId); data.set("petJobId", petJobId); data.set("category", activeCategory); data.set("photo", compressed);
      lastResult = await uploadGroomingEvidenceAction(initialState, data);
      if (lastResult.error) failures += 1;
    }
    setProgress(null);
    setUploading(false);
    setMessage(failures > 0
      ? { error: `${failures} dari ${files.length} foto gagal diunggah (${lastResult.error ?? "unknown"}).`, success: failures < files.length ? `${files.length - failures} foto berhasil.` : null }
      : { error: null, success: `${files.length} foto berhasil disimpan.` });
    router.refresh();
  }

  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
    <p className="text-xs font-bold text-slate-800">{label}</p>
    {category.kind === "selectable" ? (
      <select value={category.value} onChange={(e) => category.onChange(e.target.value)} className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold sm:w-40">
        {category.options.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    ) : null}

    <div
      role="button" tabIndex={0}
      onClick={() => fileInputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
      onPaste={(e) => { const files = Array.from(e.clipboardData.items).map((item) => item.getAsFile()).filter((f): f is File => f !== null); addFiles(files); }}
      className={`mt-2 flex min-h-[88px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-3 text-center text-xs font-semibold transition ${dragOver ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-500"}`}
    >
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      <span>Klik untuk pilih, seret foto ke sini, atau tempel (paste) dari clipboard</span>
      <span className="mt-1 text-[10px] font-normal text-slate-400">Bisa pilih beberapa foto sekaligus · maksimum 4 MB per foto setelah kompresi</span>
    </div>

    {queue.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-2">
      <p className="text-[11px] font-semibold text-slate-600">{queue.length} foto siap diunggah untuk kategori &ldquo;{categoryLabels[activeCategory] ?? activeCategory}&rdquo;</p>
      <button type="button" onClick={() => setQueue([])} className="text-[11px] font-bold text-rose-600">Kosongkan</button>
    </div> : null}

    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p className={`text-[11px] font-semibold ${message.error ? "text-rose-700" : "text-emerald-700"}`}>
        {progress ? `Mengunggah ${progress.done + 1} dari ${progress.total}…` : message.error ?? message.success ?? "Foto besar dikompresi otomatis."}
      </p>
      <button type="button" onClick={uploadAll} disabled={uploading || queue.length === 0} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
        {uploading ? "Mengunggah…" : `Unggah ${queue.length || ""} foto`}
      </button>
    </div>
  </div>;
}

/**
 * Two always-visible, independently-queued zones for Before/After (the
 * catalog's explicit requirement — previously one zone + a dropdown that
 * defaulted to "before"), plus a third zone for every other category via
 * the same selectable-dropdown mechanism the old single zone used.
 */
export function GroomingEvidenceForm({ bookingId, petJobId }: { bookingId: string; petJobId: string }) {
  const [otherCategory, setOtherCategory] = useState(otherCategories[0].value);
  return <div className="mt-3 space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <EvidenceUploadZone bookingId={bookingId} petJobId={petJobId} label="Sebelum" category={{ kind: "fixed", value: "before" }} />
      <EvidenceUploadZone bookingId={bookingId} petJobId={petJobId} label="Sesudah" category={{ kind: "fixed", value: "after" }} />
    </div>
    <EvidenceUploadZone bookingId={bookingId} petJobId={petJobId} label="Dokumentasi lainnya" category={{ kind: "selectable", options: otherCategories, value: otherCategory, onChange: setOtherCategory }} />
  </div>;
}

function DeleteEvidenceButton({ attachmentId }: { attachmentId: string }) {
  const [, action, pending] = useActionState(deleteGroomingEvidenceAction, initialState);
  return <form action={action} className="absolute right-1 top-1">
    <input type="hidden" name="attachmentId" value={attachmentId} />
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => { e.stopPropagation(); if (!window.confirm("Hapus foto ini?")) e.preventDefault(); }}
      className="rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white disabled:opacity-50"
    >{pending ? "..." : "✕"}</button>
  </form>;
}

export function GroomingEvidenceGallery({ evidence }: { evidence: Array<{ id: string; category: string; filename: string; url: string; createdAt: string }> }) {
  if (evidence.length === 0) return null;
  return <div className="mt-3">
    <p className="mb-2 text-xs font-bold text-slate-700">Foto tersimpan ({evidence.length})</p>
    <div className="grid grid-cols-3 gap-2">
      {evidence.map((item) => <div key={item.id} className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        <a href={item.url} target="_blank" rel="noreferrer" className="absolute inset-0">
          <Image src={item.url} alt={`${item.category}: ${item.filename}`} fill sizes="(max-width: 640px) 30vw, 160px" className="object-cover" />
        </a>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 px-1.5 py-1 text-[9px] font-bold capitalize text-white">{item.category} · {new Date(item.createdAt).toLocaleDateString("id-ID")}</span>
        <DeleteEvidenceButton attachmentId={item.id} />
      </div>)}
    </div>
  </div>;
}
