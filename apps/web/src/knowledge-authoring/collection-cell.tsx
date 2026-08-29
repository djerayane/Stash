import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CollectionProperty, CollectionPropertyValue } from "@stash/domain-types";

import { relationSelectionValue, selectionIds, type CollectionSelectionOption } from "./collection-selection-options";
import styles from "./collection-editor.module.css";

export interface CollectionDateDraft {
  kind: "date_time";
  value: string;
  includeTime: boolean;
  end?: string;
  offsetMinutes?: number;
  sourceStart?: string;
  sourceWallValue?: string;
}

export type CollectionCellDraft = string | boolean | string[] | CollectionDateDraft;

function localOffsetMinutes(at: Date) {
  return -at.getTimezoneOffset();
}

export function dateValueDraft(value?: CollectionPropertyValue, timezoneOffsetMinutes?: number): CollectionDateDraft {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("start" in value))
    return { kind: "date_time", value: "", includeTime: false };
  if (!value.includeTime || value.start.length === 10)
    return { kind: "date_time", value: value.start.slice(0, 10), ...(value.end ? { end: value.end } : {}), includeTime: false };
  const instant = new Date(value.start);
  const offset = timezoneOffsetMinutes ?? localOffsetMinutes(instant);
  const wallValue = new Date(instant.getTime() + offset * 60_000).toISOString().slice(0, 16);
  return { kind: "date_time", value: wallValue, ...(value.end ? { end: value.end } : {}), includeTime: true,
    offsetMinutes: offset, sourceStart: value.start, sourceWallValue: wallValue };
}

export function dateDraftValue(draft: CollectionDateDraft, timezoneOffsetMinutes?: number): CollectionPropertyValue {
  if (!draft.value) return null;
  if (!draft.includeTime) return { start: draft.value.slice(0, 10), ...(draft.end ? { end: draft.end } : {}), includeTime: false };
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(draft.value);
  if (!parts) return null;
  const [, year, month, day, hour, minute] = parts;
  if (draft.sourceStart && draft.value === draft.sourceWallValue)
    return { start: draft.sourceStart, ...(draft.end ? { end: draft.end } : {}), includeTime: true };
  const values = [Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)] as const;
  const wallClockUtc = Date.UTC(...values);
  const storedOffset = draft.offsetMinutes; const storedInstant = storedOffset === undefined ? undefined : new Date(wallClockUtc - storedOffset * 60_000);
  const storedOffsetIsValid = storedInstant !== undefined && storedInstant.getFullYear() === values[0]
    && storedInstant.getMonth() === values[1] && storedInstant.getDate() === values[2]
    && storedInstant.getHours() === values[3] && storedInstant.getMinutes() === values[4];
  const offset = timezoneOffsetMinutes !== undefined ? storedOffset ?? timezoneOffsetMinutes
    : storedOffsetIsValid ? storedOffset! : localOffsetMinutes(new Date(...values));
  return { start: new Date(wallClockUtc - offset * 60_000).toISOString(), ...(draft.end ? { end: draft.end } : {}), includeTime: true };
}

export function collectionValueDraft(property: CollectionProperty, value?: CollectionPropertyValue): CollectionCellDraft {
  if (property.type === "checkbox") return value === true;
  if (property.type === "multi_select") return Array.isArray(value) ? value.map(String) : [];
  if (property.type === "date_time") return dateValueDraft(value);
  if ((property.type === "person" || property.type === "attachment" || property.type === "relation") && Array.isArray(value)) return selectionIds(value);
  return value === undefined || value === null ? "" : String(value);
}

export function collectionDraftValue(property: CollectionProperty, raw: CollectionCellDraft,
  options: readonly CollectionSelectionOption[] = []): CollectionPropertyValue {
  if (property.type === "checkbox") return raw === true;
  if (property.type === "multi_select") return Array.isArray(raw) ? raw : [];
  if (property.type === "date_time") return dateDraftValue(raw as CollectionDateDraft);
  const value = String(raw).trim();
  if (property.type === "number") return value ? Number(value) : null;
  if (property.type === "single_select" || property.type === "url") return value || null;
  if (property.type === "person" || property.type === "attachment") return Array.isArray(raw) ? raw : [];
  if (property.type === "relation") return relationSelectionValue(Array.isArray(raw) ? raw : [], options);
  return value;
}

function draftText(property: CollectionProperty, draft: CollectionCellDraft, options: readonly CollectionSelectionOption[] = []) {
  if (property.type === "date_time") return (draft as CollectionDateDraft).value || "—";
  if (property.type === "checkbox") return draft === true ? "Checked" : "Not checked";
  if (property.type === "single_select") return property.options.find(({ id }) => id === draft)?.name ?? "—";
  if (property.type === "multi_select" && Array.isArray(draft)) return draft.map((id) => property.options.find((option) => option.id === id)?.name ?? id).join(", ") || "—";
  if (Array.isArray(draft)) return draft.map((id) => options.find((option) => option.id === id)?.label ?? "Unavailable item").join(", ") || "—";
  return String(draft) || "—";
}

interface DraftControlProps {
  property: CollectionProperty;
  value: CollectionCellDraft;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
  options?: readonly CollectionSelectionOption[];
  onChange(value: CollectionCellDraft): void;
  onConfirm?(): void;
  onCancel?(): void;
  onNavigate?(direction: "left" | "right" | "up" | "down"): void;
}

