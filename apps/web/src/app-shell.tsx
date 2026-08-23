import * as NavigationMenu from "@radix-ui/react-navigation-menu";
import styles from "./app-shell.module.css";

export function AppShell() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="Stash home">Stash</a>
        <NavigationMenu.Root aria-label="Workspace">
          <NavigationMenu.List className={styles.navigation}>
            <NavigationMenu.Item><NavigationMenu.Link className={styles.link} href="/notes">Notes</NavigationMenu.Link></NavigationMenu.Item>
            <NavigationMenu.Item><NavigationMenu.Link className={styles.link} href="/tasks">Tasks</NavigationMenu.Link></NavigationMenu.Item>
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
