"use client";

/** Submit button that acknowledges server actions immediately and blocks duplicate clicks. */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

interface ActionSubmitButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  pendingLabel?: string;
}

export function ActionSubmitButton({
  children,
  disabled,
  pendingLabel = "Memproses…",
  ...props
}: ActionSubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button {...props} disabled={disabled || pending} aria-disabled={disabled || pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
