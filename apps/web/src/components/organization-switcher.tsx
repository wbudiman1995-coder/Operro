"use client";

/**
 * Function index:
 * - OrganizationSwitcher: renders card or compact organization choices.
 * - switchOrganization: invokes the controlled RPC, refreshes the session, and verifies active_org_id.
 * - getSwitchErrorMessage: maps stable backend errors to safe user-facing copy.
 */
import { type ChangeEvent, useState } from "react";
import { useRouter } from "next/navigation";

import { BuildingIcon, ChevronIcon } from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import type { AccessibleOrganization } from "@/lib/organizations";

interface OrganizationSwitcherProps {
  organizations: readonly AccessibleOrganization[];
  activeOrganizationId: string | null;
  variant?: "cards" | "compact";
}

function getSwitchErrorMessage(message: string): string {
  if (message.includes("authentication_required")) {
    return "Sesi Anda sudah berakhir. Silakan masuk kembali.";
  }

  if (message.includes("organization_id_required")) {
    return "Pilih organisasi yang ingin dibuka.";
  }

  if (message.includes("active_user_profile_not_found")) {
    return "Profil Operro Anda tidak aktif. Hubungi administrator.";
  }

  if (message.includes("organization_membership_not_available")) {
    return "Akses ke organisasi ini sudah tidak tersedia.";
  }

  return "Organisasi belum berhasil dipilih. Silakan coba lagi.";
}

export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
  variant = "cards",
}: OrganizationSwitcherProps) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(
    activeOrganizationId ?? organizations[0]?.id ?? "",
  );
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function switchOrganization(organizationId: string) {
    if (!organizationId || switchingId) {
      return;
    }

    setError("");
    setSwitchingId(organizationId);

    try {
      const supabase = createClient();
      const { data: selectedOrganizationId, error: rpcError } =
        await supabase.rpc("set_active_organization", {
          p_organization_id: organizationId,
        });

      if (rpcError || selectedOrganizationId !== organizationId) {
        setError(
          getSwitchErrorMessage(
            rpcError?.message ?? "organization_switch_result_mismatch",
          ),
        );
        setSwitchingId(null);
        return;
      }

      const { data: refreshData, error: refreshError } =
        await supabase.auth.refreshSession();

      if (refreshError || !refreshData.session) {
        setError(
          "Organisasi tersimpan, tetapi sesi baru gagal dibuat. Silakan coba lagi.",
        );
        setSwitchingId(null);
        return;
      }

      const { data: claimsData, error: claimsError } =
        await supabase.auth.getClaims(refreshData.session.access_token);
      const refreshedClaim = claimsData?.claims?.active_org_id;

      if (
        claimsError ||
        typeof refreshedClaim !== "string" ||
        refreshedClaim !== organizationId
      ) {
        setError(
          "Sesi belum mengonfirmasi organisasi yang dipilih. Akses dashboard dibatalkan demi keamanan.",
        );
        setSwitchingId(null);
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Koneksi ke Operro gagal. Periksa jaringan lalu coba lagi.");
      setSwitchingId(null);
    }
  }

  if (variant === "compact") {
    return (
      <div className="w-full">
        <div className="flex items-center gap-2">
          <label htmlFor="organization-switcher" className="sr-only">
            Pilih organisasi aktif
          </label>
          <div className="relative min-w-0 flex-1">
            <select
              id="organization-switcher"
              value={selectedId}
              disabled={Boolean(switchingId)}
              onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                setSelectedId(event.target.value)
              }
              className="h-11 w-full appearance-none truncate rounded-xl border border-slate-200 bg-white pl-3 pr-9 text-sm font-semibold text-slate-800 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10 disabled:opacity-60"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
            <ChevronIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 rotate-90 text-slate-400" />
          </div>
          <button
            type="button"
            disabled={Boolean(switchingId) || selectedId === activeOrganizationId}
            onClick={() => void switchOrganization(selectedId)}
            className="h-11 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {switchingId ? "Memuat…" : "Ganti"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-xs leading-5 text-rose-600">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-2">
        {organizations.map((organization) => {
          const isActive = organization.id === activeOrganizationId;
          const isSwitching = switchingId === organization.id;

          return (
            <button
              key={organization.id}
              type="button"
              disabled={Boolean(switchingId)}
              onClick={() => void switchOrganization(organization.id)}
              className="group flex min-h-36 w-full items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-xl hover:shadow-emerald-950/5 focus:outline-none focus:ring-4 focus:ring-emerald-500/15 disabled:cursor-wait disabled:opacity-60"
            >
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700 transition group-hover:bg-emerald-100">
                <BuildingIcon className="size-6" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-base font-bold text-slate-950">
                    {organization.name}
                  </span>
                  {isActive ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700">
                      Aktif
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-sm text-slate-500">
                  {organization.vertical
                    ? organization.vertical.replaceAll("_", " ")
                    : "Bisnis layanan"}
                  {" · "}
                  {organization.status === "trial" ? "Masa uji coba" : "Aktif"}
                </span>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-emerald-700">
                  {isSwitching ? "Menyiapkan dashboard…" : "Buka workspace"}
                  <ChevronIcon className="size-4 transition group-hover:translate-x-0.5" />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-700"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
