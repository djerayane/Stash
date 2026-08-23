import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InstanceBackupAdministration } from "./instance-backup-administration";

function renderPage(fetcher: typeof fetch) {
  localStorage.setItem("stash.instance-admin-session", JSON.stringify({ token: "operator-token" }));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <InstanceBackupAdministration fetcher={fetcher} />
  </QueryClientProvider>);
}

beforeEach(() => { const storage = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key), clear: () => storage.clear() }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("dry-runs a selected Instance Backup before offering restore", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ backups: [{ name: "release-ready", schema: "stash.instance-backup.v1", createdAt: "2026-08-23T10:00:00.000Z", verifiedAt: "2026-08-23T10:05:00.000Z" }] }))
    .mockResolvedValueOnce(Response.json({ status: "verified", backup: "release-ready" }));
  renderPage(fetcher);
  expect(await screen.findByRole("heading", { name: "Restore with evidence, not hope." })).toBeInTheDocument();
  const verify = await screen.findByRole("button", { name: "Verify release-ready" }); act(() => verify.click());
  expect(await screen.findByRole("status")).toHaveTextContent("release-ready passed every preflight check");
  expect(screen.getByRole("status")).toHaveFocus();
  expect(fetcher).toHaveBeenLastCalledWith("/api/instance/backups/release-ready/restore", expect.objectContaining({
    body: JSON.stringify({ dryRun: true }), headers: expect.objectContaining({ authorization: "Bearer operator-token" }),
  }));
  expect(screen.getByRole("button", { name: "Restore release-ready" })).toBeEnabled();
});

test("requires the exact backup name and makes a failed restore recoverable", async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ backups: [{ name: "release-ready", schema: "stash.instance-backup.v1", createdAt: "2026-08-23T10:00:00.000Z", verifiedAt: "2026-08-23T10:05:00.000Z" }] }))
    .mockResolvedValueOnce(Response.json({ status: "verified", backup: "release-ready" }))
    .mockResolvedValueOnce(Response.json({ error: "restore_failed", message: "The restore did not complete. The pre-restore state was preserved." }, { status: 503 }));
  renderPage(fetcher); const verify = await screen.findByRole("button", { name: "Verify release-ready" }); act(() => verify.click());
  await screen.findByText(/passed every preflight check/); act(() => screen.getByRole("button", { name: "Restore release-ready" }).click());
  const confirm = screen.getByRole("button", { name: "Restore Instance" }); expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: /Type release-ready/ }), { target: { value: "release-ready" } });
  expect(confirm).toBeEnabled(); act(() => confirm.click());
  expect(await screen.findByRole("alert")).toHaveTextContent("pre-restore state was preserved");
  expect(screen.getByRole("alert")).toHaveFocus();
});
