"use client";

/** Client-only mutation buttons for one payment-register row — split out of
 * payment-register.tsx so that component can be a plain server component
 * (the filter bar/pagination are just links/a GET form; no client state
 * needed for those once the register is server-paginated). */
import { useActionState } from "react";

import { confirmPaymentScreenshotAction, validatePaymentBankAccountAction } from "@/app/payment-actions";
import type { PaymentActionState } from "@/app/payment-actions";

const initialState: PaymentActionState = { error: null, success: null };

export function ConfirmButton({ paymentId }: { paymentId: string }) {
  const [state, action, pending] = useActionState(confirmPaymentScreenshotAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="paymentId" value={paymentId} />
    <button className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Konfirmasi screenshot"}</button>
    {state.error ? <p className="text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
  </form>;
}

export function ValidateButton({ paymentId }: { paymentId: string }) {
  const [state, action, pending] = useActionState(validatePaymentBankAccountAction, initialState);
  return <form action={action} className="inline-flex flex-col items-end gap-1">
    <input type="hidden" name="paymentId" value={paymentId} />
    <button className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60" disabled={pending}>{pending ? "..." : "Validasi rekening"}</button>
    {state.error ? <p className="text-[10px] font-semibold text-rose-600">{state.error}</p> : null}
  </form>;
}
