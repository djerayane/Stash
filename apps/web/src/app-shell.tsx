import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { useGSAP } from "@gsap/react";
import { useMutation } from "@tanstack/react-query";
import gsap from "gsap";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router";
import styles from "./app-shell.module.css";
import { DevelopmentSignalsRoute } from "./development-signals";
import { NoteEditor } from "./note-editor";
import { TaskDetailPage } from "./task-detail";
import { MemberAdministrationPage, type OrganizationAdministration } from "./member-administration";
import { ProjectNotificationsPage } from "./project-notifications";
import { ImportedIdentitiesPage } from "./imported-identities";
import { MemberSettingsPage, OrganizationSettingsPage, WorkspaceDataPage } from "./product-settings";
import { ActivityPage, BoardsPage, DiscussionsPage, InboxPage, NoteHistoryPage, NotificationsPage, ProjectGatewayPage, SearchPage } from "./core-workflows";
import { AgentGrantsPage } from "./agent-grants";
import { NoteTree } from "./knowledge-authoring/note-tree";
import { NoteWorkspace } from "./knowledge-authoring/note-workspace";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "error"; readonly message: string; readonly retry?: () => void }
  | { readonly status: "authenticated"; readonly token?: string; readonly member: { readonly id: string; readonly name: string; readonly email: string }; readonly workspace: { readonly id?: string; readonly name: string }; readonly capabilities: readonly string[]; readonly organizationAdministrations?: readonly OrganizationAdministration[]; readonly activeOrganizationId?: string };

interface AppShellProps { readonly session?: SessionState }

export function resolveReturnTo(search: string): string {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate || candidate.includes("\\") || candidate.startsWith("//")) return "/app";
  return candidate === "/app" || candidate.startsWith("/app/") || candidate.startsWith("/app?") ? candidate : "/app";
}

interface TokenStorage { setItem(key: string, value: string): void }

export function completeOidcBrowserCallback(fragment: string, returnTo: string | null, storage: TokenStorage): string {
  const token = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment).get("token");
  if (!token) throw new Error("OpenID Connect sign-in could not be completed.");
  storage.setItem("stash.member-session", JSON.stringify({ token }));
  return resolveReturnTo(new URLSearchParams({ returnTo: returnTo ?? "/app" }).toString());
}

const navigation = [
  { to: "/app/inbox", label: "Inbox", icon: "inbox" },
  { to: "/app/notes", label: "Note Tree", icon: "note" },
  { to: "/app/search", label: "Search", icon: "search" },
  { to: "/app/tasks", label: "Tasks", icon: "task" },
] as const;

interface ContextStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const defaultContext = "/app/notes";
export const lastActiveContextKey = (workspaceId: string) => `stash.last-active-context:${workspaceId}`;
export function isRestorableContext(value: string): boolean {
  return value === "/app/inbox" || value === "/app/notes" || value.startsWith("/app/notes/") || value === "/app/search" || value.startsWith("/app/search?") || value === "/app/tasks" || value.startsWith("/app/tasks?");
}
export function restoreLastActiveContext(workspaceId: string, storage: ContextStorage = localStorage): string {
  try { const value = storage.getItem(lastActiveContextKey(workspaceId)); return value && isRestorableContext(value) ? value : defaultContext; }
  catch { return defaultContext; }
}

export function displayLabel(value: string, fallback: string): string {
  return value.trim() || fallback;
}

export function initials(value: string, fallback: string): string {
  const result = value.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");
  return result || fallback;
}

