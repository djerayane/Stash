import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNotificationsPage } from "./project-notifications";

afterEach(() => vi.unstubAllGlobals());

describe("ProjectNotificationsPage", () => {
  it("loads persisted follow state and saves a distinct Activity preference", async () => {
    const requests: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (path.endsWith("/follow")) return new Response(JSON.stringify({ followed: true }), { status: 200 });
      return new Response(JSON.stringify({ settings: { activity: "followed", digest: "off" } }), { status: 200 });
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/app/projects/44444444-4444-4444-8444-444444444444/notifications"]}><Routes>
        <Route path="/app/projects/:projectId/notifications" element={<ProjectNotificationsPage token="member-token" />} />
      </Routes></MemoryRouter>
    </QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Choose what reaches you." })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Follow this Project/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /All Project Activity/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Digest cadence/ }), { target: { value: "weekly" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Quiet hours/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/notification-settings")
      && init?.method === "PUT" && String(init.body).includes('"activity":"all"') && String(init.body).includes('"digest":"weekly"')
      && String(init.body).includes('"quietHours"'))).toBe(true));
    expect(await screen.findByText("Preferences saved.")).toBeVisible();
  });

  it("focuses a load failure and recovers without reloading", async () => {
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => failed
      ? new Response(JSON.stringify({ message: "Temporarily unavailable" }), { status: 503 })
      : new Response(JSON.stringify(path.endsWith("/follow") ? { followed: false } : { settings: { activity: "followed", digest: "off" } }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/app/projects/44444444-4444-4444-8444-444444444444/notifications"]}><Routes>
        <Route path="/app/projects/:projectId/notifications" element={<ProjectNotificationsPage token="member-token" />} />
      </Routes></MemoryRouter></QueryClientProvider>);
    const alert = await screen.findByRole("alert"); expect(alert).toHaveFocus(); failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Choose what reaches you." })).toBeVisible();
  });
});
