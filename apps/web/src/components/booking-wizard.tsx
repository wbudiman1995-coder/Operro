"use client";

import { useActionState, useMemo, useState } from "react";

import { createBookingAction, type CreateBookingState } from "@/app/bookings/actions";
import type { AddressOption, BranchOption, CustomerOption, CustomerPackageOption, NextDiscountOption, PetOption, ResourceOption, ServiceAreaOption, ServiceOption } from "@/lib/bookings";
import type { FulfillmentMode } from "@/lib/booking-validation";

interface Props {
  branches: BranchOption[];
  customers: CustomerOption[];
  pets: PetOption[];
  services: ServiceOption[];
  resources: ResourceOption[];
  addresses: AddressOption[];
  serviceAreas: ServiceAreaOption[];
  nextDiscounts: NextDiscountOption[];
  customerPackages: CustomerPackageOption[];
  defaultStart: string;
  /**
   * Server-validated preselected customer. The page only passes a value after reading the
   * customer inside the active organization, so this is never a raw browser-supplied id.
   */
  preselectedCustomerId?: string;
}

interface PetSelection { petId: string; resourceId: string; serviceIds: string[]; packageByService: Record<string, string> }
interface SlotRecommendation {
  startsAt: string;
  endsAt: string;
  dateISO: string;
  startTime: string;
  endTime: string;
  travelKm: number | null;
  travelMinutes: number;
  trafficFactor: number;
  routeOrigin: "previous_stop" | "branch_base" | "unknown";
}
const initialState: CreateBookingState = { error: null };

function addMinutes(localDateTime: string, minutes: number) {
  const date = new Date(localDateTime);
  if (!Number.isFinite(date.valueOf())) return "";
  date.setMinutes(date.getMinutes() + minutes);
  const offset = date.getTimezoneOffset();
  return new Date(date.valueOf() - offset * 60_000).toISOString().slice(0, 16);
}

