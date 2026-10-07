import type { AuditEvent } from "@/lib/audit-events";
import { formatZonedDateTime } from "@/lib/timezone";

export function AuditHistoryPanel({ events, title = "Riwayat perubahan", emptyMessage, timeZone }: { events: AuditEvent[]; title?: string; emptyMessage?: string; timeZone?: string }) {
  if (events.length === 0 && !emptyMessage) return null;
  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 text-sm print:hidden">
      <h2 className="text-xs font-bold uppercase text-slate-400">{title}</h2>
      {events.length === 0 ? <p className="mt-3 text-xs text-slate-500">{emptyMessage}</p> : <ul className="mt-3 space-y-2">
        {events.map((event) => (
          <li key={event.id} className="border-b border-slate-100 pb-2 text-xs text-slate-600 last:border-0">
            <span className="font-bold text-slate-800">{event.actionLabel}</span> oleh {event.actorName} &middot; {timeZone ? formatZonedDateTime(event.occurredAt, timeZone) : new Date(event.occurredAt).toLocaleString("id-ID")}
            {event.changedFields.length > 0 ? <span className="mt-0.5 block text-slate-400">Kolom: {event.changedFields.join(", ")}</span> : null}
          </li>
        ))}
      </ul>}
    </section>
  );
}
