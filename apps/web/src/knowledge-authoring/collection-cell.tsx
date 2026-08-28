import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CollectionProperty, CollectionPropertyValue } from "@stash/domain-types";

import styles from "./collection-editor.module.css";

export type CollectionCellDraft = string | boolean | string[];

export function collectionValueDraft(property: CollectionProperty, value?: CollectionPropertyValue): CollectionCellDraft {
  if (property.type === "checkbox") return value === true;
  if (property.type === "multi_select") return Array.isArray(value) ? value.map(String) : [];
  if (property.type === "date_time" && value && typeof value === "object" && !Array.isArray(value) && "start" in value)
    return value.start.length > 10 ? value.start.slice(0, 16) : value.start;
  if (property.type === "relation" && Array.isArray(value)) return value.map((entry) => typeof entry === "string"
    ? entry : `${entry.id} | ${entry.fallback}`).join(", ");
  if ((property.type === "person" || property.type === "attachment") && Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

export function collectionDraftValue(property: CollectionProperty, raw: CollectionCellDraft): CollectionPropertyValue {
  if (property.type === "checkbox") return raw === true;
  if (property.type === "multi_select") return Array.isArray(raw) ? raw : [];
  const value = String(raw).trim();
  if (property.type === "number") return value ? Number(value) : null;
  if (property.type === "date_time") return value ? { start: new Date(value).toISOString(), includeTime: value.includes("T") } : null;
  if (property.type === "single_select" || property.type === "url") return value || null;
  if (property.type === "person" || property.type === "attachment") return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
  if (property.type === "relation") return value ? value.split(",").map((entry) => { const [identity, ...fallback] = entry.split("|");
    return { id: identity!.trim(), fallback: fallback.join("|").trim() || identity!.trim() }; }) : [];
  return value;
}

interface DraftControlProps {
  property: CollectionProperty;
  value: CollectionCellDraft;
  label: string;
  autoFocus?: boolean;
  onChange(value: CollectionCellDraft): void;
  onConfirm?(): void;
  onCancel?(): void;
  onNavigate?(direction: "left" | "right" | "up" | "down"): void;
}

export function CollectionDraftControl({ property, value, label, autoFocus, onChange, onConfirm, onCancel, onNavigate }: DraftControlProps) {
  const controlRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  useEffect(() => { if (autoFocus) controlRef.current?.focus(); }, [autoFocus]);
  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); return; }
    if (event.key === "Enter" && onConfirm && property.type !== "multi_select") { event.preventDefault(); onConfirm(); return; }
    if (!onNavigate || !event.key.startsWith("Arrow")) return;
    const direction = event.key.slice(5).toLowerCase() as "left" | "right" | "up" | "down";
    if (event.currentTarget instanceof HTMLInputElement && (direction === "left" || direction === "right")) {
      const atStart = event.currentTarget.selectionStart === 0; const atEnd = event.currentTarget.selectionEnd === event.currentTarget.value.length;
      if (direction === "left" && !atStart || direction === "right" && !atEnd) return;
    }
    if (event.currentTarget instanceof HTMLInputElement && event.currentTarget.type === "number" && (direction === "up" || direction === "down")) return;
    event.preventDefault(); onNavigate(direction);
  };
  if (property.type === "checkbox") return <input ref={controlRef as React.RefObject<HTMLInputElement>} aria-label={label} checked={value === true}
    type="checkbox" onChange={(event) => onChange(event.target.checked)} onKeyDown={keyDown} />;
  if (property.type === "single_select") return <select ref={controlRef as React.RefObject<HTMLSelectElement>} aria-label={label} value={String(value)}
    onChange={(event) => onChange(event.target.value)} onKeyDown={keyDown}><option value="">No value</option>
    {property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
  if (property.type === "multi_select") return <select ref={controlRef as React.RefObject<HTMLSelectElement>} aria-label={label} multiple
    value={Array.isArray(value) ? value : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions).map(({ value }) => value))}
    onKeyDown={keyDown}>{property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
  const type = property.type === "number" ? "number" : property.type === "date_time" ? "datetime-local" : property.type === "url" ? "url" : "text";
  return <input ref={controlRef as React.RefObject<HTMLInputElement>} aria-label={label} type={type} value={String(value)}
    placeholder={property.type === "relation" ? "Identity | readable name" : undefined}
    onChange={(event) => onChange(event.target.value)} onKeyDown={keyDown} />;
}

export function CollectionCell({ property, value, recordLabel, editable, onSave, onNavigate }: {
  property: CollectionProperty; value?: CollectionPropertyValue; recordLabel: string; editable: boolean;
  onSave(value: CollectionPropertyValue): Promise<void>;
  onNavigate(direction: "left" | "right" | "up" | "down"): void;
}) {
  const saved = collectionValueDraft(property, value); const [draft, setDraft] = useState<CollectionCellDraft>(saved);
  const [saving, setSaving] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { if (!failed) setDraft(saved); }, [failed, property.id, value]);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => { if (!changed || saving) return; setSaving(true); setFailed(false);
    try { await onSave(collectionDraftValue(property, draft)); } catch { setFailed(true); } finally { setSaving(false); } };
  const restore = () => { setDraft(saved); setFailed(false); };
  if (!editable) return <span>{String(saved) || "—"}</span>;
  return <div className={styles.cellEditor} data-saving={saving || undefined} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) void save();
  }}>
    <CollectionDraftControl property={property} value={draft} label={`${property.name}, ${recordLabel}`} onChange={setDraft}
      onCancel={restore} onConfirm={() => void save()} onNavigate={onNavigate} />
    {failed ? <span className={styles.cellError} role="alert">Value not saved. <button type="button" aria-label={`Retry ${property.name}`}
      onClick={() => void save()}>Try again</button></span> : null}
  </div>;
}