export function CollectionDraftControl({ property, value, label, autoFocus, disabled, options = [], onChange, onConfirm, onCancel, onNavigate }: DraftControlProps) {
  const controlRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  useEffect(() => { if (autoFocus) controlRef.current?.focus(); }, [autoFocus]);
  const keyDown = (event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); return; }
    if (event.key === "Enter" && onConfirm && property.type !== "multi_select") { event.preventDefault(); onConfirm(); return; }
    if (!onNavigate || !event.key.startsWith("Arrow")) return;
    if (event.currentTarget instanceof HTMLSelectElement) return;
    if (event.currentTarget instanceof HTMLInputElement && ["date", "datetime-local", "time", "month", "week"].includes(event.currentTarget.type)) return;
    const direction = event.key.slice(5).toLowerCase() as "left" | "right" | "up" | "down";
    if (event.currentTarget instanceof HTMLInputElement && (direction === "left" || direction === "right")) {
      const atStart = event.currentTarget.selectionStart === 0; const atEnd = event.currentTarget.selectionEnd === event.currentTarget.value.length;
      if (direction === "left" && !atStart || direction === "right" && !atEnd) return;
    }
    if (event.currentTarget instanceof HTMLInputElement && event.currentTarget.type === "number" && (direction === "up" || direction === "down")) return;
    event.preventDefault(); onNavigate(direction);
  };
  if (property.type === "checkbox") return <label className={styles.checkboxControl}><input
    ref={controlRef as React.RefObject<HTMLInputElement>} aria-label={label} checked={value === true}
    type="checkbox" disabled={disabled} onChange={(event) => onChange(event.target.checked)} onKeyDown={keyDown} /></label>;
  if (property.type === "single_select") return <select ref={controlRef as React.RefObject<HTMLSelectElement>} aria-label={label} value={String(value)}
    disabled={disabled} onChange={(event) => onChange(event.target.value)} onKeyDown={keyDown}><option value="">No value</option>
    {property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
  if (property.type === "multi_select") return <select ref={controlRef as React.RefObject<HTMLSelectElement>} aria-label={label} multiple
    disabled={disabled} value={Array.isArray(value) ? value : []} onChange={(event) => onChange(Array.from(event.target.selectedOptions).map(({ value }) => value))}
    onKeyDown={keyDown}>{property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
  if (property.type === "person" || property.type === "attachment" || property.type === "relation") return <select
    ref={controlRef as React.RefObject<HTMLSelectElement>} aria-label={label} multiple disabled={disabled} value={Array.isArray(value) ? value : []}
    onChange={(event) => onChange(Array.from(event.target.selectedOptions).map(({ value }) => value))} onKeyDown={keyDown}>
    {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>;
  if (property.type === "date_time") {
    const date = value as CollectionDateDraft;
    return <span className={styles.dateControl}>
      <input ref={controlRef as React.RefObject<HTMLInputElement>} aria-label={label} disabled={disabled}
        type={date.includeTime ? "datetime-local" : "date"} value={date.value}
        onChange={(event) => onChange({ ...date, value: event.target.value })} onKeyDown={keyDown} />
      <label><input type="checkbox" checked={date.includeTime} disabled={disabled} onKeyDown={keyDown} onChange={(event) => {
        const includeTime = event.target.checked;
        onChange({ ...date, includeTime, value: includeTime ? `${date.value.slice(0, 10)}T00:00` : date.value.slice(0, 10) });
      }} />Include time for {label}</label>
    </span>;
  }
  const type = property.type === "number" ? "number" : property.type === "url" ? "url" : "text";
  return <input ref={controlRef as React.RefObject<HTMLInputElement>} aria-label={label} disabled={disabled} type={type} value={String(value)}
    onChange={(event) => onChange(event.target.value)} onKeyDown={keyDown} />;
}

export function CollectionCell({ property, value, recordLabel, editable, options = [], onSave, onNavigate }: {
  property: CollectionProperty; value?: CollectionPropertyValue; recordLabel: string; editable: boolean;
  options?: readonly CollectionSelectionOption[];
  onSave(value: CollectionPropertyValue): Promise<void>;
  onNavigate(direction: "left" | "right" | "up" | "down"): void;
}) {
  const current = Array.isArray(value) ? value.map((entry): CollectionSelectionOption => typeof entry === "string"
    ? { id: entry, label: options.find((option) => option.id === entry)?.label ?? (property.type === "person" ? "Unavailable member" : "Unavailable file") }
    : { id: entry.id, label: entry.fallback }) : [];
  const resolvedOptions = [...options, ...current.filter(({ id }) => !options.some((option) => option.id === id))];
  const saved = collectionValueDraft(property, value); const [draft, setDraft] = useState<CollectionCellDraft>(saved);
  const [saving, setSaving] = useState(false); const [failed, setFailed] = useState(false);
  useEffect(() => { if (!failed) setDraft(saved); }, [failed, property.id, value]);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = async () => { if (!changed || saving) return; setSaving(true);
    try { await onSave(collectionDraftValue(property, draft, resolvedOptions)); setFailed(false); } catch { setFailed(true); } finally { setSaving(false); } };
  const restore = () => { setDraft(saved); setFailed(false); };
  if (!editable) return <span>{draftText(property, saved, resolvedOptions)}</span>;
  return <div className={styles.cellEditor} data-saving={saving || undefined} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) void save();
  }}>
    <CollectionDraftControl property={property} value={draft} options={resolvedOptions} label={`${property.name}, ${recordLabel}`} disabled={saving} onChange={setDraft}
      onCancel={restore} onConfirm={() => void save()} onNavigate={onNavigate} />
    {failed ? <span className={styles.cellError} role="alert">Value not saved. <button type="button" aria-label={`Retry ${property.name}`}
      onClick={() => void save()}>Try again</button></span> : null}
  </div>;
}
