import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import styles from "./control.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  pending?: boolean;
  pendingLabel?: string;
}

export function Button({ variant = "primary", pending = false, pendingLabel = "Working", children, className, disabled, ...props }: ButtonProps) {
  return <button {...props} className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
    disabled={disabled || pending} aria-busy={pending || undefined}>{pending ? pendingLabel : children}</button>;
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { label: string; }

export function IconButton({ label, className, type = "button", ...props }: IconButtonProps) {
  return <button {...props} type={type} aria-label={label} className={[styles.iconButton, className].filter(Boolean).join(" ")} />;
}

export interface FieldProps { label: string; hint?: string; children: ReactNode; }

export function Field({ label, hint, children }: FieldProps) {
  return <label className={styles.field}><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

export function StatusNotice({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: "neutral" | "success" | "attention" | "error" }) {
  return <div {...props} className={[styles.notice, styles[tone], className].filter(Boolean).join(" ")}
    role={tone === "error" ? "alert" : "status"} />;
}