function Icon({ name }: { readonly name: string }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7" /><path d="M5 9v11h14V9M9 20v-7h6v7" /></>,
    note: <><path d="M6 3h9l3 3v15H6z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
    task: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8 12 2.5 2.5L16 9" /></>,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    members: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5" /></>,
    import: <><circle cx="12" cy="12" r="8" /><path d="M8 12h8M12 8v8" /></>,
    agents: <><path d="M7 8h10v9H7zM9 4h6M12 4v4"/><circle cx="10" cy="12" r=".5"/><circle cx="14" cy="12" r=".5"/><path d="M10 15h4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
    inbox: <><path d="M4 5h16v14H4z"/><path d="M4 13h5l2 3h2l2-3h5"/></>,
  };
  return <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function StateScreen({ state }: { readonly state: Extract<SessionState, { status: "loading" | "error" }> }) {
  const loading = state.status === "loading";
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!loading) alertRef.current?.focus(); }, [loading]);
  return <main
    className={styles.stateScreen}
    aria-busy={loading || undefined}
  >
    <div
      aria-atomic={loading ? undefined : true}
      aria-live={loading ? undefined : "assertive"}
      ref={alertRef}
      role={loading ? undefined : "alert"}
      tabIndex={loading ? undefined : -1}
    >
      <span className={loading ? styles.loader : styles.errorMark} aria-hidden="true" />
      <p className={styles.kicker}>{loading ? "Stash" : "Connection interrupted"}</p>
      <h1>{loading ? "Opening your workspace" : "Workspace unavailable"}</h1>
      <p>{loading ? "Restoring the context you left behind." : state.message}</p>
      {!loading && state.retry ? <button className={styles.primaryButton} type="button" onClick={state.retry}>Try again</button> : null}
    </div>
  </main>;
}

function AuthenticationNotice({ children, role }: { readonly children: ReactNode; readonly role: "alert" | "status" }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <p className={styles.authenticationNotice} ref={ref} role={role} tabIndex={-1}>{children}</p>;
}

function SignIn({ returnTo }: { readonly returnTo: string }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [code, setCode] = useState(""); const [organizationId, setOrganizationId] = useState(""); const [method, setMethod] = useState<"password" | "passkey" | "recovery" | "email" | "emailToken" | "oidc">("password");
  const complete = (body: { token?: string; message?: string }) => { if (!body.token) throw new Error(body.message || "Sign-in could not be completed."); localStorage.setItem("stash.member-session", JSON.stringify({ token: body.token })); window.location.assign(returnTo); };
  const post = async (path: string, value: unknown) => { const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }); const body = await response.json() as { token?: string; message?: string; status?: string }; if (!response.ok) throw new Error(body.message || "Authentication could not be completed."); return body; };
  const signIn = useMutation({ mutationFn: async () => {
    if (method === "recovery") { complete(await post("/api/auth/recovery-code-sessions", { email, code })); return; }
    if (method === "email") { await post("/api/auth/email-recovery", { email }); return; }
    if (method === "emailToken") { complete(await post("/api/auth/email-recovery-sessions", { token: code })); return; }
    if (method === "oidc") { const response = await fetch(`/api/auth/oidc/${encodeURIComponent(organizationId)}`); const body = await response.json() as { authorizationUrl?: string; message?: string }; if (!response.ok || !body.authorizationUrl) throw new Error(body.message || "OpenID Connect is unavailable."); sessionStorage.setItem("stash.oidc-return-to", returnTo); window.location.assign(body.authorizationUrl); return; }
    if (method === "passkey") { const options = await post("/api/auth/passkey-sessions/options", { email }) as Record<string, unknown>; const parser = (PublicKeyCredential as unknown as { parseRequestOptionsFromJSON?: (value: unknown) => PublicKeyCredentialRequestOptions }).parseRequestOptionsFromJSON; const credential = await navigator.credentials.get({ publicKey: parser ? parser(options) : options as unknown as PublicKeyCredentialRequestOptions }); if (!credential) throw new Error("Passkey sign-in was cancelled."); const serializable = "toJSON" in credential && typeof credential.toJSON === "function" ? credential.toJSON() : credential; complete(await post("/api/auth/passkey-sessions", serializable)); return; }
    const response = await fetch("/api/auth/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const body = await response.json() as { token?: string; message?: string };
    if (!response.ok || !body.token) throw new Error(body.message || "Sign-in could not be completed.");
    complete(body);
  } });
  return <main className={styles.signIn}>
    <div className={styles.signInBrand}><span className={styles.brandMark}>S</span><span>Stash</span></div>
    <section className={styles.signInPanel} aria-labelledby="sign-in-title">
      <p className={styles.kicker}>Welcome back</p><h1 id="sign-in-title">Sign in to Stash</h1>
      <p>Your Instance manages access. Use the authentication method configured by your administrator.</p>
      <div className={styles.authMethods} role="group" aria-label="Authentication method">{(["password", "passkey", "recovery", "email", "emailToken", "oidc"] as const).map((item) => <button aria-pressed={method === item} key={item} onClick={() => setMethod(item)} type="button">{item === "recovery" ? "Recovery code" : item === "email" ? "Email recovery" : item === "emailToken" ? "Recovery link" : item === "oidc" ? "OpenID Connect" : item[0]!.toUpperCase() + item.slice(1)}</button>)}</div>
      <form className={styles.signInForm} onSubmit={(event) => { event.preventDefault(); signIn.mutate(); }}>{method !== "oidc" && method !== "emailToken" ? <label>Email<input autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label> : method === "oidc" ? <label>Organization ID<input required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} /></label> : null}{method === "password" ? <label>Password<input autoComplete="current-password" minLength={12} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label> : method === "recovery" ? <label>Recovery code<input autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} /></label> : method === "emailToken" ? <label>Email recovery token<input autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} /></label> : null}<button className={styles.primaryButton} disabled={signIn.isPending} type="submit">{signIn.isPending ? "Working…" : method === "email" ? "Send recovery email" : method === "oidc" ? "Continue with OpenID Connect" : "Sign in"}</button>{method === "email" && signIn.isSuccess ? <AuthenticationNotice role="status">If the account exists, recovery instructions have been queued.</AuthenticationNotice> : null}{signIn.isError ? <AuthenticationNotice role="alert">{signIn.error.message}</AuthenticationNotice> : null}</form>
      <p className={styles.authSwitch}>New to this Instance? <Link className={styles.textLink} to={`/sign-up?returnTo=${encodeURIComponent(returnTo)}`}>Create an account</Link></p>
    </section>
  </main>;
}

