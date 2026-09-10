/**
 * Function index:
 * - RestrictedNotice: explicit "you do not have access" state for a permission-gated surface.
 *
 * Row level security answers an unauthorized read with an empty set. Rendering that as an
 * ordinary empty state tells the user the data does not exist, which is a different and
 * misleading claim. This component states the real reason.
 */
export function RestrictedNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-6 py-10 text-center">
      <span aria-hidden className="mx-auto grid size-9 place-items-center rounded-full bg-slate-200 text-slate-500">
        <svg viewBox="0 0 20 20" fill="none" className="size-4 stroke-current" strokeWidth={1.8}>
          <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
          <path d="M7.5 8.5V6.5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
        </svg>
      </span>
      <p className="mt-3 font-bold text-slate-700">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Akses dibatasi, bukan data kosong</p>
    </div>
  );
}
