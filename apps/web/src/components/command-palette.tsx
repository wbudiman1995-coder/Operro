"use client";

/**
 * Function index:
 * - CommandPalette: organization-scoped search launcher for the workspace shell.
 *
 * Latency controls: a minimum term length, a debounce, and cancellation of superseded
 * requests. Without the abort, a slow early keystroke can resolve after a later one and
 * overwrite fresher results.
 *
 * State shape: results are stored together with the term that produced them, so display
 * state is derived by comparing against the current input rather than cleared from inside
 * an effect. That keeps the effect free of synchronous setState (which triggers cascading
 * renders) and makes stale responses structurally unable to render.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SEARCH_MIN_TERM_LENGTH, type SearchGroup, type SearchGroupKey } from "@/lib/search";

const DEBOUNCE_MS = 250;

interface TermResult {
  term: string;
  groups: SearchGroup[];
  restrictedGroups: SearchGroupKey[];
}

const RESTRICTED_GROUP_LABELS: Record<SearchGroupKey, string> = {
  customers: "pelanggan",
  pets: "hewan",
  bookings: "booking",
  invoices: "invoice",
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [result, setResult] = useState<TermResult | null>(null);
  const [failedTerm, setFailedTerm] = useState<string | null>(null);
  const [requestedTerm, setRequestedTerm] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = term.trim();
  const groups = result && result.term === trimmed ? result.groups : null;
  const restrictedGroups = result && result.term === trimmed ? result.restrictedGroups : [];
  const failed = failedTerm === trimmed;
  const loading = requestedTerm === trimmed && groups === null && !failed;
  const tooShort = trimmed.length > 0 && trimmed.length < SEARCH_MIN_TERM_LENGTH;

  const flatHits = useMemo(() => (groups ?? []).flatMap((group) => group.hits), [groups]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    setTerm("");
    setResult(null);
    setFailedTerm(null);
    setRequestedTerm(null);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((previous) => !previous);
        return;
      }
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const pendingTerm = term.trim();
    if (pendingTerm.length < SEARCH_MIN_TERM_LENGTH) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRequestedTerm(pendingTerm);
      fetch(`/api/search?q=${encodeURIComponent(pendingTerm)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((payload: { groups?: SearchGroup[]; restrictedGroups?: SearchGroupKey[] }) => {
          setResult({
            term: pendingTerm,
            groups: Array.isArray(payload.groups) ? payload.groups : [],
            restrictedGroups: Array.isArray(payload.restrictedGroups) ? payload.restrictedGroups : [],
          });
          setActiveIndex(0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setFailedTerm(pendingTerm);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, open]);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (flatHits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % flatHits.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + flatHits.length) % flatHits.length);
    } else if (event.key === "Enter") {
      const hit = flatHits[activeIndex];
      if (hit) {
        event.preventDefault();
        close();
        window.location.assign(hit.href);
      }
    }
  }

  let cursor = -1;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-full items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-left text-sm font-semibold text-slate-400 transition hover:border-slate-300 hover:text-slate-600"
      >
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className="size-4 shrink-0 stroke-current" strokeWidth={1.8}>
          <circle cx="9" cy="9" r="5.5" />
          <path d="m13.5 13.5 3 3" strokeLinecap="round" />
        </svg>
        <span className="flex-1 truncate">Cari pelanggan, hewan, booking…</span>
        <kbd className="hidden rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-bold text-slate-400 sm:block">⌘K</kbd>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[8vh]" role="dialog" aria-modal="true" aria-label="Pencarian global">
          <button type="button" aria-label="Tutup pencarian" onClick={close} className="absolute inset-0 cursor-default bg-slate-950/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4">
              <svg viewBox="0 0 20 20" fill="none" aria-hidden className="size-4 shrink-0 stroke-slate-400" strokeWidth={1.8}>
                <circle cx="9" cy="9" r="5.5" />
                <path d="m13.5 13.5 3 3" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Nama pelanggan, nama hewan, nomor invoice…"
                aria-label="Kata kunci pencarian"
                className="h-14 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:font-medium placeholder:text-slate-400"
              />
            </div>
            <div className="max-h-[55vh] overflow-y-auto p-2" aria-live="polite">
              {trimmed.length === 0 ? <p className="px-3 py-6 text-center text-xs text-slate-400">Ketik untuk mencari di workspace ini.</p> : null}
              {tooShort ? <p className="px-3 py-6 text-center text-xs text-slate-400">Ketik minimal {SEARCH_MIN_TERM_LENGTH} huruf.</p> : null}
              {loading ? <p className="px-3 py-6 text-center text-xs text-slate-400">Mencari…</p> : null}
              {failed ? <p className="px-3 py-6 text-center text-xs font-semibold text-rose-600">Pencarian gagal. Coba lagi.</p> : null}
              {groups && flatHits.length === 0 ? <p className="px-3 py-6 text-center text-xs text-slate-400">Tidak ada hasil untuk “{trimmed}”.</p> : null}
              {groups && restrictedGroups.length > 0 ? (
                // Says which categories were withheld, so a partial result is not mistaken
                // for a complete one.
                <p className="mx-1 mt-1 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-4 text-slate-500">
                  Kategori {restrictedGroups.map((key) => RESTRICTED_GROUP_LABELS[key]).join(" dan ")} tidak dicari karena izin Anda terbatas.
                </p>
              ) : null}
              {groups
                ? groups.map((group) => (
                    <div key={group.key} className="mb-1">
                      <p className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-300">{group.label}</p>
                      {group.hits.map((hit) => {
                        cursor += 1;
                        const active = cursor === activeIndex;
                        return (
                          <Link
                            key={`${group.key}-${hit.id}`}
                            href={hit.href}
                            onClick={close}
                            className={`flex items-baseline justify-between gap-3 rounded-xl px-3 py-2.5 text-sm ${active ? "bg-emerald-50 text-emerald-900" : "text-slate-700 hover:bg-slate-50"}`}
                          >
                            <span className="truncate font-semibold">{hit.title}</span>
                            {hit.subtitle ? <span className="shrink-0 truncate text-xs text-slate-400">{hit.subtitle}</span> : null}
                          </Link>
                        );
                      })}
                    </div>
                  ))
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
