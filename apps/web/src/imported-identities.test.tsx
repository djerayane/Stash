import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportedIdentitiesPage } from "./imported-identities";

const administrations = [{ organizationId: "org", organizationName: "Organization", members: [
  { id: "member", name: "Ada Lovelace", email: "ada@stash.test", role: "Admin" as const },
] }];
afterEach(() => vi.unstubAllGlobals());

describe("ImportedIdentitiesPage", () => {
  it("requires an explicit local Member and removes a successfully mapped stub", async () => {
    let pending = true; const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      requests.push(init ?? {});
      if (init?.method === "POST") { pending = false; return new Response(JSON.stringify({ status: "mapped" }), { status: 201 }); }
      return new Response(JSON.stringify({ identities: pending ? [{ importId: "import", workspaceId: "workspace", workspaceName: "Imported Workspace", sourceAccountId: "source", displayName: "Grace Hopper" }] : [] }), { status: 200 });
    }));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ImportedIdentitiesPage token="token" administrations={administrations} />
    </QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Grace Hopper" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm mapping" })).toBeDisabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Local Member" }), { target: { value: "member" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm mapping" }));
    const status = await screen.findByRole("status"); expect(status).toHaveFocus();
    expect(status).toHaveTextContent("Grace Hopper now resolves to Ada Lovelace");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Grace Hopper" })).not.toBeInTheDocument());
    expect(String(requests.find(({ method }) => method === "POST")?.body)).toContain('"localAccountId":"member"');
  });

  it("keeps a recoverable conflict visible and focused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => init?.method === "POST"
      ? new Response("{}", { status: 409 })
      : new Response(JSON.stringify({ identities: [{ importId: "import", workspaceId: "workspace", workspaceName: "Workspace", sourceAccountId: "source", displayName: "Grace Hopper" }] }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ImportedIdentitiesPage token="token" administrations={administrations} />
    </QueryClientProvider>);
    await screen.findByRole("heading", { name: "Grace Hopper" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "member" } }); fireEvent.click(screen.getByRole("button"));
    const alert = await screen.findByRole("alert"); expect(alert).toHaveFocus(); expect(alert).toHaveTextContent("already mapped differently");
  });
});
