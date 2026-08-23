import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import { Link, NavLink } from "react-router";
import styles from "./app-shell.module.css";

export function AppShell() {
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
          </NavigationMenu.List>
        </NavigationMenu.Root>
      </header>
      <main className={styles.main}>
        <p className={styles.eyebrow}>Your workspace</p>
        <h1 className={styles.title}>Keep the work that matters within reach.</h1>
        <p className={styles.summary}>The React client foundation is ready for Notes, Tasks, and collaborative editing.</p>
      </main>
    </div>
  );
}
