import { useEffect, useMemo, useRef, useState } from "react";
import type { Collection, CollectionImpact, CollectionProperty, CollectionPropertyType, CollectionPropertyValue, ViewBlock, ViewDefinition, ViewPresentation } from "@stash/domain-types";

import { Button } from "../ui/control";
import { CollectionCell, CollectionDraftControl, collectionDraftValue, collectionValueDraft, type CollectionCellDraft } from "./collection-cell";
import { CollectionImpactDialog } from "./collection-impact-dialog";
import { CollectionPropertyMenu } from "./collection-property-menu";
import { emptyCollectionSelectionOptions, selectionOptionsForProperty, type CollectionSelectionOptions } from "./collection-selection-options";
import { CollectionViewControls } from "./collection-view-controls";
import { BoardView } from "./views/board-view";
import { CalendarView } from "./views/calendar-view";
import { ListView } from "./views/list-view";
import { evaluateCollectionView, updateBoardGroup } from "./views/view-model";
import { recordTitle } from "./views/table-view";
import styles from "./collection-editor.module.css";

export interface CollectionTableProps {
  collection: Collection;
  view?: ViewBlock;
  sourceNoteTitle?: string;
  availableNotes?: readonly { id: string; title: string }[];
  availableCollections?: readonly Collection[];
  availableCollectionNotes?: Readonly<Record<string, string>>;
  selectionOptions?: CollectionSelectionOptions;
  canonicalActions?: boolean;
  editable: boolean;
  token: string;
  fetcher: typeof fetch;
  onChanged(): Promise<void>;
}

function auth(token: string, json = true) { return { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) }; }
function defaultDefinition(collection: Collection): ViewDefinition { return { source: { kind: "collection", collectionId: collection.id },
  presentation: "table", filters: [], sorts: [], layout: {} }; }

