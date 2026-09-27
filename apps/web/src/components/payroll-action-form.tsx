"use client";

import type { ReactNode } from "react";
import { useActionState } from "react";

import { ActionSubmitButton } from "@/components/action-submit-button";
import type { PilotActionState } from "@/app/payroll/payroll-actions";

const initialState: PilotActionState = { error: null, success: null };

export function PayrollActionForm({
  action, hidden, buttonLabel, pendingLabel, className, buttonClassName, confirmMessage, children,
}: {
  action: (previous: PilotActionState, formData: FormData) => Promise<PilotActionState>;
  hidden?: Record<string, string>;
  buttonLabel: string;
  pendingLabel?: string;
  className?: string;
  buttonClassName?: string;
  confirmMessage?: string;
  children?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, initialState);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={confirmMessage ? (event) => { if (!confirm(confirmMessage)) event.preventDefault(); } : undefined}
    >
      {hidden ? Object.entries(hidden).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />) : null}
      {children}
      <ActionSubmitButton
        pendingLabel={pendingLabel ?? "Memproses…"}
        className={buttonClassName ?? "rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-50"}
      >
        {buttonLabel}
      </ActionSubmitButton>
      {state.error || state.success ? (
        <p className={`mt-1 text-[11px] font-semibold ${state.error ? "text-rose-700" : "text-emerald-700"}`}>{state.error ?? state.success}</p>
      ) : null}
    </form>
  );
}
