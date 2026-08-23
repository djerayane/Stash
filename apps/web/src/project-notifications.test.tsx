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
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/notification-settings")
      && init?.method === "PUT" && init.body === JSON.stringify({ activity: "all", digest: "off" }))).toBe(true));
    expect(await screen.findByText("Preferences saved.")).toBeVisible();
  });
});
