import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "./app-shell";
import { useSessionState } from "./web-session";
import { InstanceBackupAdministration } from "./instance-backup-administration";
import { InstanceUpgradeAdministration } from "./instance-upgrade-administration";
import { InstanceDiagnosticsAdministration } from "./instance-diagnostics";
import { useInstanceSetupState } from "./identity-access/setup-state";
import "@stash/tokens/tokens.css";
import "./global.css";

const queryClient = new QueryClient();

function MemberApplication() {
  return <AppShell session={useSessionState()} setup={useInstanceSetupState()} />;
}

const router = createBrowserRouter([
  { path: "/instance-admin/backups", element: <InstanceBackupAdministration /> },
  { path: "/instance-admin/upgrade", element: <InstanceUpgradeAdministration /> },
  { path: "/instance-admin/diagnostics", element: <InstanceDiagnosticsAdministration /> },
  { path: "*", element: <MemberApplication /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