function SignUp({ returnTo }: { readonly returnTo: string }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState(""); const [enabled, setEnabled] = useState<boolean>();
  useEffect(() => { let active = true; void fetch("/api/auth/registration").then(async (response) => {
    const body = await response.json() as { enabled?: boolean }; if (active) setEnabled(response.ok && body.enabled === true);
  }).catch(() => { if (active) setEnabled(false); }); return () => { active = false; }; }, []);
  const registration = useMutation({ mutationFn: async () => {
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const response = await fetch("/api/auth/registration", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) });
    const body = await response.json() as { token?: string; message?: string };
    if (!response.ok || !body.token) throw new Error(body.message || "Account registration could not be completed.");
    localStorage.setItem("stash.member-session", JSON.stringify({ token: body.token })); window.location.assign(returnTo);
  } });
  return <main className={styles.signIn}>
    <div className={styles.signInBrand}><span className={styles.brandMark}>S</span><span>Stash</span></div>
    <section className={styles.signInPanel} aria-labelledby="sign-up-title">
      <p className={styles.kicker}>Your own place to think</p><h1 id="sign-up-title">Create an account</h1>
      <p>Start with a personal Workspace on this Instance. Your information remains portable.</p>
      {enabled === false ? <p className={styles.authenticationNotice} role="status">Account registration is closed on this Instance. Ask an Instance Administrator for access.</p> : <form className={styles.signInForm} onSubmit={(event) => { event.preventDefault(); registration.mutate(); }}>
        <label>Name<input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Email<input autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input autoComplete="new-password" minLength={12} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>Confirm password<input autoComplete="new-password" minLength={12} required type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className={styles.primaryButton} disabled={registration.isPending || enabled === undefined} type="submit">{registration.isPending ? "Creating account…" : "Create account"}</button>
        {registration.isError ? <AuthenticationNotice role="alert">{registration.error.message}</AuthenticationNotice> : null}
      </form>}
      <p className={styles.authSwitch}>Already have an account? <Link className={styles.textLink} to={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</Link></p>
    </section>
  </main>;
}

