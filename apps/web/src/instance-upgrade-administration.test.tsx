import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InstanceUpgradeAdministration } from "./instance-upgrade-administration";

beforeEach(() => { const storage = new Map<string, string>(); storage.set("stash.instance-admin-session", JSON.stringify({ token: "operator-token" }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null }); });

test("requires a passing preflight and exact target version before upgrading", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ status: "ready", currentVersion: "0.1.0", targetVersion: "0.2.0", checks: [
      { id: "database", status: "pass", message: "PostgreSQL is reachable." }, { id: "backup", status: "pass", message: "Rollback storage is writable." },
    ] }))
    .mockResolvedValueOnce(Response.json({ status: "upgraded", fromVersion: "0.1.0", targetVersion: "0.2.0", restartRequired: true }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <InstanceUpgradeAdministration fetcher={fetcher} />
  </QueryClientProvider>);
  expect(screen.getByRole("heading", { name: "Upgrade with a way back." })).toBeInTheDocument();
  expect(await screen.findByText("PostgreSQL is reachable.")).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Upgrade to 0.2.0" }); expect(button).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: /Type 0.2.0/ }), { target: { value: "0.2.0" } });
  expect(button).toBeEnabled(); fireEvent.click(button);
  expect(await screen.findByRole("status")).toHaveTextContent("Restart the Instance");
  expect(fetcher).toHaveBeenLastCalledWith("/api/instance/upgrade", expect.objectContaining({ body: JSON.stringify({ confirmation: "0.2.0" }) }));
});

test("shows failed preflight details and keeps upgrade unavailable", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "blocked", currentVersion: "0.1.0", targetVersion: "0.2.0",
    checks: [{ id: "disk", status: "fail", message: "Insufficient free space for a rollback-safe upgrade." }] }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><InstanceUpgradeAdministration fetcher={fetcher} /></QueryClientProvider>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Insufficient free space");
  expect(screen.getByRole("button", { name: "Upgrade unavailable" })).toBeDisabled();
});
