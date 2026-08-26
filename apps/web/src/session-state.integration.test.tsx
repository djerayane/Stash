import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";
import { AppShell } from "./app-shell";
import { useSessionState } from "./web-session";

const storedSession = JSON.stringify({
  token: "integration-member-token",
  member: { name: "Forged Member", email: "forged@example.com" },
  workspace: { name: "Forged Workspace" },
});

function IntegratedShell({ fetcher }: { readonly fetcher: typeof fetch }) {
  return <AppShell session={useSessionState(fetcher)} />;
}

function renderShell(fetcher: typeof fetch, path = "/app") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><IntegratedShell fetcher={fetcher} /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

test("recovers from an unavailable authenticated session check", async () => {
  localStorage.setItem("stash.member-session", storedSession);
  let attempts = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    attempts += 1;
    return new Response(JSON.stringify({ authenticated: true, member: { id: "member", name: "Ada Lovelace", email: "ada@example.com" },
      workspace: { id: "workspace", name: "Engine Room" }, capabilities: [] }),
    { status: attempts === 1 ? 503 : 200, headers: { "content-type": "application/json" } });
  });
  renderShell(fetcher);
  expect(await screen.findByRole("main")).toBeInTheDocument();
  const alert = await screen.findByRole("alert");
  expect(alert).toBe(screen.getByRole("main").firstElementChild);
  expect(alert).toHaveFocus();
  expect(screen.getByRole("heading", { name: "Workspace unavailable" })).toBeInTheDocument();
  act(() => screen.getByRole("button", { name: "Try again" }).click());
  expect((await screen.findAllByRole("heading", { name: "Note Tree" })).length).toBeGreaterThan(0);
  expect(screen.queryByText("Engine Room")).not.toBeInTheDocument();
  expect(screen.queryByText("Forged Workspace")).not.toBeInTheDocument();
  expect(attempts).toBe(2);
});

test("rejects an Instance Administrator token from the Member shell", async () => {
  localStorage.setItem("stash.member-session", JSON.stringify({ token: "instance-admin-token" }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
  renderShell(fetcher);
  expect(await screen.findByRole("heading", { name: "Sign in to Stash" })).toBeInTheDocument();
});

test("does not render authenticated navigation when the Instance rejects the stored session", async () => {
  localStorage.setItem("stash.member-session", storedSession);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 401 }));
  renderShell(fetcher, "/app/tasks");
  expect(await screen.findByRole("heading", { name: "Sign in to Stash" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Workspace" })).not.toBeInTheDocument();
});
