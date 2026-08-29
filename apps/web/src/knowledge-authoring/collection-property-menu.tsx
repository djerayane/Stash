import { useEffect, useRef, useState } from "react";
import type { Collection, CollectionProperty, CollectionPropertyImpact, CollectionPropertyType } from "@stash/domain-types";

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

export function CollectionPropertyMenu({ collection, property, availableCollections = [], availableCollectionNotes = {}, token, fetcher,
  onChanged, onClose, returnFocusRef }: {
  collection: Collection; property?: CollectionProperty; token: string; fetcher: typeof fetch;
  availableCollections?: readonly Collection[]; availableCollectionNotes?: Readonly<Record<string, string>>;
  onChanged(): Promise<void>; onClose(): void; returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null); const [name, setName] = useState(property?.name ?? "");
  const [type, setType] = useState<CollectionPropertyType>(property?.type ?? "text");
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>(property && (property.type === "single_select" || property.type === "multi_select")
    ? property.options.map((option) => ({ ...option })) : []);
  const [targetKind, setTargetKind] = useState<"collection_records" | "notes" | "tasks" | "projects">(
    property?.type === "relation" ? property.target.kind : "notes");
  const [targetCollectionId, setTargetCollectionId] = useState(property?.type === "relation" && property.target.kind === "collection_records"
    ? property.target.collectionId : "");
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [deleteOpen, setDeleteOpen] = useState(false);
  const [impact, setImpact] = useState<CollectionPropertyImpact>();
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async () => {
    setPending(true); setError("");
    const base = { name: name.trim(), type };
    const body = type === "single_select" || type === "multi_select" ? { ...base,
      options: options.map((option) => ({ ...option, name: option.name.trim() })).filter(({ name }) => name) }
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
  const previewRemoval = async () => { if (!property) return; setPending(true); setError("");
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties/${encodeURIComponent(property.id)}/impact`,
      { headers: { authorization: `Bearer ${token}` } });
      const result = await response.json() as { impact?: CollectionPropertyImpact; message?: string };
      if (!response.ok || !result.impact) throw new Error(result.message || "Property impact is unavailable.");
      setImpact(result.impact); setDeleteOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Property impact is unavailable."); }
    finally { setPending(false); } };
  const remove = async () => { if (!property || !impact) return; setPending(true); setError("");
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties/${encodeURIComponent(property.id)}`,
      { method: "DELETE", headers: auth(token), body: JSON.stringify({ impactToken: impact.token }) });
      const result = await response.json() as { impact?: CollectionPropertyImpact; message?: string };
      if (response.status === 409 && result.impact) { setImpact(result.impact);
        throw new Error(result.message || "Property impact changed. Review the updated impact before deleting."); }
      if (!response.ok) throw new Error(result.message || "The property could not be deleted.");
      setDeleteOpen(false); await onChanged(); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The property could not be deleted."); } finally { setPending(false); }
  };
  return <><form className={styles.propertyMenu} aria-label={property ? `Edit ${property.name} property` : "Add property"}
    onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field label="Property name"><input ref={inputRef} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
    <Field label="Property type"><select disabled={property?.type === "text" && collection.properties.filter(({ type }) => type === "text").length === 1}
      value={type} onChange={(event) => setType(event.target.value as CollectionPropertyType)}>
      {propertyTypes.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></Field>
    {property?.type === "text" && collection.properties.filter(({ type }) => type === "text").length === 1
      ? <p className={styles.primaryNote} role="note">Keep one text property as the primary record name.</p> : null}
    {type === "single_select" || type === "multi_select" ? <fieldset className={styles.optionEditor}><legend>Options</legend>
      {options.map((option, index) => <div key={option.id}><input required aria-label={`Option ${index + 1}`} value={option.name}
        onChange={(event) => setOptions((current) => current.map((entry) => entry.id === option.id ? { ...entry, name: event.target.value } : entry))} />
        <button type="button" aria-label={`Move option ${index + 1} up`} disabled={index === 0} onClick={() => setOptions((current) => {
          const next = [...current]; const [moving] = next.splice(index, 1); next.splice(index - 1, 0, moving!); return next; })}>↑</button>
        <button type="button" aria-label={`Move option ${index + 1} down`} disabled={index === options.length - 1} onClick={() => setOptions((current) => {
          const next = [...current]; const [moving] = next.splice(index, 1); next.splice(index + 1, 0, moving!); return next; })}>↓</button>
        <button type="button" aria-label={`Remove option ${index + 1}`} onClick={() => setOptions((current) => current.filter(({ id }) => id !== option.id))}>Remove</button></div>)}
      <button type="button" onClick={() => setOptions((current) => [...current, { id: crypto.randomUUID(), name: "" }])}>Add option</button>
    </fieldset> : null}
    {type === "relation" ? <><Field label="Relation target"><select value={targetKind}
      onChange={(event) => setTargetKind(event.target.value as typeof targetKind)}><option value="notes">Notes</option><option value="tasks">Tasks</option>
      <option value="projects">Projects</option><option value="collection_records">Collection records</option></select></Field>
    {targetKind === "collection_records" ? <Field label="Related Collection"><select required aria-label="Related Collection" value={targetCollectionId}
      onChange={(event) => setTargetCollectionId(event.target.value)}><option value="">Choose a Collection</option>
      {availableCollections.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} — {availableCollectionNotes[entry.id] ?? "Current Note"}</option>)}</select></Field> : null}</> : null}
    {error ? <p role="alert">{error}</p> : null}<div className={styles.menuActions}>
      <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button pending={pending}>{property ? "Save property" : "Add property"}</Button>
      {property ? <><Button type="button" variant="secondary" disabled={pending || property.position === 1} onClick={() => void move(-1)}>Move left</Button>
        <Button type="button" variant="secondary" disabled={pending || property.position === collection.properties.length} onClick={() => void move(1)}>Move right</Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => void duplicate()}>Duplicate property</Button>
        <Button type="button" variant="danger" pending={pending} onClick={() => void previewRemoval()}>Delete property</Button></> : null}
    </div></form>
    {property ? <CollectionImpactDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${property.name} property?`}
      description="This removes the property from this canonical Collection everywhere it appears." confirmLabel="Delete property"
      cancelLabel="Keep property" pending={pending} error={error} returnFocusRef={returnFocusRef} onConfirm={() => void remove()}>
      <p>{impact?.affectedValues ?? 0} saved value{impact?.affectedValues === 1 ? "" : "s"} will be removed.</p>
      <p>{impact?.affectedRelations ?? 0} relation reference{impact?.affectedRelations === 1 ? "" : "s"} will be removed.</p>
      <p>{impact?.affectedViews ?? 0} view{impact?.affectedViews === 1 ? "" : "s"} will be updated.</p>
    </CollectionImpactDialog> : null}</>;
}