function OidcCallback() {
  const handled = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    try {
      const destination = completeOidcBrowserCallback(window.location.hash, sessionStorage.getItem("stash.oidc-return-to"), localStorage);
      sessionStorage.removeItem("stash.oidc-return-to");
      window.location.replace(destination);
    } catch (cause) {
      window.history.replaceState(null, "", "/auth/oidc/callback");
      setError(cause instanceof Error ? cause.message : "OpenID Connect sign-in could not be completed.");
    }
  }, []);
  return <main className={styles.stateScreen}><div aria-live="assertive" role={error ? "alert" : "status"}><p className={styles.kicker}>OpenID Connect</p><h1>{error ? "Sign-in interrupted" : "Completing sign-in"}</h1><p>{error || "Restoring your Workspace."}</p>{error ? <Link className={styles.primaryButton} to="/sign-in">Return to sign in</Link> : null}</div></main>;
}

function EmptyHome() {
  return <div className={styles.page}>
    <header className={styles.pageHeader}>
      <div><p className={styles.kicker}>Today</p><h1>Good morning.</h1><p className={styles.lede}>A quiet workspace is room to think clearly.</p></div>
      <Link className={styles.primaryButton} to="/app/notes/new"><Icon name="plus" />Capture a note</Link>
    </header>
    <section className={styles.emptyState} aria-labelledby="empty-title">
      <div className={styles.emptyGraphic} aria-hidden="true"><span /><span /><span /></div>
      <div><h2 id="empty-title">Nothing needs your attention</h2><p>Capture an idea now, or return when new work reaches your Workspace.</p><Link className={styles.textLink} to="/app/notes/new">Capture a note <span aria-hidden="true">→</span></Link></div>
    </section>
    <aside className={styles.quietNote} aria-label="Workspace philosophy"><span>Quiet by design</span><p>Stash keeps planning close to the work without manufacturing urgency.</p></aside>
  </div>;
}

function PlaceholderPage({ workspaceName, title, description, action, actionTo }: { readonly workspaceName: string; readonly title: string; readonly description: string; readonly action: string; readonly actionTo?: string }) {
  return <div className={styles.page}>
    <header className={styles.pageHeader}><div><p className={styles.kicker}>{workspaceName}</p><h1>{title}</h1><p className={styles.lede}>{description}</p></div>{actionTo ? <Link className={styles.primaryButton} to={actionTo}><Icon name="plus" />{action}</Link> : <span className={styles.actionHint}><Icon name="plus" />{action}</span>}</header>
    <section className={styles.placeholder} aria-label={`${title} empty state`}><span className={styles.placeholderRule} /><h2>Your {title.toLowerCase()} will live here.</h2><p>The shell is ready for the focused product flow that follows this migration foundation.</p></section>
  </div>;
}

