import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import styles from "./app-shell.module.css";

export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "error"; readonly message: string; readonly retry?: () => void }
  | { readonly status: "authenticated"; readonly member: { readonly name: string; readonly email: string }; readonly workspace: { readonly name: string } };

interface AppShellProps { readonly session?: SessionState }

export function resolveReturnTo(search: string): string {
  const candidate = new URLSearchParams(search).get("returnTo");
  if (!candidate || candidate.includes("\\") || candidate.startsWith("//")) return "/app";
  return candidate === "/app" || candidate.startsWith("/app/") || candidate.startsWith("/app?") ? candidate : "/app";
}

const navigation = [
  { to: "/app", label: "Home", icon: "home" },
  { to: "/app/notes", label: "Notes", icon: "note" },
  { to: "/app/tasks", label: "Tasks", icon: "task" },
  { to: "/app/activity", label: "Activity", icon: "pulse" },
] as const;

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
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
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

function SignIn() {
  return <main className={styles.signIn}>
    <div className={styles.signInBrand}><span className={styles.brandMark}>S</span><span>Stash</span></div>
    <section className={styles.signInPanel} aria-labelledby="sign-in-title">
      <p className={styles.kicker}>Welcome back</p><h1 id="sign-in-title">Sign in to Stash</h1>
      <p>Your Instance manages access. Use the authentication method configured by your administrator.</p>
      <p className={styles.authenticationNotice} role="status">Interactive sign-in will be connected by the authentication flow migration.</p>
    </section>
  </main>;
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
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const workspaceName = displayLabel(session.workspace.name, "Personal workspace");
  const memberName = displayLabel(session.member.name, displayLabel(session.member.email, "Member"));
  const memberEmail = displayLabel(session.member.email, "Signed in");
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
  return <div className={styles.shell} ref={shellRef}>
    <a className={styles.skipLink} href="#workspace-content">Skip to content</a>
    <aside className={styles.sidebar} aria-label="Application navigation">
      <Link className={styles.brand} to="/app" aria-label="Stash home"><span className={styles.brandMark}>S</span><span>Stash</span></Link>
      <div className={styles.workspaceIdentity}><span className={styles.workspaceMonogram} aria-hidden="true">{initials(workspaceName, "PW")}</span><span><strong>{workspaceName}</strong><small>Workspace</small></span></div>
      <NavigationMenu.Root className={styles.navigationRoot} orientation="vertical" aria-label="Workspace"><NavigationMenu.List className={styles.navigation}>
        {navigation.map((item) => <NavigationMenu.Item key={item.to}><NavigationMenu.Link asChild><NavLink className={styles.navLink} end={item.to === "/app"} to={item.to}><Icon name={item.icon} />{item.label}</NavLink></NavigationMenu.Link></NavigationMenu.Item>)}
      </NavigationMenu.List></NavigationMenu.Root>
      <div className={styles.sidebarFooter}><span className={styles.avatar} aria-hidden="true">{initials(memberName, "M")}</span><span><strong>{memberName}</strong><small>{memberEmail}</small></span></div>
    </aside>
    <div className={styles.workspace}>
      <header className={styles.topbar}><div className={styles.searchPreview}><Icon name="search" /><span>Search coming soon</span></div><Link className={styles.compactCreate} to="/app/notes/new"><Icon name="plus" /><span>New note</span></Link></header>
      <main id="workspace-content" className={styles.content} ref={mainRef} tabIndex={-1}>
        <Routes>
          <Route path="/app" element={<EmptyHome />} />
          <Route path="/app/notes" element={<PlaceholderPage workspaceName={workspaceName} title="Notes" description="Ideas, decisions, and durable project knowledge." action="New note" actionTo="/app/notes/new" />} />
          <Route path="/app/notes/new" element={<PlaceholderPage workspaceName={workspaceName} title="New note" description="A focused editor will arrive in the rich-text migration slice." action="Save draft" />} />
          <Route path="/app/tasks" element={<PlaceholderPage workspaceName={workspaceName} title="Tasks" description="Actionable work connected to the thinking that shaped it." action="New task" />} />
          <Route path="/app/activity" element={<PlaceholderPage workspaceName={workspaceName} title="Activity" description="Meaningful changes, explained without unnecessary noise." action="Filter" />} />
          <Route path="*" element={<PlaceholderPage workspaceName={workspaceName} title="Not found" description="This Workspace route does not exist." action="Go home" actionTo="/app" />} />
        </Routes>
      </main>
    </div>
  </div>;
}

export function AppShell({ session = { status: "loading" } }: AppShellProps) {
  const location = useLocation();
  if (session.status === "loading" || session.status === "error") return <StateScreen state={session} />;
  if (session.status === "anonymous") {
    if (location.pathname === "/sign-in") return <SignIn />;
    return <Navigate replace to={`/sign-in?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`} />;
  }
  if (location.pathname === "/sign-in") return <Navigate replace to={resolveReturnTo(location.search)} />;
  if (location.pathname === "/") return <Navigate replace to="/app" />;
  return <WorkspaceShell session={session} />;
}
