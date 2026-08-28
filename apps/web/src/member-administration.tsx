import { useGSAP } from "@gsap/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import styles from "./member-administration.module.css";
import { Button, StatusNotice } from "./ui/control";

export interface OrganizationAdministration {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly members: ReadonlyArray<{ readonly id: string; readonly name: string; readonly email: string; readonly role: "Owner" | "Admin" | "Member" }>;
}

export function MemberAdministrationPage({ administrations, activeOrganizationId, currentMemberId, token }:
  { readonly administrations?: readonly OrganizationAdministration[]; readonly activeOrganizationId?: string;
    readonly currentMemberId?: string; readonly token?: string }) {
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(() =>
    administrations?.some(({ organizationId }) => organizationId === activeOrganizationId)
      ? activeOrganizationId : administrations?.[0]?.organizationId);
  const administration = administrations?.find(({ organizationId }) => organizationId === selectedOrganizationId);
  const availableAdministrations = administrations ?? [];
  const [candidate, setCandidate] = useState<OrganizationAdministration["members"][number]>();
  const [departed, setDeparted] = useState<OrganizationAdministration["members"][number]>();
  const confirmationRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const removal = useMutation({
    mutationFn: async (member: OrganizationAdministration["members"][number]) => {
      const response = await fetch(`/api/organizations/${encodeURIComponent(administration!.organizationId)}/members/${encodeURIComponent(member.id)}`, {
        method: "DELETE", headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(response.status === 409
        ? "Ownership must be transferred before this Member can leave."
        : "The Member could not be removed. No authority was changed.");
      return member;
    },
    onSuccess: async (member) => {
      await queryClient.invalidateQueries({ queryKey: ["member-session", token] });
      setCandidate(undefined);
      setDeparted(member);
    },
  });
  useGSAP(() => {
    if (!confirmationRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(confirmationRef.current, { opacity: 0, y: 8, duration: .3, ease: "power2.out", clearProps: "all" });
  }, { dependencies: [candidate?.id] });
  useEffect(() => { if (candidate) confirmationRef.current?.focus(); }, [candidate]);

  if (!administration || !token) return <div className={styles.page}><StatusNotice tone="error">Organization Member administration is unavailable for this account. No access was changed.</StatusNotice></div>;
  const eligibleMembers = administration.members.filter(({ id }) => id !== currentMemberId && id !== departed?.id);
  return <article className={styles.page} aria-labelledby="members-title">
    <header className={styles.header}><h1 id="members-title">Member access</h1>
      <p>Review access to {administration.organizationName} without erasing the work and decisions a person contributed.</p></header>
    {availableAdministrations.length > 1 ? <label className={styles.organizationPicker}>Organization
      <select value={administration.organizationId} onChange={(event) => {
        removal.reset(); setCandidate(undefined); setDeparted(undefined); setSelectedOrganizationId(event.target.value);
      }}>{availableAdministrations.map((organization) => <option key={organization.organizationId} value={organization.organizationId}>{organization.organizationName}</option>)}</select>
    </label> : null}
    {departed ? <section className={styles.completion} aria-live="polite" aria-labelledby="departure-complete">
      <div><h2 id="departure-complete">{departed.name} no longer has access</h2><p>Sessions, personal credentials, Agent Grants, and personal Repository Connections were revoked. Historical attribution remains intact.</p></div>
      <Link className={styles.taskLink} to="/app/tasks">Review Tasks</Link>
    </section> : null}
    <section className={styles.roster} aria-labelledby="active-members"><div><h2 id="active-members">Active Members</h2><p>Only current, server-verified Organization Members are eligible.</p></div>
      <ul>{eligibleMembers.map((member) => <li key={member.id}><span><strong>{member.name}</strong><small>{member.email} · {member.role}</small></span>
        <Button type="button" variant="secondary" onClick={() => { removal.reset(); setCandidate(member); }}>Review departure</Button></li>)}</ul>
    </section>
    {candidate ? <div className={styles.confirmation} ref={confirmationRef} role="region" aria-labelledby="confirm-departure" tabIndex={-1}>
      <h2 id="confirm-departure">Remove {candidate.name} from {administration.organizationName}?</h2>
      <p>Their active authority will be revoked immediately. Authorship stays preserved, and Tasks remain visibly marked until someone takes responsibility.</p>
      <div className={styles.actions}><Button type="button" variant="secondary" onClick={() => setCandidate(undefined)}>Keep Member</Button>
        <Button type="button" variant="danger" pending={removal.isPending} pendingLabel="Removing…" onClick={() => removal.mutate(candidate)}>Remove Member</Button></div>
      {removal.isError ? <StatusNotice tone="error">{removal.error.message} The Member still has their previous access.</StatusNotice> : null}
    </div> : null}
  </article>;
}
