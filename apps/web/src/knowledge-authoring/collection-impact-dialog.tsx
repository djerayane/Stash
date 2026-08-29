import * as Dialog from "@radix-ui/react-dialog";
import type { RefObject, ReactNode } from "react";

import { Button } from "../ui/control";
import styles from "./collection-editor.module.css";

export interface CollectionImpactDialogProps {
  open: boolean;
  title: string;
  description: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  pending?: boolean;
  error?: string;
  confirmVariant?: "primary" | "secondary" | "danger";
  confirmDisabled?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}

export function CollectionImpactDialog({ open, title, description, children, confirmLabel, cancelLabel, pending, error,
  confirmVariant = "danger", confirmDisabled,
  returnFocusRef, onOpenChange, onConfirm }: CollectionImpactDialogProps) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className={styles.dialogOverlay} />
    <Dialog.Content className={styles.dialog} aria-describedby="collection-impact-description" onCloseAutoFocus={(event) => {
      if (!returnFocusRef?.current) return; event.preventDefault(); returnFocusRef.current.focus();
    }}><Dialog.Title>{title}</Dialog.Title><Dialog.Description id="collection-impact-description">{description}</Dialog.Description>
      <div className={styles.impactSummary}>{children}</div>{error ? <p className={styles.dialogError} role="alert">{error}</p> : null}
      <div className={styles.dialogActions}><Dialog.Close asChild><Button type="button" variant="secondary">{cancelLabel}</Button></Dialog.Close>
        <Button type="button" variant={confirmVariant} disabled={confirmDisabled} pending={pending} onClick={onConfirm}>{confirmLabel}</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