export function CollectionTable({ collection, view: persistedView, sourceNoteTitle, availableNotes = [], availableCollections = [],
  availableCollectionNotes = {}, selectionOptions = emptyCollectionSelectionOptions, canonicalActions = true,
  editable, token, fetcher, onChanged }: CollectionTableProps) {
  const canManageCollection = editable && canonicalActions;
  const [definition, setDefinition] = useState<ViewDefinition>(persistedView?.definition ?? defaultDefinition(collection));
  const [title, setTitle] = useState(collection.title); const [propertyMenu, setPropertyMenu] = useState<CollectionProperty | "new">();
  const collectionRoot = useRef<HTMLElement>(null); const propertyTrigger = useRef<HTMLButtonElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null); const crossNoteTrigger = useRef<HTMLButtonElement>(null); const saveQueue = useRef(Promise.resolve());
  const [newRecord, setNewRecord] = useState(false); const [newValues, setNewValues] = useState<Record<string, CollectionCellDraft>>({});
  const [actionsOpen, setActionsOpen] = useState(false); const [moveOpen, setMoveOpen] = useState(false); const [destination, setDestination] = useState("");
  const [impact, setImpact] = useState<CollectionImpact>(); const [deleteOpen, setDeleteOpen] = useState(false); const [pending, setPending] = useState(false);
  const [crossNoteDisclosureOpen, setCrossNoteDisclosureOpen] = useState(false); const [crossNoteEditAcknowledged, setCrossNoteEditAcknowledged] = useState(false);
  const [requestedEditCell, setRequestedEditCell] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => { setTitle(collection.title); }, [collection.title]);
  useEffect(() => { if (persistedView) setDefinition(persistedView.definition); }, [persistedView?.id, persistedView?.definition]);
  const evaluated = useMemo(() => evaluateCollectionView(collection, definition), [collection, definition]);
  const focused = definition.focused ? collection.records.find(({ id }) => id === definition.focused?.recordId) : undefined;
  const visibleIds = Array.isArray(definition.layout.visiblePropertyIds) ? definition.layout.visiblePropertyIds as string[] : undefined;
  const visibleProperties = collection.properties.filter(({ id }) => !visibleIds || visibleIds.includes(id));
  const primaryProperty = [...collection.properties].sort((left, right) => left.position - right.position).find(({ type }) => type === "text");
  const tableProperties = newRecord && primaryProperty && !visibleProperties.some(({ id }) => id === primaryProperty.id)
    ? [primaryProperty, ...visibleProperties] : visibleProperties;
  const saveDefinition = (next: ViewDefinition) => { if (!editable) return; setDefinition(next); if (!persistedView) return;
    saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
      const response = await fetcher(`/api/view-blocks/${encodeURIComponent(persistedView.id)}`, { method: "PATCH",
        headers: auth(token), body: JSON.stringify(next) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The View could not be saved.");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "The View could not be saved.")); };
  const focusRecord = (recordId: string) => { if (editable) saveDefinition({ ...definition, focused: { recordId } }); };
  const saveTitle = async () => { if (!title.trim() || title.trim() === collection.title) { setTitle(collection.title); return; }
    setPending(true); setError(""); try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}`,
      { method: "PATCH", headers: auth(token), body: JSON.stringify({ title: title.trim() }) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The Collection title could not be saved.");
      await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The Collection title could not be saved."); }
    finally { setPending(false); } };
  const saveCell = async (recordId: string, propertyId: string, value: CollectionPropertyValue) => {
    const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/records/${encodeURIComponent(recordId)}`,
      { method: "PATCH", headers: auth(token), body: JSON.stringify({ values: { [propertyId]: value } }) });
    if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The value could not be saved.");
    await onChanged();
  };
  const focusCell = (row: number, column: number, direction: "left" | "right" | "up" | "down") => {
    if (!evaluated.records.length || !tableProperties.length) return;
    const nextRow = Math.max(0, Math.min(evaluated.records.length - 1, row + (direction === "up" ? -1 : direction === "down" ? 1 : 0)));
    const nextColumn = Math.max(0, Math.min(tableProperties.length - 1, column + (direction === "left" ? -1 : direction === "right" ? 1 : 0)));
    collectionRoot.current?.querySelector<HTMLElement>(`[data-collection-cell="${collection.id}-${nextRow}-${nextColumn}"] input, [data-collection-cell="${collection.id}-${nextRow}-${nextColumn}"] select`)?.focus();
  };
  const createRecord = async () => { setPending(true); setError(""); const values = Object.fromEntries(collection.properties.map((property) =>
    [property.id, collectionDraftValue(property, newValues[property.id] ?? collectionValueDraft(property),
      selectionOptionsForProperty(property, selectionOptions, availableCollections))]));
    const record = { id: crypto.randomUUID(), position: Math.max(0, ...collection.records.map(({ position }) => position)) + 1, values };
    try { const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/records`, { method: "POST", headers: auth(token), body: JSON.stringify(record) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The record could not be created.");
      setNewRecord(false); setNewValues({}); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The record could not be created."); } finally { setPending(false); } };
  const addRequired = async (type: CollectionPropertyType, presentation: ViewPresentation) => {
    if (!editable) return;
    const propertyId = crypto.randomUUID(); const position = Math.max(0, ...collection.properties.map((property) => property.position)) + 1;
    const base = { id: propertyId, position, name: type === "date_time" ? "Date" : "Status", type };
    const property = type === "single_select" ? { ...base, type, options: [{ id: "not-started", name: "Not started" }, { id: "done", name: "Done" }] } : base;
    const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties`, { method: "POST", headers: auth(token), body: JSON.stringify(property) });
    if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The required property could not be added.");
    saveDefinition({ ...definition, presentation, ...(presentation === "board" ? { groupBy: propertyId } : {}) }); await onChanged();
  };
  const previewImpact = async (action: "move" | "delete") => { setActionsOpen(false); setPending(true); setError("");
    try { const response = await fetcher(`/api/notes/${encodeURIComponent(collection.ownerNoteId)}/collections/impact`, { headers: auth(token, false) });
      const body = await response.json() as { impact?: CollectionImpact; message?: string }; if (!response.ok || !body.impact)
        throw new Error(body.message || "Collection impact is unavailable."); setImpact(body.impact);
      if (action === "move") setMoveOpen(true); else setDeleteOpen(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Collection impact is unavailable."); } finally { setPending(false); } };
  const duplicateCollection = async () => { setPending(true); setError("");
    const duplicate: Collection = { ...collection, id: crypto.randomUUID(), title: `${collection.title} copy`, records: [],
      properties: collection.properties.map((property) => ({ ...property, id: crypto.randomUUID() })) };
    try { const response = await fetcher(`/api/notes/${encodeURIComponent(collection.ownerNoteId)}/collections`, { method: "POST",
      headers: auth(token), body: JSON.stringify(duplicate) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The Collection could not be duplicated.");
      setActionsOpen(false); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The Collection could not be duplicated."); } finally { setPending(false); } };
  const deleteCollection = async () => { if (!impact) return; setPending(true); setError("");
    try { const response = await fetcher(`/api/notes/${encodeURIComponent(collection.ownerNoteId)}/collections/delete`, { method: "POST", headers: auth(token),
      body: JSON.stringify({ confirmed: true, impactToken: impact.token, collectionIds: [collection.id] }) });
      const result = await response.json() as { impact?: CollectionImpact; message?: string };
      if (response.status === 409 && result.impact) { setImpact(result.impact);
        throw new Error(result.message || "Collection impact changed. Review the updated impact before deleting."); }
      if (!response.ok) throw new Error(result.message || "The Collection could not be deleted.");
      setDeleteOpen(false); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The Collection could not be deleted."); } finally { setPending(false); } };
  const moveCollection = async () => { setPending(true); setError("");
    try { const response = await fetcher(`/api/notes/${encodeURIComponent(collection.ownerNoteId)}/collections/relocate`, { method: "POST", headers: auth(token),
      body: JSON.stringify({ destinationNoteId: destination.trim(), collectionIds: [collection.id] }) });
      if (!response.ok) throw new Error(((await response.json()) as { message?: string }).message || "The Collection could not be moved.");
      setMoveOpen(false); setDestination(""); setImpact(undefined); await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The Collection could not be moved."); } finally { setPending(false); } };
  const relationTotal = impact?.relations.filter((item) => !item.targetCollectionId || item.targetCollectionId === collection.id)
    .reduce((sum, item) => sum + item.referenceCount, 0) ?? 0;
  const viewTotal = impact?.viewBlocks.filter((item) => !item.collectionId || item.collectionId === collection.id).length ?? 0;
  const selectedImpact = impact?.collections.find(({ id }) => id === collection.id);
  const sectionTitle = persistedView?.title ?? (title || collection.title);
  return <section ref={collectionRoot} className={styles.collection} aria-label={sectionTitle} data-collection-id={collection.id}
    data-density={String(definition.layout.density ?? "comfortable")}>
    <header className={styles.collectionHeader}>{persistedView ? <div className={styles.viewIdentity}><h3>{persistedView.title}</h3>
      <p>View of {collection.title} · From {sourceNoteTitle ?? "Another Note"}</p></div> : <input className={styles.collectionTitle} aria-label="Collection title" value={title}
      disabled={!canManageCollection || pending} onChange={(event) => setTitle(event.target.value)} onBlur={() => void saveTitle()}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveTitle(); } if (event.key === "Escape") setTitle(collection.title); }} />}
      <CollectionViewControls collection={collection} availableCollections={availableCollections} selectionOptions={selectionOptions}
        definition={definition} editable={editable} onChange={saveDefinition} onAddRequiredProperty={addRequired} />
      {canManageCollection ? <div className={styles.actions}><button ref={moreTrigger} className={styles.moreButton} type="button" aria-label="Collection actions"
        aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}>•••</button>{actionsOpen ? <div className={styles.actionMenu}>
          <button type="button" onClick={() => void previewImpact("move")}>Move to another Note</button><button type="button" onClick={() => void duplicateCollection()}>Duplicate</button>
          <button type="button" onClick={() => void previewImpact("delete")}>Delete collection</button>
        </div> : null}</div> : null}
    </header>{error && !deleteOpen && !moveOpen ? <p className={styles.inlineError} role="alert">{error}</p> : null}
    {definition.presentation === "table" ? <div className={styles.tableScroll}><table aria-label={`${collection.title} records`}><thead><tr>
      {tableProperties.map((property) => <th aria-label={property.name} key={property.id} scope="col">{canManageCollection ? <button
        type="button" aria-label={`Edit ${property.name} property`} data-property-trigger={property.id}
        onClick={(event) => { propertyTrigger.current = event.currentTarget; setPropertyMenu(property); }}>{property.name}</button> : <span className={styles.propertyLabel}>{property.name}</span>}
        {propertyMenu !== "new" && propertyMenu?.id === property.id ? <CollectionPropertyMenu collection={collection} property={propertyMenu}
          availableCollections={availableCollections} availableCollectionNotes={availableCollectionNotes}
          token={token} fetcher={fetcher} onChanged={onChanged} onClose={() => { setPropertyMenu(undefined); requestAnimationFrame(() => propertyTrigger.current?.focus()); }} returnFocusRef={propertyTrigger} /> : null}</th>)}
      {canManageCollection ? <th className={styles.addPropertyHeader} scope="col"><button type="button"
        aria-label={propertyMenu === "new" ? "Close property menu" : "Add property"}
        onClick={(event) => { propertyTrigger.current = event.currentTarget; setPropertyMenu("new"); }}>Add property</button>
        {propertyMenu === "new" ? <CollectionPropertyMenu collection={collection} availableCollections={availableCollections}
          availableCollectionNotes={availableCollectionNotes} token={token} fetcher={fetcher} onChanged={onChanged}
          onClose={() => { setPropertyMenu(undefined); requestAnimationFrame(() => propertyTrigger.current?.focus()); }} returnFocusRef={propertyTrigger} /> : null}</th> : null}
    </tr></thead><tbody>{evaluated.records.map((record, row) => { const label = recordTitle(collection, record); return <tr key={record.id}>
      {tableProperties.map((property, column) => <td key={property.id} data-collection-cell={`${collection.id}-${row}-${column}`}>{persistedView
        && persistedView.ownerNoteId !== collection.ownerNoteId && !crossNoteEditAcknowledged && editable ? <button type="button" className={styles.disclosureEdit}
          ref={(node) => { if (requestedEditCell === `${row}-${column}`) crossNoteTrigger.current = node; }} aria-label={`Edit ${property.name}, ${label}`}
          onClick={(event) => { crossNoteTrigger.current = event.currentTarget; setRequestedEditCell(`${row}-${column}`); setCrossNoteDisclosureOpen(true); }}>
          <CollectionCell property={property} value={record.values[property.id]} options={selectionOptionsForProperty(property, selectionOptions, availableCollections)}
            recordLabel={label} editable={false} onSave={async () => undefined}
            onNavigate={() => undefined} /></button> : <CollectionCell property={property}
          value={record.values[property.id]} options={selectionOptionsForProperty(property, selectionOptions, availableCollections)}
          recordLabel={label} editable={editable} onSave={(value) => saveCell(record.id, property.id, value)}
          onNavigate={(direction) => focusCell(row, column, direction)} />}</td>)}{editable ? <td aria-hidden="true" /> : null}</tr>; })}
      {editable ? newRecord ? <tr className={styles.newRecord}>{tableProperties.map((property) => <td key={property.id}>
        <CollectionDraftControl property={property} options={selectionOptionsForProperty(property, selectionOptions, availableCollections)}
          label={`${property.name}, new record`} autoFocus={property.id === primaryProperty?.id} value={newValues[property.id] ?? collectionValueDraft(property)}
          onChange={(value) => setNewValues((current) => ({ ...current, [property.id]: value }))} onConfirm={() => void createRecord()}
          onCancel={() => { setNewRecord(false); setNewValues({}); }} /></td>)}<td><Button type="button" pending={pending} onClick={() => void createRecord()}>Save record</Button></td></tr>
        : <tr className={styles.newRecordAction}><td colSpan={tableProperties.length + 1}><button type="button" onClick={() => setNewRecord(true)}>New record</button></td></tr> : null}
    </tbody></table></div>
      : definition.presentation === "board" ? <BoardView title={sectionTitle} collection={collection} records={evaluated.records} definition={definition}
        editable={editable} onFocus={focusRecord} onMove={async (recordId, source, destination) => {
          const patch = updateBoardGroup(collection, definition, recordId, source, destination);
          const [[propertyId, canonicalValue]] = Object.entries(patch.values); await saveCell(recordId, propertyId!, canonicalValue!); }} />
        : definition.presentation === "list" ? <ListView title={sectionTitle} collection={collection} records={evaluated.records} editable={editable} onFocus={focusRecord} />
          : <CalendarView title={sectionTitle} collection={collection} records={evaluated.records} definition={definition} editable={editable} onFocus={focusRecord} />}
    {focused ? <p className={styles.focusedRecord} role="status">Focused record: {recordTitle(collection, focused)}</p> : null}
    <CollectionImpactDialog open={crossNoteDisclosureOpen} onOpenChange={(open) => { setCrossNoteDisclosureOpen(open); if (!open && !crossNoteEditAcknowledged) crossNoteTrigger.current?.focus(); }}
      title="Edit this canonical record?" description="This View points to one canonical Collection. Your changes will appear everywhere this Collection is used."
      confirmLabel="Continue editing" cancelLabel="Cancel" confirmVariant="primary" pending={false} error="" returnFocusRef={crossNoteTrigger}
      onConfirm={() => { const cell = requestedEditCell; setCrossNoteEditAcknowledged(true); setCrossNoteDisclosureOpen(false); requestAnimationFrame(() => {
        if (!cell) return; const [row, column] = cell.split("-"); collectionRoot.current?.querySelector<HTMLElement>(
          `[data-collection-cell="${collection.id}-${row}-${column}"] input, [data-collection-cell="${collection.id}-${row}-${column}"] select`)?.focus(); }); }}>
      <p>The record remains one shared source of truth; this is not a private copy.</p>
    </CollectionImpactDialog>
    <CollectionImpactDialog open={moveOpen} onOpenChange={(open) => { setMoveOpen(open); if (!open) { setDestination(""); moreTrigger.current?.focus(); } }}
      title={`Move ${collection.title} collection?`} description="The Collection remains canonical; its records, relations, and inserted views stay connected."
      confirmLabel="Move collection" cancelLabel="Cancel move" confirmVariant="primary" confirmDisabled={!destination.trim()}
      pending={pending} error={error} returnFocusRef={moreTrigger} onConfirm={() => void moveCollection()}>
      <p>{selectedImpact?.recordCount ?? collection.records.length} record{(selectedImpact?.recordCount ?? collection.records.length) === 1 ? "" : "s"} will move with this Collection.</p>
      <p>{relationTotal} relation reference{relationTotal === 1 ? "" : "s"} will keep pointing to it.</p>
      <p>{viewTotal} inserted view{viewTotal === 1 ? "" : "s"} will keep showing it.</p>
      <label className={styles.dialogField}>Destination Note<select required value={destination} onChange={(event) => setDestination(event.target.value)}>
        <option value="">Choose a Note</option>{availableNotes.filter(({ id }) => id !== collection.ownerNoteId).map((note) =>
          <option key={note.id} value={note.id}>{note.title}</option>)}</select></label>
    </CollectionImpactDialog>
    <CollectionImpactDialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) moreTrigger.current?.focus(); }} title={`Delete ${collection.title} collection?`}
      description="This permanently removes the canonical records and every inserted view of them." confirmLabel="Delete collection" cancelLabel="Cancel deletion"
      pending={pending} error={error} returnFocusRef={moreTrigger} onConfirm={() => void deleteCollection()}>
      <p>{selectedImpact?.recordCount ?? collection.records.length} record{(selectedImpact?.recordCount ?? collection.records.length) === 1 ? "" : "s"} will be deleted.</p>
      <p>{relationTotal} relation reference{relationTotal === 1 ? "" : "s"} will be removed.</p>
      <p>{viewTotal} inserted view{viewTotal === 1 ? "" : "s"} will be removed.</p>
    </CollectionImpactDialog>
  </section>;
}
