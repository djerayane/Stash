import { useEffect, useRef, useState } from "react";
import type { Collection, CollectionProperty, CollectionPropertyType, ViewBlock } from "@stash/domain-types";

import { Button, Field } from "../ui/control";
import { CollectionImpactDialog } from "./collection-impact-dialog";
import styles from "./collection-editor.module.css";

const propertyTypes: Array<{ value: CollectionPropertyType; label: string }> = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "checkbox", label: "Checkbox" },
  { value: "date_time", label: "Date and time" }, { value: "single_select", label: "Single select" },
  { value: "multi_select", label: "Multi select" }, { value: "person", label: "Person" }, { value: "url", label: "URL" },
  { value: "attachment", label: "Attachment" }, { value: "relation", label: "Direct relation" },
];

function auth(token: string) { return { authorization: `Bearer ${token}`, "content-type": "application/json" }; }

export function CollectionPropertyMenu({ collection, property, views, token, fetcher, onChanged, onClose, returnFocusRef }: {
  collection: Collection; property?: CollectionProperty; views: readonly ViewBlock[]; token: string; fetcher: typeof fetch;
  onChanged(): Promise<void>; onClose(): void; returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null); const [name, setName] = useState(property?.name ?? "");
  const [type, setType] = useState<CollectionPropertyType>(property?.type ?? "text");
  const [options, setOptions] = useState(property && (property.type === "single_select" || property.type === "multi_select")
    ? property.options.map(({ name }) => name).join(", ") : "");
  const [targetKind, setTargetKind] = useState<"collection_records" | "notes" | "tasks" | "projects">(
    property?.type === "relation" ? property.target.kind : "notes");
  const [targetCollectionId, setTargetCollectionId] = useState(property?.type === "relation" && property.target.kind === "collection_records"
    ? property.target.collectionId : "");
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [deleteOpen, setDeleteOpen] = useState(false);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async () => {
    setPending(true); setError("");
    const base = { name: name.trim(), type };
    const body = type === "single_select" || type === "multi_select" ? { ...base,
      options: options.split(",").map((entry, index) => ({
        id: property && (property.type === "single_select" || property.type === "multi_select")
          ? property.options[index]?.id ?? `option-${index + 1}` : `option-${index + 1}`,
        name: entry.trim(),
      })).filter(({ name }) => name) }
      : type === "relation" ? { ...base, target: targetKind === "collection_records"
        ? { kind: targetKind, collectionId: targetCollectionId } : { kind: targetKind } } : base;
    const path = property ? `/api/collections/${encodeURIComponent(collection.id)}/properties/${encodeURIComponent(property.id)}`
      : `/api/collections/${encodeURIComponent(collection.id)}/properties`;
    const createdId = property ? undefined : crypto.randomUUID();
    const payload = property ? body : { id: createdId, position: Math.max(0, ...collection.properties.map(({ position }) => position)) + 1, ...body };
    try { const response = await fetcher(path, { method: property ? "PATCH" : "POST", headers: auth(token), body: JSON.stringify(payload) });
      const result = await response.json() as { message?: string }; if (!response.ok) throw new Error(result.message || "The property could not be saved.");
      await onChanged(); onClose();
      if (createdId) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-property-trigger="${createdId}"]`)?.focus());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The property could not be saved."); }
    finally { setPending(false); }
  };
  const move = async (offset: number) => {
    if (!property) return; const ordered = [...collection.properties].sort((left, right) => left.position - right.position);
    const index = ordered.findIndex(({ id }) => id === property.id); const next = Math.max(0, Math.min(ordered.length - 1, index + offset));
    if (next === index) return; const [moving] = ordered.splice(index, 1); ordered.splice(next, 0, moving!); setPending(true);
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties/order`, { method: "PATCH",
      headers: auth(token), body: JSON.stringify({ propertyIds: ordered.map(({ id }) => id) }) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The property could not be moved.");
      await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The property could not be moved."); } finally { setPending(false); }
  };
  const duplicate = async () => { if (!property) return; setPending(true); setError("");
    const copy = { ...property, id: crypto.randomUUID(), name: `${property.name} copy`,
      position: Math.max(0, ...collection.properties.map(({ position }) => position)) + 1 };
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties`, { method: "POST",
      headers: auth(token), body: JSON.stringify(copy) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The property could not be duplicated.");
      await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The property could not be duplicated."); } finally { setPending(false); }
  };
  const valueCount = property ? collection.records.filter((record) => Object.hasOwn(record.values, property.id)).length : 0;
  const relationCount = property?.type === "relation" ? collection.records.reduce((sum, record) => {
    const value = record.values[property.id]; return sum + (Array.isArray(value) ? value.length : 0);
  }, 0) : 0;
  const viewCount = property ? views.filter((view) => view.definition.filters.some((filter) => filter.propertyId === property.id)
    || view.definition.sorts.some((sort) => sort.propertyId === property.id) || view.definition.groupBy === property.id
    || Array.isArray(view.definition.layout.visiblePropertyIds) && view.definition.layout.visiblePropertyIds.includes(property.id)).length : 0;
  const remove = async () => { if (!property) return; setPending(true); setError("");
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties/${encodeURIComponent(property.id)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      const result = await response.json() as { message?: string }; if (!response.ok) throw new Error(result.message || "The property could not be deleted.");
      setDeleteOpen(false); await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The property could not be deleted."); } finally { setPending(false); }
  };
  return <><form className={styles.propertyMenu} aria-label={property ? `Edit ${property.name} property` : "Add property"}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field label="Property name"><input ref={inputRef} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Property type"><select value={type} onChange={(event) => setType(event.target.value as CollectionPropertyType)}>
      {propertyTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></Field>
    {type === "single_select" || type === "multi_select" ? <Field label="Options"><input required value={options}
      onChange={(event) => setOptions(event.target.value)} /></Field> : null}
    {type === "relation" ? <><Field label="Relation target"><select value={targetKind}
      onChange={(event) => setTargetKind(event.target.value as typeof targetKind)}><option value="notes">Notes</option><option value="tasks">Tasks</option>
      <option value="projects">Projects</option><option value="collection_records">Collection records</option></select></Field>
    {targetKind === "collection_records" ? <Field label="Related Collection identity"><input required value={targetCollectionId}
      onChange={(event) => setTargetCollectionId(event.target.value)} /></Field> : null}</> : null}
    {error ? <p role="alert">{error}</p> : null}<div className={styles.menuActions}>
      <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button pending={pending}>{property ? "Save property" : "Add property"}</Button>
      {property ? <><Button type="button" variant="secondary" disabled={pending || property.position === 1} onClick={() => void move(-1)}>Move left</Button>
        <Button type="button" variant="secondary" disabled={pending || property.position === collection.properties.length} onClick={() => void move(1)}>Move right</Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void duplicate()}>Duplicate property</Button>
        <Button type="button" variant="danger" onClick={() => setDeleteOpen(true)}>Delete property</Button></> : null}
    </div></form>
    {property ? <CollectionImpactDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${property.name} property?`}
      description="This removes the property from this canonical Collection everywhere it appears." confirmLabel="Delete property"
      cancelLabel="Keep property" pending={pending} error={error} returnFocusRef={returnFocusRef} onConfirm={() => void remove()}>
      <p>{valueCount} saved value{valueCount === 1 ? "" : "s"} will be removed.</p>
      <p>{relationCount} relation reference{relationCount === 1 ? "" : "s"} will be removed.</p>
      <p>{viewCount} view{viewCount === 1 ? "" : "s"} will be updated.</p>
    </CollectionImpactDialog> : null}</>;
}
