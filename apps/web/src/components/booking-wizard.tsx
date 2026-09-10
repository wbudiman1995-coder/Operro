"use client";

import { useActionState, useMemo, useState } from "react";

import { createBookingAction, type CreateBookingState } from "@/app/bookings/actions";
import type { BranchOption, CustomerOption, PetOption, ResourceOption, ServiceOption } from "@/lib/bookings";
import type { FulfillmentMode } from "@/lib/booking-validation";

interface Props {
  branches: BranchOption[];
  customers: CustomerOption[];
  pets: PetOption[];
  services: ServiceOption[];
  resources: ResourceOption[];
  defaultStart: string;
  /**
   * Server-validated preselected customer. The page only passes a value after reading the
   * customer inside the active organization, so this is never a raw browser-supplied id.
   */
  preselectedCustomerId?: string;
}

interface PetSelection { petId: string; resourceId: string; serviceIds: string[] }
const initialState: CreateBookingState = { error: null };

function addMinutes(localDateTime: string, minutes: number) {
  const date = new Date(localDateTime);
  if (!Number.isFinite(date.valueOf())) return "";
  date.setMinutes(date.getMinutes() + minutes);
  const offset = date.getTimezoneOffset();
  return new Date(date.valueOf() - offset * 60_000).toISOString().slice(0, 16);
}

