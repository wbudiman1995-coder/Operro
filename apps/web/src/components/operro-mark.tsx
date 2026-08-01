/**
 * Function index:
 * - OperroMark: compact accessible brand symbol used across public and authenticated layouts.
 */
export function OperroMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3" aria-label="Operro">
      <span className="relative grid size-10 place-items-center overflow-hidden rounded-xl bg-emerald-500 shadow-[0_10px_30px_rgba(16,185,129,0.28)]">
        <span className="absolute -right-2 -top-2 size-7 rounded-full bg-white/25" />
        <span className="relative text-lg font-black tracking-tight text-emerald-950">
          O
        </span>
      </span>
      {compact ? null : (
        <span className="text-lg font-bold tracking-[-0.03em]">Operro</span>
      )}
    </span>
  );
}