export function BookingWizard({ branches, customers, pets, services, resources, addresses, serviceAreas, nextDiscounts, customerPackages, defaultStart, preselectedCustomerId }: Props) {
  const [state, action, pending] = useActionState(createBookingAction, initialState);
  const [step, setStep] = useState(1);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  // Only honored when the id is actually in the loaded, organization-scoped option list,
  // so a stale or unauthorized value simply opens the wizard unselected.
  const initialCustomerId = preselectedCustomerId && customers.some((customer) => customer.id === preselectedCustomerId) ? preselectedCustomerId : "";
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [endsAt, setEndsAt] = useState(addMinutes(defaultStart, 60));
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("home");
  const [customerNotes, setCustomerNotes] = useState("");
  const [groomerNotes, setGroomerNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [categoryDiscounts, setCategoryDiscounts] = useState<Record<string, { type: "percent" | "fixed"; value: string }>>({});
  const [selectedPets, setSelectedPets] = useState<PetSelection[]>([]);
  const [customerAddressId, setCustomerAddressId] = useState(addresses.find((address) => address.customerId === initialCustomerId && address.isDefault)?.id ?? "");
  const [slotStatus, setSlotStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [slotError, setSlotError] = useState("");
  const [slotRecommendations, setSlotRecommendations] = useState<SlotRecommendation[]>([]);

  const customerPets = useMemo(() => pets.filter((pet) => pet.customerId === customerId), [customerId, pets]);
  const nextDiscount = nextDiscounts.find((offer) => offer.customerId === customerId);
  const customerAddresses = useMemo(() => addresses.filter((address) => address.customerId === customerId), [customerId, addresses]);
  const selectedAddress = customerAddresses.find((address) => address.id === customerAddressId);
  const branchAreas = serviceAreas.filter((area) => area.branchId === branchId);
  const matchedArea = selectedAddress ? branchAreas
    .filter((area) => area.kabupatenKota === selectedAddress.kabupatenKota && (area.kecamatan === null || area.kecamatan === selectedAddress.kecamatan))
    .sort((left, right) => Number(right.kecamatan !== null) - Number(left.kecamatan !== null))[0] : undefined;
  const coverage = !selectedAddress ? null : branchAreas.length === 0 ? { allowed: true, fee: 0, minutes: 0, unconfigured: true } : matchedArea ? { allowed: true, fee: matchedArea.travelFee, minutes: matchedArea.estimatedTravelMinutes, unconfigured: false } : { allowed: false, fee: 0, minutes: 0, unconfigured: false };
  const branchResources = resources.filter((resource) => resource.branchId === branchId);
  const selectedCategories = [...new Set(selectedPets.flatMap((pet) => pet.serviceIds.map((id) => services.find((service) => service.id === id)?.category).filter((value): value is string => Boolean(value))))];
  const duration = Math.max(60, ...selectedPets.flatMap((pet) => pet.serviceIds.map((id) => services.find((service) => service.id === id)?.durationMinutes ?? 60)));
  const payload = JSON.stringify({
    branchId, customerId, startsAt, endsAt, fulfillmentMode, customerNotes, groomerNotes, internalNotes, pets: selectedPets,
    categoryDiscounts: selectedCategories.flatMap((category) => { const rule = categoryDiscounts[category]; const value = Number(rule?.value); return rule && Number.isFinite(value) && value > 0 ? [{ category, type: rule.type, value }] : []; }),
    ...(fulfillmentMode === "home" && customerAddressId ? { customerAddressId } : {}),
  });

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setSelectedPets([]);
    const defaultAddress = addresses.find((address) => address.customerId === id && address.isDefault);
    setCustomerAddressId(defaultAddress?.id ?? "");
  }
  function togglePet(petId: string) {
    setSelectedPets((current) => current.some((pet) => pet.petId === petId) ? current.filter((pet) => pet.petId !== petId) : [...current, { petId, resourceId: branchResources[0]?.id ?? "", serviceIds: [], packageByService: {} }]);
  }
  function updatePet(petId: string, patch: Partial<PetSelection>) {
    setSelectedPets((current) => current.map((pet) => pet.petId === petId ? { ...pet, ...patch } : pet));
  }
  function toggleService(petId: string, serviceId: string) {
    const pet = selectedPets.find((candidate) => candidate.petId === petId);
    if (!pet) return;
    if (pet.serviceIds.includes(serviceId)) {
      const packageByService = { ...pet.packageByService }; delete packageByService[serviceId];
      updatePet(petId, { serviceIds: pet.serviceIds.filter((id) => id !== serviceId), packageByService });
    } else updatePet(petId, { serviceIds: [...pet.serviceIds, serviceId] });
  }
  function choosePackage(petId: string, serviceId: string, packageId: string) {
    const pet = selectedPets.find((candidate) => candidate.petId === petId); if (!pet) return;
    const packageByService = { ...pet.packageByService };
    if (packageId) packageByService[serviceId] = packageId; else delete packageByService[serviceId];
    updatePet(petId, { packageByService });
  }
  async function findRecommendedSlots() {
    setSlotStatus("loading");
    setSlotError("");
    setSlotRecommendations([]);
    try {
      const response = await fetch("/api/availability/slots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branchId,
          resourceIds: [...new Set(selectedPets.map((pet) => pet.resourceId).filter(Boolean))],
          durationMinutes: duration,
          fromDateISO: startsAt.slice(0, 10),
          destination: fulfillmentMode === "home" && selectedAddress && selectedAddress.latitude !== null && selectedAddress.longitude !== null
            ? { latitude: selectedAddress.latitude, longitude: selectedAddress.longitude }
            : null,
        }),
      });
      const result = await response.json() as { slots?: SlotRecommendation[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "slot_recommendations_failed");
      setSlotRecommendations(result.slots ?? []);
      setSlotStatus("ready");
    } catch (error) {
      console.error("slot_recommendations_request_failed", error);
      setSlotError("Slot terbaik belum dapat dimuat. Waktu tetap dapat dipilih secara manual.");
      setSlotStatus("error");
    }
  }
  function chooseRecommendedSlot(slot: SlotRecommendation) {
    setStartsAt(`${slot.dateISO}T${slot.startTime}`);
    setEndsAt(`${slot.dateISO}T${slot.endTime}`);
  }
  function canContinue() {
    if (step === 1) return Boolean(branchId && customerId && selectedPets.length);
    if (step === 2) return selectedPets.every((pet) => pet.serviceIds.length > 0 && pet.resourceId);
    if (step === 3) return Boolean(startsAt && endsAt && new Date(endsAt) > new Date(startsAt) && (fulfillmentMode !== "home" || (customerAddressId && coverage?.allowed)));
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
          {nextDiscount ? <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-900"><p className="font-bold">Diskon booking berikutnya aktif · {nextDiscount.label}</p><p className="mt-1">Akan diterapkan otomatis ke layanan yang cocok setelah booking berhasil dibuat.</p></div> : null}
          {customerId ? <div><p className="mb-2 text-sm font-semibold text-slate-700">Hewan</p><div className="grid gap-2 sm:grid-cols-2">{customerPets.map((pet) => <button type="button" key={pet.id} onClick={() => togglePet(pet.id)} className={`rounded-2xl border p-4 text-left transition ${selectedPets.some((item) => item.petId === pet.id) ? "border-emerald-500 bg-emerald-50" : "border-slate-200 hover:border-emerald-300"}`}><span className="font-bold">{pet.name}</span><span className="mt-1 block text-xs text-slate-500">{pet.breed ?? "Ras tidak dicatat"}</span></button>)}{customerPets.length === 0 ? <p className="text-sm text-slate-500">Pelanggan ini belum memiliki hewan aktif.</p> : null}</div></div> : null}
        </div> : null}

        {step === 2 ? <div className="space-y-6">
          <WizardTitle title="Layanan dan groomer" helper="Atur layanan dan groomer untuk setiap hewan." />
          {selectedPets.map((selection) => {
            const pet = pets.find((item) => item.id === selection.petId);
            return <section key={selection.petId} className="rounded-2xl border border-slate-200 p-4 sm:p-5">
              <h3 className="font-bold">{pet?.name}</h3>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">{services.map((service) => {
                const checked = selection.serviceIds.includes(service.id);
                const eligiblePackages = customerPackages.filter((item) => item.customerId === customerId && (item.serviceId === null || item.serviceId === service.id));
                return <div key={service.id} className={`rounded-xl border p-3 ${checked ? "border-emerald-200 bg-emerald-50/60" : "border-transparent bg-slate-50"}`}>
                  <label className="flex cursor-pointer items-start gap-3"><input type="checkbox" checked={checked} onChange={() => toggleService(selection.petId, service.id)} className="mt-1 accent-emerald-700" /><span><span className="block text-sm font-semibold">{service.name}</span><span className="text-xs text-slate-500">{service.category} · {service.durationMinutes} menit · {new Intl.NumberFormat("id-ID", { style: "currency", currency: service.currency, maximumFractionDigits: 0 }).format(service.basePrice)}</span></span></label>
                  {checked && eligiblePackages.length > 0 ? <label className="mt-3 block text-[11px] font-bold text-indigo-800">Bayar dengan paket
                    <select value={selection.packageByService[service.id] ?? ""} onChange={(event) => choosePackage(selection.petId, service.id, event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-indigo-200 bg-white px-2 text-xs text-slate-700">
                      <option value="">Tidak memakai paket</option>
                      {eligiblePackages.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.sessionsRemaining} sesi tersisa{item.expiresAt ? ` · s.d. ${new Date(item.expiresAt).toLocaleDateString("id-ID")}` : ""}</option>)}
                    </select>
                  </label> : null}
                </div>;
              })}</div>
              <Field label="Groomer"><select value={selection.resourceId} onChange={(event) => updatePet(selection.petId, { resourceId: event.target.value })} className="field"><option value="">Pilih groomer</option>{branchResources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></Field>
            </section>;
          })}
          {selectedCategories.length > 0 ? <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 sm:p-5">
            <h3 className="font-bold text-amber-950">Diskon per kategori (opsional)</h3>
            <p className="mt-1 text-xs leading-5 text-amber-800">Diskon disimpan sebagai snapshot booking dan diterapkan pada invoice. Layanan yang dibayar dengan paket tetap bernilai nol.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">{selectedCategories.map((category) => {
              const rule = categoryDiscounts[category] ?? { type: "percent" as const, value: "" };
              return <div key={category} className="rounded-xl border border-amber-200 bg-white p-3"><p className="text-xs font-bold text-slate-700">{category}</p><div className="mt-2 grid grid-cols-[110px_1fr] gap-2"><select value={rule.type} onChange={(event) => setCategoryDiscounts((current) => ({ ...current, [category]: { ...rule, type: event.target.value as "percent" | "fixed" } }))} className="h-9 rounded-lg border px-2 text-xs"><option value="percent">Persen</option><option value="fixed">Nominal</option></select><input type="number" min="0" max={rule.type === "percent" ? 100 : 1_000_000_000} step={rule.type === "percent" ? 1 : 1000} value={rule.value} onChange={(event) => setCategoryDiscounts((current) => ({ ...current, [category]: { ...rule, value: event.target.value } }))} placeholder={rule.type === "percent" ? "Contoh: 10" : "Contoh: 50000"} className="h-9 rounded-lg border px-2 text-xs" /></div></div>;
            })}</div>
          </section> : null}
        </div> : null}

        {step === 3 ? <div className="space-y-6">
          <WizardTitle title="Jadwal dan metode layanan" helper="Konflik jadwal groomer akan diperiksa kembali oleh database saat disimpan." />
          <div className="grid gap-4 sm:grid-cols-2"><Field label="Mulai"><input type="datetime-local" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); setEndsAt(addMinutes(event.target.value, duration)); }} className="field" /></Field><Field label="Selesai"><input type="datetime-local" value={endsAt} min={startsAt} onChange={(event) => setEndsAt(event.target.value)} className="field" /></Field></div>
          <Field label="Metode layanan"><div className="grid gap-2 sm:grid-cols-3">{([['home','Ke rumah'],['in_store','Di lokasi'],['pickup_delivery','Antar-jemput']] as const).map(([value,label]) => <button type="button" key={value} onClick={() => setFulfillmentMode(value)} className={`rounded-xl border px-3 py-3 text-sm font-semibold ${fulfillmentMode === value ? "border-emerald-500 bg-emerald-50 text-emerald-800" : "border-slate-200"}`}>{label}</button>)}</div></Field>
          {fulfillmentMode === "home" ? (
            <Field label="Alamat pelanggan">
              {customerAddresses.length === 0 ? (
                <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800">Pelanggan ini belum memiliki alamat tersimpan. Tambahkan alamat pada tab Alamat di Profil 360 pelanggan sebelum membuat booking home service.</p>
              ) : (
                <><select value={customerAddressId} onChange={(event) => setCustomerAddressId(event.target.value)} className="field">
                  <option value="">Pilih alamat</option>
                  {customerAddresses.map((address) => <option key={address.id} value={address.id}>{address.label} · {address.formattedLine}{address.isDefault ? " (utama)" : ""}</option>)}
                </select>
                {selectedAddress ? <div className={`mt-2 rounded-xl border p-3 text-xs ${coverage?.allowed ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
                  {coverage?.allowed ? <><p className="font-bold">Area dapat dilayani{coverage.unconfigured ? " · area cabang belum dibatasi" : ""}</p><p className="mt-1">Estimasi perjalanan {coverage.minutes} menit · biaya transport {new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(coverage.fee)}</p>{selectedAddress.latitude === null || selectedAddress.longitude === null ? <p className="mt-1 font-semibold text-amber-700">Koordinat belum lengkap. Tambahkan link Maps di Profil 360 agar perencanaan rute akurat.</p> : null}</> : <p className="font-bold">Alamat ini belum termasuk area layanan cabang yang dipilih.</p>}
                </div> : null}</>
              )}
            </Field>
          ) : null}
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="text-sm font-bold text-emerald-950">Rekomendasi slot 7 hari</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-emerald-800">Mencari waktu kosong bersama untuk semua groomer terpilih, lalu mengurutkannya berdasarkan jadwal dan estimasi perjalanan.</p></div>
              <button type="button" onClick={findRecommendedSlots} disabled={slotStatus === "loading" || selectedPets.some((pet) => !pet.resourceId)} className="h-10 rounded-xl bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-50">{slotStatus === "loading" ? "Mencari…" : "Cari slot terbaik"}</button>
            </div>
            {fulfillmentMode === "home" && selectedAddress && (selectedAddress.latitude === null || selectedAddress.longitude === null) ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">Slot tetap dapat dicari, tetapi peringkat rute belum akurat karena alamat ini belum memiliki koordinat Maps.</p> : null}
            {slotError ? <p role="alert" className="mt-3 text-xs font-semibold text-rose-700">{slotError}</p> : null}
            {slotStatus === "ready" && slotRecommendations.length === 0 ? <p className="mt-3 text-xs font-semibold text-slate-600">Tidak ada slot bersama yang tersedia dalam 7 hari. Ubah groomer, tanggal awal, atau waktu secara manual.</p> : null}
            {slotRecommendations.length > 0 ? <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{slotRecommendations.slice(0, 6).map((slot) => {
              const selected = startsAt === `${slot.dateISO}T${slot.startTime}`;
              const origin = slot.routeOrigin === "previous_stop" ? "dari kunjungan sebelumnya" : slot.routeOrigin === "branch_base" ? "dari cabang" : "rute belum tersedia";
              return <button type="button" key={slot.startsAt} onClick={() => chooseRecommendedSlot(slot)} className={`rounded-xl border p-3 text-left transition ${selected ? "border-emerald-600 bg-white ring-2 ring-emerald-200" : "border-emerald-100 bg-white hover:border-emerald-400"}`}>
                <span className="block text-sm font-bold text-slate-900">{new Date(`${slot.dateISO}T00:00:00`).toLocaleDateString("id-ID", { weekday: "short", day: "numeric", month: "short" })} · {slot.startTime}–{slot.endTime}</span>
                <span className="mt-1 block text-xs text-slate-600">{slot.travelKm === null ? "Jarak belum dihitung" : `${slot.travelKm} km · sekitar ${slot.travelMinutes} menit`} · {origin}</span>
                {slot.trafficFactor > 1.2 ? <span className="mt-2 inline-flex rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-800">Jam sibuk</span> : null}
              </button>;
            })}</div> : null}
          </section>
          <div className="grid gap-4 lg:grid-cols-3">
            <Field label="Catatan pelanggan"><textarea value={customerNotes} onChange={(event) => setCustomerNotes(event.target.value)} maxLength={1000} rows={4} className="field h-auto py-3" placeholder="Permintaan yang boleh terlihat dalam konteks pelanggan" /></Field>
            <Field label="Instruksi untuk groomer"><textarea value={groomerNotes} onChange={(event) => setGroomerNotes(event.target.value)} maxLength={1000} rows={4} className="field h-auto py-3" placeholder="Kondisi hewan, gaya, dan instruksi lapangan" /></Field>
            <Field label="Catatan internal"><textarea value={internalNotes} onChange={(event) => setInternalNotes(event.target.value)} maxLength={1000} rows={4} className="field h-auto py-3" placeholder="Hanya untuk operasional dan manajemen" /></Field>
          </div>
        </div> : null}

        {step === 4 ? <div className="space-y-6">
          <WizardTitle title="Periksa dan konfirmasi" helper="Booking akan langsung dikonfirmasi setelah semua bagian berhasil disimpan." />
          <dl className="grid gap-4 rounded-2xl bg-slate-50 p-5 sm:grid-cols-2"><Summary label="Pelanggan" value={customers.find((item) => item.id === customerId)?.name ?? "—"} /><Summary label="Hewan" value={selectedPets.map((item) => pets.find((pet) => pet.id === item.petId)?.name).join(", ")} /><Summary label="Mulai" value={new Date(startsAt).toLocaleString("id-ID")} /><Summary label="Metode" value={{home:"Ke rumah",in_store:"Di lokasi",pickup_delivery:"Antar-jemput"}[fulfillmentMode]} /><Summary label="Paket dialokasikan" value={`${selectedPets.reduce((count, pet) => count + Object.keys(pet.packageByService).length, 0)} layanan`} /><Summary label="Diskon kategori" value={selectedCategories.filter((category) => Number(categoryDiscounts[category]?.value) > 0).join(", ") || "Tidak ada"} />{nextDiscount ? <Summary label="Penawaran" value={`${nextDiscount.label} · otomatis satu kali`} /> : null}{fulfillmentMode === "home" ? <><Summary label="Alamat" value={selectedAddress?.formattedLine ?? "—"} /><Summary label="Perjalanan" value={coverage?.allowed ? `${coverage.minutes} menit · ${new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(coverage.fee)}` : "Di luar area layanan"} /></> : null}</dl>
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
