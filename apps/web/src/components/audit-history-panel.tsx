import type { AuditEvent } from "@/lib/audit-events";

export function AuditHistoryPanel({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 text-sm print:hidden">
      <h2 className="text-xs font-bold uppercase text-slate-400">Riwayat perubahan</h2>
      <ul className="mt-3 space-y-2">
        {events.map((event) => (
          <li key={event.id} className="border-b border-slate-100 pb-2 text-xs text-slate-600 last:border-0">
            <span className="font-bold text-slate-800">{event.actionLabel}</span> oleh {event.actorName} &middot; {new Date(event.occurredAt).toLocaleString("id-ID")}
            {event.changedFields.length > 0 ? <span className="mt-0.5 block text-slate-400">Kolom: {event.changedFields.join(", ")}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
