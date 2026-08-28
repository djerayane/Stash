import type { ButtonHTMLAttributes, HTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";

import styles from "./control.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  pending?: boolean;
  pendingLabel?: string;
}

function pendingAction(children: ReactNode) {
  if (typeof children !== "string") return "Working";
  if (children === "Save") return "Saving";
  if (children.startsWith("Save ")) return `Saving ${children.slice(5)}`;
  return `${children} in progress`;
}

export function Button({ variant = "primary", pending = false, pendingLabel, children, className, disabled, ...props }: ButtonProps) {
  return <button {...props} className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
    data-variant={variant} disabled={disabled || pending} aria-busy={pending || undefined}>{pending ? pendingLabel ?? pendingAction(children) : children}</button>;
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { label: string; }

export function IconButton({ label, className, type = "button", ...props }: IconButtonProps) {
  return <button {...props} type={type} aria-label={label} className={[styles.iconButton, className].filter(Boolean).join(" ")} />;
}

export interface FieldProps extends LabelHTMLAttributes<HTMLLabelElement> { label: string; hint?: string; children: ReactNode; }

export function Field({ label, hint, children, className, ...props }: FieldProps) {
  return <label {...props} className={[styles.field, className].filter(Boolean).join(" ")}><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

export function StatusNotice({ tone = "neutral", className, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: "neutral" | "success" | "attention" | "error" }) {
  return <div {...props} className={[styles.notice, styles[tone], className].filter(Boolean).join(" ")}
    role={tone === "error" ? "alert" : "status"} />;
}
