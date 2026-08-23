import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import gsap from "gsap";
import { MemberSettingsPage, OrganizationSettingsPage, WorkspaceDataPage } from "./product-settings";

function view(node: ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("remaining product settings", () => {
  it("loads and saves localization while respecting reduced motion", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []; vi.spyOn(gsap, "from");
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { requests.push({ path, init }); return Response.json({ locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" }); }));
    view(<MemberSettingsPage token="member-token" />);
    const locale = await screen.findByRole("textbox", { name: "Locale" });
    fireEvent.change(locale, { target: { value: "fr-FR" } });
    fireEvent.click(screen.getByRole("button", { name: "Save regional settings" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path === "/api/member/localization" && init?.method === "PUT" && String(init.body).includes('"locale":"fr-FR"'))).toBe(true));
    expect(gsap.from).not.toHaveBeenCalled();
  });

  it("keeps import input intact after a recoverable server failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Archive rejected. Nothing was imported." }), { status: 422 })));
    view(<WorkspaceDataPage token="member-token" workspaceId="workspace-1" memberId="account-1" />);
    const file = new File(["archive"], "workspace.zip", { type: "application/zip" }); const archive = screen.getByLabelText("Archive"); fireEvent.change(archive, { target: { files: [file] } }); await waitFor(() => expect((archive as HTMLInputElement).files?.[0]).toBe(file));
    fireEvent.submit(screen.getByRole("button", { name: "Validate and import" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was imported");
  });

  it("exposes Organization-only roles, invitations, connections, and OIDC controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => Response.json(path.endsWith("/roles") ? { roles: [{ name: "Owner" }, { name: "Admin" }, { name: "Member" }] } : { repositoryConnections: [] })));
    view(<OrganizationSettingsPage token="admin-token" activeOrganizationId="org-1" administrations={[{ organizationId: "org-1", organizationName: "Acme", members: [{ id: "member-1", name: "Ada", email: "ada@example.com", role: "Owner" }] }]} />);
    expect(await screen.findByRole("heading", { name: "Roles and Members" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Invite access" })).toBeVisible(); expect(screen.getByRole("heading", { name: "GitHub Repository Connections" })).toBeVisible(); expect(screen.getByRole("heading", { name: "OpenID Connect" })).toBeVisible();
  });
});
