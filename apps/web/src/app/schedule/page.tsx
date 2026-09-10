/** Dispatcher calendar route — the daily control loop surface for Batch 1A. */
import { PageHeader } from "@/components/pilot-ui";
import { RestrictedNotice } from "@/components/restricted-notice";
import { ScheduleBoard } from "@/components/schedule-board";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadBranchAccess, loadCapabilities } from "@/lib/authorization";
import { parseScheduleView } from "@/lib/schedule-layout";
import { NoAccessibleBranchError, loadBookingDetail, loadScheduleWorkspace } from "@/lib/schedule";
import { requireActiveWorkspace } from "@/lib/require-workspace";
import { isValidDateISO, zonedDayISO } from "@/lib/timezone";

export const metadata = { title: "Kalender" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asStringArray(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; branch?: string | string[]; groomer?: string | string[]; booking?: string | string[] }>;
}) {
  const params = await searchParams;
  const workspace = await requireActiveWorkspace();
  const organizationId = workspace.activeOrganization.id;

  const [capabilities, branchAccess] = await Promise.all([
    loadCapabilities(workspace.supabase),
    loadBranchAccess(workspace.supabase, organizationId, workspace.activeOrganization.membershipId),
  ]);

  const header = (
    <PageHeader
      eyebrow="Kalender operasional"
      title="Kalender dispatcher"
      description="Lihat beban kerja per groomer, cek detail booking, dan pantau ketersediaan tim dalam satu tampilan."
    />
  );

  // booking.read gates the whole surface. Without it RLS would return an empty calendar,
  // which would read as "no bookings today" rather than "you cannot see bookings".
  if (!capabilities["booking.read"]) {
    return (
      <WorkspaceShell {...workspace} activePath="/schedule">
        {header}
        <div className="mt-7">
          <RestrictedNotice
            title="Tidak ada izin melihat booking"
            description="Peran Anda pada workspace ini tidak memiliki izin booking.read, sehingga kalender tidak dapat ditampilkan. Hubungi pemilik workspace bila Anda membutuhkan akses."
          />
        </div>
      </WorkspaceShell>
    );
  }

  const view = parseScheduleView(firstValue(params.view));
  const branchParam = firstValue(params.branch);
  const branchId = branchParam && UUID_PATTERN.test(branchParam) ? branchParam : undefined;
  const groomerIds = asStringArray(params.groomer).filter((id) => UUID_PATTERN.test(id));
  const bookingParam = firstValue(params.booking);
  const bookingId = bookingParam && UUID_PATTERN.test(bookingParam) ? bookingParam : null;
  const anchorCandidate = firstValue(params.date);

  let data;
  try {
    // First pass resolves the accessible branch, and with it the branch time zone that
    // "today" must be computed in. The zone cannot be known before the branch is chosen.
    data = await loadScheduleWorkspace(workspace.supabase, organizationId, branchAccess, {
      view,
      anchorISO: isValidDateISO(anchorCandidate) ? anchorCandidate : zonedDayISO(new Date(), "UTC"),
      branchId,
      resourceIds: groomerIds,
    });
  } catch (error) {
    if (!(error instanceof NoAccessibleBranchError)) throw error;
    return (
      <WorkspaceShell {...workspace} activePath="/schedule">
        {header}
        <div className="mt-7">
          <RestrictedNotice
            title="Tidak ada cabang yang dapat diakses"
            description="Keanggotaan Anda belum diberi akses ke cabang mana pun pada workspace ini. Minta pemilik workspace menambahkan akses cabang."
          />
        </div>
      </WorkspaceShell>
    );
  }

  const todayISO = zonedDayISO(new Date(), data.activeBranch.timezone);
  const resolvedAnchor = isValidDateISO(anchorCandidate) ? anchorCandidate : todayISO;
  const resolved =
    resolvedAnchor === data.days[0] || isValidDateISO(anchorCandidate)
      ? data
      : await loadScheduleWorkspace(workspace.supabase, organizationId, branchAccess, {
          view,
          anchorISO: resolvedAnchor,
          branchId,
          resourceIds: groomerIds,
        });

  // Detail is bound to the resolved active branch, so a booking id from another branch
  // cannot be opened through the query string.
  const detail = bookingId
    ? await loadBookingDetail(workspace.supabase, organizationId, resolved.activeBranch.id, bookingId, resolved.activeBranch.timezone)
    : null;

  return (
    <WorkspaceShell {...workspace} activePath="/schedule">
      {header}
      <ScheduleBoard
        data={resolved}
        view={view}
        anchorISO={resolvedAnchor}
        todayISO={todayISO}
        detail={detail}
        canReadFinance={capabilities["finance.read"]}
        canUpdateBooking={capabilities["booking.update"]}
        canCancelBooking={capabilities["booking.cancel"]}
        canManageResources={capabilities["resource.manage"]}
      />
    </WorkspaceShell>
  );
}
