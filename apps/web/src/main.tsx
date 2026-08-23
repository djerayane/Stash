import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "./app-shell";
import { useSessionState } from "./web-session";
import "@stash/tokens/tokens.css";
import "./global.css";

const queryClient = new QueryClient();

function Application() {
  return <AppShell session={useSessionState()} />;
}

const router = createBrowserRouter([{ path: "*", element: <Application /> }]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
