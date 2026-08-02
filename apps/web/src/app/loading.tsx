/** Immediate visual feedback while authenticated routes stream fresh data. */
export default function Loading() {
  return (
    <div className="min-h-screen animate-pulse bg-[#f6f8f7] text-slate-950">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-5 lg:block">
        <div className="h-9 w-28 rounded-xl bg-slate-200" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index} className="h-11 rounded-xl bg-slate-100" />
          ))}
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="h-[81px] border-b border-slate-200 bg-white px-7 py-4">
          <div className="mx-auto flex h-full max-w-7xl items-center justify-between">
            <div className="h-9 w-36 rounded-xl bg-slate-100" />
            <div className="h-11 w-full max-w-sm rounded-xl bg-slate-100" />
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-10 sm:px-7">
          <div className="h-4 w-32 rounded bg-emerald-100" />
          <div className="mt-4 h-10 w-72 max-w-full rounded-xl bg-slate-200" />
          <div className="mt-3 h-5 w-[32rem] max-w-full rounded bg-slate-100" />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-32 rounded-2xl border border-slate-200 bg-white" />
            ))}
          </div>
          <div className="mt-7 h-80 rounded-3xl border border-slate-200 bg-white" />
        </main>
      </div>
    </div>
  );
}
