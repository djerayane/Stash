import type { RelationshipDirection, RelationshipNeighborhood } from "@stash/domain-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import styles from "./note-tree.module.css";
import { RelatedNotesNeighborhood } from "./related-notes-neighborhood";

interface Maintenance {
  orphans: Array<{ id: string; title: string }>;
  brokenLinks: Array<{ id: string; sourceNoteId: string; sourceTitle: string; label: string; targetPath?: string; revision: number;
    candidates: Array<{ id: string; title: string }> }>;
}

export function RelatedNotes({ noteId, workspaceId, token, access, fetcher = globalThis.fetch }: {
  noteId: string; workspaceId: string; token: string; access: "edit" | "read"; fetcher?: typeof fetch;
}) {
  const [depth, setDepth] = useState(1); const [limit, setLimit] = useState(24);
  const [direction, setDirection] = useState<RelationshipDirection>("both");
  const [relationshipTypes, setRelationshipTypes] = useState("");
  const [repairTargets, setRepairTargets] = useState<Record<string, string>>({});
  const [maintenanceOpen, setMaintenanceOpen] = useState(false); const [status, setStatus] = useState("");
  const [expansionStatus, setExpansionStatus] = useState("");
  const region = useRef<HTMLElement>(null); const expansionStatusElement = useRef<HTMLParagraphElement>(null);
  const expansionBefore = useRef<Set<string> | undefined>(undefined);
  const client = useQueryClient(); const headers = { authorization: `Bearer ${token}` };
  const relationTypes = [...new Set(relationshipTypes.split(",").map((value) => value.trim()).filter(Boolean))];
  const related = useQuery({ queryKey: ["related-notes", noteId, depth, limit, direction, relationTypes], retry: false, queryFn: async () => {
    const parameters = new URLSearchParams({ depth: String(depth), limit: String(limit), direction, includeHierarchy: "true" });
    for (const relationshipType of relationTypes) parameters.append("relationType", relationshipType);
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/relationships?${parameters}`, { headers });
    const body = await response.json() as RelationshipNeighborhood & { message?: string };
    if (!response.ok || !Array.isArray(body.nodes) || !Array.isArray(body.edges) || !Array.isArray(body.outline))
      throw new Error(body.message || "Related Notes are unavailable."); return body;
  } });
  const maintenance = useQuery({ queryKey: ["relationship-maintenance", workspaceId], enabled: maintenanceOpen, retry: false,
    queryFn: async () => { const response = await fetcher(`/api/workspaces/${encodeURIComponent(workspaceId)}/relationships/maintenance`, { headers });
      const body = await response.json() as Maintenance & { message?: string }; if (!response.ok) throw new Error(body.message || "Relationship maintenance is unavailable."); return body; } });
  const repair = useMutation({ mutationFn: async ({ link, targetId }: { link: Maintenance["brokenLinks"][number]; targetId: string }) => {
    if (!link.candidates.some(({ id }) => id === targetId)) throw new Error("No accessible repair choice is available.");
    const response = await fetcher(`/api/notes/${encodeURIComponent(link.sourceNoteId)}/links/${encodeURIComponent(link.id)}/repair`, { method: "PUT",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ targetNoteId: targetId, expectedRevision: link.revision }) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The link could not be repaired.");
  }, onSuccess: async () => { setStatus("Link repaired."); await Promise.all([client.invalidateQueries({ queryKey: ["relationship-maintenance", workspaceId] }),
    client.invalidateQueries({ queryKey: ["related-notes", noteId] }), client.invalidateQueries({ queryKey: ["note-context", noteId] })]); } });
  useEffect(() => {
    const before = expansionBefore.current; if (!before || !related.data) return;
    const added = related.data.nodes.filter(({ id }) => !before.has(id));
    setExpansionStatus(added.length ? `${added.length} more related ${added.length === 1 ? "Note" : "Notes"} shown.` : "No additional related Notes were found.");
    expansionBefore.current = undefined;
    queueMicrotask(() => {
      const first = added[0] ? region.current?.querySelector<HTMLElement>(`[data-related-note-id="${added[0].id}"]`) : undefined;
      (first ?? expansionStatusElement.current)?.focus();
    });
  }, [related.data]);
  const resetBounds = () => { setDepth(1); setLimit(24); setExpansionStatus(""); };
  return <section aria-label="Related Notes" className={styles.relatedNotes} ref={region}>
    <header><div><h3>Related Notes</h3><p>A focused, permission-safe neighborhood around this Note.</p></div>
      <label>Relationship direction<select aria-label="Relationship direction" value={direction} onChange={(event) => { resetBounds(); setDirection(event.target.value as RelationshipDirection); }}>
        <option value="both">Both directions</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option></select></label>
      <label>Relationship types<input aria-label="Relationship types" placeholder="supports, untyped" value={relationshipTypes}
        onChange={(event) => { resetBounds(); setRelationshipTypes(event.target.value); }} /></label></header>
    {related.isPending ? <p role="status">Opening related Notes…</p> : related.isError ? <p role="alert">{related.error.message}</p>
      : related.data ? <><RelatedNotesNeighborhood neighborhood={related.data} />{related.data.hasMore && (depth < 3 || limit < 100) ? <button type="button"
        disabled={related.isFetching} onClick={() => { expansionBefore.current = new Set(related.data.nodes.map(({ id }) => id)); setExpansionStatus("");
          setDepth((current) => Math.min(3, current + 1)); setLimit((current) => Math.min(100, current + 24)); }}>Expand related Notes</button>
        : related.data.hasMore ? <p>Showing the maximum 100 related Notes.</p> : null}</> : null}
    {expansionStatus ? <p ref={expansionStatusElement} role="status" tabIndex={-1}>{expansionStatus}</p> : null}
    <button aria-expanded={maintenanceOpen} type="button" onClick={() => setMaintenanceOpen((open) => !open)}>Review relationship maintenance</button>
    {maintenanceOpen ? <div className={styles.relationshipMaintenance}>
      {maintenance.isPending ? <p role="status">Checking relationships…</p> : maintenance.isError ? <p role="alert">{maintenance.error.message}</p>
        : maintenance.data ? <><section><h4>Orphan Notes</h4>{maintenance.data.orphans.length ? <ul>{maintenance.data.orphans.map((note) =>
          <li key={note.id}><Link to={`/app/notes/${note.id}`}>{note.title}</Link></li>)}</ul> : <p>No orphan Notes.</p>}</section>
        {access === "edit" ? <section><h4>Broken links</h4>{maintenance.data.brokenLinks.length ? <ul>{maintenance.data.brokenLinks.map((link) => <li key={link.id}>
          <div><strong>{link.label}</strong><small>{link.sourceTitle}{link.targetPath ? ` · ${link.targetPath}` : ""}</small></div>
          {link.candidates.length ? <div className={styles.repairChoice}><label>Repair target<select aria-label={`Repair target for ${link.label}`}
            value={repairTargets[link.id] ?? link.candidates[0]!.id} onChange={(event) => setRepairTargets((current) => ({ ...current, [link.id]: event.target.value }))}>
            {link.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label>
            <button disabled={repair.isPending} type="button" onClick={() => repair.mutate({ link, targetId: repairTargets[link.id] ?? link.candidates[0]!.id })}
              aria-label={`Repair ${link.label}`}>Repair link</button></div> : <span>No accessible repair choice</span>}</li>)}</ul> : <p>No broken links.</p>}</section> : null}</> : null}
      {repair.isError ? <p role="alert">{repair.error.message}</p> : null}</div> : null}
    {status ? <p role="status">{status}</p> : null}
  </section>;
}
