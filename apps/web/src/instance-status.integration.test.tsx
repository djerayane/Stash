import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { AppShell } from "./app-shell";

function renderShell(fetcher: typeof fetch, canManageSettings = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AppShell fetcher={fetcher} canManageSettings={canManageSettings} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

test("recovers from an unavailable Instance and moves focus to the error", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "unavailable" }), { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready" }), { status: 200 }));

  renderShell(fetcher);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Instance ready"));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("does not render administrator navigation without the required permission", async () => {
  const ready = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: "ready" }), { status: 200 }));
  const { rerender } = renderShell(ready, false);
  await screen.findByText("Instance ready");
  expect(screen.queryByRole("link", { name: "Administration" })).not.toBeInTheDocument();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rerender(
    <QueryClientProvider client={client}>
      <MemoryRouter><AppShell fetcher={ready} canManageSettings /></MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByText("Instance ready");
  expect(screen.getByRole("link", { name: "Administration" })).toHaveAttribute("href", "/settings/instance");
});
