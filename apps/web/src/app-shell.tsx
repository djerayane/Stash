import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, NavLink } from "react-router";
import styles from "./app-shell.module.css";

interface AppShellProps {
  fetcher?: typeof fetch;
  canManageSettings?: boolean;
}

function InstanceStatus({ fetcher = globalThis.fetch }: Pick<AppShellProps, "fetcher">) {
  const alertRef = useRef<HTMLDivElement>(null);
  const readiness = useQuery({
    queryKey: ["instance-readiness"],
    retry: false,
    queryFn: async () => {
      const response = await fetcher("/health/ready", { credentials: "include" });
      if (!response.ok) throw new Error("Instance unavailable");
      return response.json() as Promise<{ status: "ready" }>;
    },
  });

  useEffect(() => {
    if (readiness.isError) alertRef.current?.focus();
  }, [readiness.isError]);

  if (readiness.isError) {
    return (
      <div className={styles.instanceError} role="alert" ref={alertRef} tabIndex={-1}>
        <span>The Instance could not be reached.</span>
        <button type="button" onClick={() => void readiness.refetch()}>Try again</button>
      </div>
    );
  }

  return <p className={styles.instanceStatus} role="status">{readiness.isSuccess ? "Instance ready" : "Checking Instance"}</p>;
}

export function AppShell({ fetcher, canManageSettings = false }: AppShellProps = {}) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.brand} to="/" aria-label="Stash home">Stash</Link>
        <NavigationMenu.Root aria-label="Workspace">
          <NavigationMenu.List className={styles.navigation}>
            <NavigationMenu.Item>
              <NavigationMenu.Link asChild><NavLink className={styles.link} to="/notes">Notes</NavLink></NavigationMenu.Link>
            </NavigationMenu.Item>
            <NavigationMenu.Item>
              <NavigationMenu.Link asChild><NavLink className={styles.link} to="/tasks">Tasks</NavLink></NavigationMenu.Link>
            </NavigationMenu.Item>
            {canManageSettings ? (
              <NavigationMenu.Item>
                <NavigationMenu.Link asChild><NavLink className={styles.link} to="/settings/instance">Administration</NavLink></NavigationMenu.Link>
              </NavigationMenu.Item>
            ) : null}
          </NavigationMenu.List>
        </NavigationMenu.Root>
      </header>
      <main className={styles.main}>
        <p className={styles.eyebrow}>Your workspace</p>
        <h1 className={styles.title}>Keep the work that matters within reach.</h1>
        <p className={styles.summary}>The React client foundation is ready for Notes, Tasks, and collaborative editing.</p>
        <InstanceStatus fetcher={fetcher} />
      </main>
    </div>
  );
}