export function BookingWizard({ branches, customers, pets, services, resources, defaultStart, preselectedCustomerId }: Props) {
  const [state, action, pending] = useActionState(createBookingAction, initialState);
  const [step, setStep] = useState(1);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  // Only honored when the id is actually in the loaded, organization-scoped option list,
  // so a stale or unauthorized value simply opens the wizard unselected.
  const [customerId, setCustomerId] = useState(
    preselectedCustomerId && customers.some((customer) => customer.id === preselectedCustomerId) ? preselectedCustomerId : "",
  );
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [endsAt, setEndsAt] = useState(addMinutes(defaultStart, 60));
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("home");
  const [notes, setNotes] = useState("");
  const [selectedPets, setSelectedPets] = useState<PetSelection[]>([]);

  const customerPets = useMemo(() => pets.filter((pet) => pet.customerId === customerId), [customerId, pets]);
  const branchResources = resources.filter((resource) => resource.branchId === branchId);
  const duration = Math.max(60, ...selectedPets.flatMap((pet) => pet.serviceIds.map((id) => services.find((service) => service.id === id)?.durationMinutes ?? 60)));
  const payload = JSON.stringify({ branchId, customerId, startsAt, endsAt, fulfillmentMode, notes, pets: selectedPets });

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setSelectedPets([]);
  }
  function togglePet(petId: string) {
    setSelectedPets((current) => current.some((pet) => pet.petId === petId) ? current.filter((pet) => pet.petId !== petId) : [...current, { petId, resourceId: branchResources[0]?.id ?? "", serviceIds: [] }]);
  }
  function updatePet(petId: string, patch: Partial<PetSelection>) {
    setSelectedPets((current) => current.map((pet) => pet.petId === petId ? { ...pet, ...patch } : pet));
  }
  function toggleService(petId: string, serviceId: string) {
    const pet = selectedPets.find((candidate) => candidate.petId === petId);
    if (!pet) return;
    updatePet(petId, { serviceIds: pet.serviceIds.includes(serviceId) ? pet.serviceIds.filter((id) => id !== serviceId) : [...pet.serviceIds, serviceId] });
  }
  function canContinue() {
    if (step === 1) return Boolean(branchId && customerId && selectedPets.length);
    if (step === 2) return selectedPets.every((pet) => pet.serviceIds.length > 0 && pet.resourceId);
    if (step === 3) return Boolean(startsAt && endsAt && new Date(endsAt) > new Date(startsAt));
    return true;
  }

  return (
    <form action={action} className="rounded-3xl border border-slate-200 bg-white shadow-sm">
      <input type="hidden" name="booking" value={payload} />
      <div className="border-b border-slate-100 p-5 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[0.15em] text-emerald-700">Booking baru</p><h2 className="mt-1 text-xl font-bold">Langkah {step} dari 4</h2></div>
          <div className="flex gap-1.5" aria-label={`Langkah ${step} dari 4`}>{[1,2,3,4].map((number) => <span key={number} className={`h-2 w-8 rounded-full ${number <= step ? "bg-emerald-600" : "bg-slate-200"}`} />)}</div>
        </div>
      </div>

      <div className="min-h-[420px] p-5 sm:p-7">
        {step === 1 ? <div className="space-y-6">
          <WizardTitle title="Pelanggan dan hewan" helper="Pilih satu pelanggan, lalu satu atau beberapa hewan dalam booking yang sama." />
          <Field label="Cabang"><select value={branchId} onChange={(event) => { setBranchId(event.target.value); setSelectedPets((current) => current.map((pet) => ({ ...pet, resourceId: "" }))); }} className="field"><option value="">Pilih cabang</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></Field>
          <Field label="Pelanggan"><select value={customerId} onChange={(event) => chooseCustomer(event.target.value)} className="field"><option value="">Pilih pelanggan</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ""}</option>)}</select></Field>
          {customerId ? <div><p className="mb-2 text-sm font-semibold text-slate-700">Hewan</p><div className="grid gap-2 sm:grid-cols-2">{customerPets.map((pet) => <button type="button" key={pet.id} onClick={() => togglePet(pet.id)} className={`rounded-2xl border p-4 text-left transition ${selectedPets.some((item) => item.petId === pet.id) ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:border-emerald-300"}`}><span className="font-bold">{pet.name}</span><span className="mt-1 block text-xs text-slate-500">{pet.breed ?? "Ras tidak dicatat"}</span></button>)}{customerPets.length === 0 ? <p className="text-sm text-slate-500">Pelanggan ini belum memiliki hewan aktif.</p> : null}</div></div> : null}
        </div> : null}

        {step === 2 ? <div className="space-y-6">
          <WizardTitle title="Layanan dan groomer" helper="Atur layanan dan groomer untuk setiap hewan." />
          {selectedPets.map((selection) => { const pet = pets.find((item) => item.id === selection.petId); return <section key={selection.petId} className="rounded-2xl border border-slate-200 p-4 sm:p-5"><h3 className="font-bold">{pet?.name}</h3><div className="mt-4 grid gap-2 sm:grid-cols-2">{services.map((service) => <label key={service.id} className="flex cursor-pointer items-start gap-3 rounded-xl bg-slate-50 p-3"><input type="checkbox" checked={selection.serviceIds.includes(service.id)} onChange={() => toggleService(selection.petId, service.id)} className="mt-1 accent-emerald-700" /><span><span className="block text-sm font-semibold">{service.name}</span><span className="text-xs text-slate-500">{service.durationMinutes} menit · {new Intl.NumberFormat("id-ID", { style: "currency", currency: service.currency, maximumFractionDigits: 0 }).format(service.basePrice)}</span></span></label>)}</div><Field label="Groomer"><select value={selection.resourceId} onChange={(event) => updatePet(selection.petId, { resourceId: event.target.value })} className="field"><option value="">Pilih groomer</option>{branchResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></Field></section>; })}
        </div> : null}

        {step === 3 ? <div className="space-y-6">
          <WizardTitle title="Jadwal dan metode layanan" helper="Konflik jadwal groomer akan diperiksa kembali oleh database saat disimpan." />
          <div className="grid gap-4 sm:grid-cols-2"><Field label="Mulai"><input type="datetime-local" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); setEndsAt(addMinutes(event.target.value, duration)); }} className="field" /></Field><Field label="Selesai"><input type="datetime-local" value={endsAt} min={startsAt} onChange={(event) => setEndsAt(event.target.value)} className="field" /></Field></div>
          <Field label="Metode layanan"><div className="grid gap-2 sm:grid-cols-3">{([['home','Ke rumah'],['in_store','Di lokasi'],['pickup_delivery','Antar-jemput']] as const).map(([value,label]) => <button type="button" key={value} onClick={() => setFulfillmentMode(value)} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${fulfillmentMode === value ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200"}`}>{label}</button>)}</div></Field>
          <Field label="Catatan (opsional)"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={4} className="field h-auto py-3" placeholder="Instruksi operasional yang aman dan relevan" /></Field>
        </div> : null}

        {step === 4 ? <div className="space-y-6">
          <WizardTitle title="Periksa dan konfirmasi" helper="Booking akan langsung dikonfirmasi setelah semua bagian berhasil disimpan." />
          <dl className="grid gap-4 rounded-2xl bg-slate-50 p-5 sm:grid-cols-2"><Summary label="Pelanggan" value={customers.find((item) => item.id === customerId)?.name ?? "—"} /><Summary label="Hewan" value={selectedPets.map((item) => pets.find((pet) => pet.id === item.petId)?.name).join(", ")} /><Summary label="Mulai" value={new Date(startsAt).toLocaleString("id-ID")} /><Summary label="Metode" value={{home:"Ke rumah",in_store:"Di lokasi",pickup_delivery:"Antar-jemput"}[fulfillmentMode]} /></dl>
          {state.error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">{state.error}</p> : null}
        </div> : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-5 sm:p-7">
        <button type="button" disabled={step === 1 || pending} onClick={() => setStep((current) => Math.max(1, current - 1))} className="h-11 rounded-xl border border-slate-200 px-5 text-sm font-semibold disabled:opacity-40">Kembali</button>
        {step < 4 ? <button type="button" disabled={!canContinue()} onClick={() => setStep((current) => Math.min(4, current + 1))} className="h-11 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white disabled:opacity-40">Lanjutkan</button> : <button type="submit" disabled={pending} className="h-11 rounded-xl bg-emerald-700 px-5 text-sm font-bold text-white disabled:opacity-60">{pending ? "Menyimpan…" : "Konfirmasi booking"}</button>}
      </div>
    </form>
  );
}

function WizardTitle({ title, helper }: { title: string; helper: string }) { return <div><h3 className="text-lg font-bold">{title}</h3><p className="mt-1 text-sm leading-6 text-slate-500">{helper}</p></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="mt-4 block text-sm font-semibold text-slate-700">{label}<span className="mt-2 block">{children}</span></label>; }
function Summary({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-bold uppercase tracking-wide text-slate-400">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-800">{value || "—"}</dd></div>; }
