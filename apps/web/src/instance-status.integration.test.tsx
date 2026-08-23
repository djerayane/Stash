import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { AppShell } from "./app-shell";

function renderShell(fetcher: typeof fetch) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AppShell fetcher={fetcher} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test("recovers from an unavailable Instance and moves focus to the error", async () => {
  let healthAttempts = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).endsWith("/api/client-session")) return new Response("{}", { status: 401 });
    healthAttempts += 1;
    return new Response(JSON.stringify({ status: healthAttempts === 1 ? "unavailable" : "ready" }), {
      status: healthAttempts === 1 ? 503 : 200,
    });
  });

  renderShell(fetcher);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Instance ready"));
  expect(healthAttempts).toBe(2);
});

test("does not render administrator navigation without the required permission", async () => {
  const denied = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
    String(input).endsWith("/api/client-session") ? { authenticated: true, permissions: [] } : { status: "ready" },
  ), { status: 200 }));
  const { unmount } = renderShell(denied);
  await screen.findByText("Instance ready");
  expect(screen.queryByRole("link", { name: "Administration" })).not.toBeInTheDocument();

  unmount();
  const allowed = vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(JSON.stringify(
    String(input).endsWith("/api/client-session")
      ? { authenticated: true, permissions: ["instance:manage"] }
      : { status: "ready" },
  ), { status: 200 }));
  renderShell(allowed);
  await screen.findByText("Instance ready");
  expect(await screen.findByRole("link", { name: "Administration" })).toHaveAttribute("href", "/settings/instance");
});