function WorkspaceShell({ session }: { readonly session: Extract<SessionState, { status: "authenticated" }> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [activeWorkspace,setActiveWorkspace]=useState(session.workspace);
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const workspaceName = displayLabel(activeWorkspace.name, "Personal workspace");
  const memberName = displayLabel(session.member.name, displayLabel(session.member.email, "Member"));
  const memberEmail = displayLabel(session.member.email, "Signed in");
  const activeNoteId = /^\/app\/notes\/[^/]+$/.test(location.pathname) && location.pathname !== "/app/notes/new"
    ? decodeURIComponent(location.pathname.split("/")[3]!) : undefined;
  useGSAP(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(`.${styles.sidebar} > *, .${styles.topbar} > *`, { opacity: 0, y: 8, duration: 0.45, stagger: 0.06, ease: "power2.out", clearProps: "all" });
  }, { scope: shellRef });
  useGSAP(() => {
    const content = mainRef.current?.firstElementChild;
    if (!content || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(content, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.38, ease: "power2.out", clearProps: "all" });
  }, { scope: shellRef, dependencies: [location.pathname] });
  useEffect(() => { mainRef.current?.focus(); }, [location.pathname]);
  useEffect(() => {
    if (!activeWorkspace.id || !isRestorableContext(`${location.pathname}${location.search}`) || location.pathname === "/app") return;
    try { localStorage.setItem(lastActiveContextKey(activeWorkspace.id), `${location.pathname}${location.search}`); } catch { /* Browsing still works when local storage is unavailable. */ }
  }, [activeWorkspace.id, location.pathname, location.search]);
  return <div className={styles.shell} ref={shellRef}>
    <a className={styles.skipLink} href="#workspace-content">Skip to content</a>
    <aside className={styles.sidebar} aria-label="Application navigation">
      <Link className={styles.brand} to="/app" aria-label="Stash home"><span className={styles.brandMark}>S</span><span>Stash</span></Link>
      <NavigationMenu.Root className={styles.navigationRoot} orientation="vertical" aria-label="Workspace"><NavigationMenu.List className={styles.navigation}>
        {navigation.map((item) => <NavigationMenu.Item key={item.to}><NavigationMenu.Link asChild><NavLink className={styles.navLink}
          end={item.to === "/app/inbox" || item.to === "/app/search"} to={item.to}><Icon name={item.icon} />{item.label}</NavLink></NavigationMenu.Link></NavigationMenu.Item>)}
        <NavigationMenu.Item><NavigationMenu.Link asChild><NavLink className={styles.navLink} to="/app/settings"><Icon name="settings" />Settings</NavLink></NavigationMenu.Link></NavigationMenu.Item>
        {session.activeOrganizationId ? <NavigationMenu.Item><NavigationMenu.Link asChild><NavLink className={styles.navLink} to="/app/settings/agents"><Icon name="agents" />Agents</NavLink></NavigationMenu.Link></NavigationMenu.Item> : null}
        {session.organizationAdministrations?.length ? <><NavigationMenu.Item><NavigationMenu.Link asChild><NavLink className={styles.navLink} to="/app/settings/organization"><Icon name="settings" />Organization</NavLink></NavigationMenu.Link></NavigationMenu.Item><NavigationMenu.Item><NavigationMenu.Link asChild><NavLink className={styles.navLink} to="/app/settings/members"><Icon name="members" />Members</NavLink></NavigationMenu.Link></NavigationMenu.Item><NavigationMenu.Item><NavigationMenu.Link asChild><NavLink className={styles.navLink} to="/app/settings/imported-identities"><Icon name="import" />Imported identities</NavLink></NavigationMenu.Link></NavigationMenu.Item></> : null}
      </NavigationMenu.List></NavigationMenu.Root>
      {activeWorkspace.id ? <NoteTree activeNoteId={activeNoteId} token={session.token ?? ""} workspaceId={activeWorkspace.id} /> : null}
      <div className={styles.sidebarFooter}><span className={styles.avatar} aria-hidden="true">{initials(memberName, "M")}</span><span><strong>{memberName}</strong><small>{memberEmail}</small></span></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar}><form className={styles.searchPreview} role="search" onSubmit={(event: FormEvent) => { event.preventDefault(); if (search.trim()) navigate(`/app/search?q=${encodeURIComponent(search.trim())}`); }}><Icon name="search" /><input aria-label="Search Workspace" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Notes" /></form><Link aria-label="Notifications" className={styles.notificationLink} to="/app/notifications">Notifications</Link><Link className={styles.compactCreate} to="/app/inbox"><Icon name="plus" /><span>Capture</span></Link></header>
      {activeNoteId
        ? <NoteWorkspace noteId={activeNoteId} token={session.token ?? ""}><NoteEditor contextVisible={false} noteId={activeNoteId} memberId={session.member.id} token={session.token ?? ""} /></NoteWorkspace>
        : <main id="workspace-content" className={styles.content} ref={mainRef} tabIndex={-1}>
        <Routes>
          <Route path="/app" element={<Navigate replace to={restoreLastActiveContext(activeWorkspace.id ?? workspaceName)} />} />
          <Route path="/app/inbox" element={<InboxPage workspaceId={activeWorkspace.id ?? ""} token={session.token ?? ""} />} />
          <Route path="/app/notes" element={<NoteTree token={session.token ?? ""} variant="page" workspaceId={activeWorkspace.id ?? ""} />} />
          <Route path="/app/notes/new" element={<Navigate replace to="/app/notes" />} />
          <Route path="/app/notes/:noteId/history" element={<NoteHistoryPage token={session.token ?? ""} />} />
          <Route path="/app/tasks" element={<ProjectGatewayPage workspaceId={activeWorkspace.id ?? ""} token={session.token ?? ""} />} />
          <Route path="/app/projects/:projectId/boards" element={<BoardsPage token={session.token ?? ""} />} />
          <Route path="/app/projects/:projectId/boards/:boardId" element={<BoardsPage token={session.token ?? ""} />} />
          <Route path="/app/notes/:targetId/discussions" element={<DiscussionsPage targetKind="note" token={session.token ?? ""} />} />
          <Route path="/app/tasks/:targetId/discussions" element={<DiscussionsPage targetKind="task" token={session.token ?? ""} />} />
          <Route path="/app/notes/:targetId/blocks/:blockKey/discussions" element={<DiscussionsPage targetKind="block" token={session.token ?? ""} />} />
          <Route path="/app/projects/:projectId/tasks/:taskKey/development" element={<DevelopmentSignalsRoute />} />
          <Route path="/app/projects/:projectId/tasks/:taskKey" element={<TaskDetailPage memberId={session.member.id} token={session.token} />} />
          <Route path="/app/projects/:projectId/notifications" element={<ProjectNotificationsPage token={session.token} />} />
          <Route path="/app/settings/members" element={<MemberAdministrationPage administrations={session.organizationAdministrations} activeOrganizationId={session.activeOrganizationId} currentMemberId={session.member.id} token={session.token} />} />
          <Route path="/app/settings" element={<MemberSettingsPage token={session.token ?? ""} />} />
          <Route path="/app/settings/data" element={<WorkspaceDataPage token={session.token ?? ""} workspaceId={activeWorkspace.id ?? ""} memberId={session.member.id} onOpenWorkspace={(workspaceId)=>{setActiveWorkspace({id:workspaceId,name:"Imported Workspace"});navigate("/app/notes");}} />} />
          <Route path="/app/settings/organization" element={session.organizationAdministrations?.length ? <OrganizationSettingsPage token={session.token ?? ""} administrations={session.organizationAdministrations} activeOrganizationId={session.activeOrganizationId} /> : <Navigate replace to="/app/settings" />} />
          <Route path="/app/settings/imported-identities" element={<ImportedIdentitiesPage administrations={session.organizationAdministrations} currentMember={session.member} token={session.token} />} />
          <Route path="/app/activity" element={<ActivityPage workspaceId={activeWorkspace.id ?? ""} token={session.token ?? ""} />} />
          <Route path="/app/notifications" element={<NotificationsPage token={session.token ?? ""} />} />
          <Route path="/app/search" element={<SearchPage workspaceId={activeWorkspace.id ?? ""} token={session.token ?? ""} />} />
          <Route path="/app/settings/agents" element={<AgentGrantsPage organizationId={session.activeOrganizationId} token={session.token} />} />
          <Route path="*" element={<PlaceholderPage workspaceName={workspaceName} title="Not found" description="This Workspace route does not exist." action="Go home" actionTo="/app" />} />
        </Routes>
      </main>}
    </div>
  </div>;
}

export function AppShell({ session = { status: "loading" } }: AppShellProps) {
  const location = useLocation();
  if (location.pathname === "/auth/oidc/callback") return <OidcCallback />;
  if (session.status === "loading" || session.status === "error") return <StateScreen state={session} />;
  if (session.status === "anonymous") {
    if (location.pathname === "/sign-in") return <SignIn returnTo={resolveReturnTo(location.search)} />;
    if (location.pathname === "/sign-up") return <SignUp returnTo={resolveReturnTo(location.search)} />;
    return <Navigate replace to={`/sign-in?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`} />;
  }
  if (location.pathname === "/sign-in" || location.pathname === "/sign-up") return <Navigate replace to={resolveReturnTo(location.search)} />;
  if (location.pathname === "/") return <Navigate replace to="/app" />;
  return <WorkspaceShell session={session} />;
}
