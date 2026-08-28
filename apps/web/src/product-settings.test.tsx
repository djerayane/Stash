import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import gsap from "gsap";
import { MemberSettingsPage, OrganizationSettingsPage, WorkspaceDataPage } from "./product-settings";

function view(node: ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>); }
const organizationAdministration = { organizationId: "org-1", organizationName: "Acme", members: [{ id: "member-1", name: "Ada", email: "ada@example.com", role: "Owner" as const }] };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("remaining product settings", () => {
  it("keeps the Organization heading when administration is unavailable", () => {
    view(<OrganizationSettingsPage token="admin-token" administrations={[]} />);
    expect(screen.getByRole("heading", { name: "Organization settings" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("No administrative state was changed");
  });

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
    expect(screen.getByRole("heading", { name: "Personal settings" })).toBeInTheDocument();
    expect(screen.queryByText("Personal settings", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save regional settings" })).toHaveAttribute("data-variant", "secondary");
    expect(within(locale.closest("label")!).getByText("Locale", { selector: "span" })).toBeVisible();
    for (const button of screen.getAllByRole("button")) expect(button, button.textContent || "unnamed button").toHaveAttribute("data-variant");
  });

  it("keeps import input intact after a recoverable server failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Archive rejected. Nothing was imported." }), { status: 422 })));
    view(<WorkspaceDataPage token="member-token" workspaceId="workspace-1" memberId="account-1" />);
    const file = new File(["archive"], "workspace.zip", { type: "application/zip" }); const archive = screen.getByLabelText("ZIP archive"); fireEvent.change(archive, { target: { files: [file] } }); await waitFor(() => expect((archive as HTMLInputElement).files?.[0]).toBe(file));
    fireEvent.submit(screen.getByRole("button", { name: "Validate and import" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was imported");
    expect(screen.getByRole("alert")).toHaveTextContent("Your selected archive and import settings are preserved");
  });

  it("preserves password fields and provides an explicit retry direction", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/api/member/localization"
      ? Response.json({ locale: "en", timeZone: "UTC", dateFormat: "medium", weekStartsOn: "monday" })
      : new Response(JSON.stringify({ message: "Password service unavailable." }), { status: 503 })));
    view(<MemberSettingsPage token="member-token" />);
    const current = await screen.findByLabelText("Current password");
    const next = screen.getByLabelText("New password");
    fireEvent.change(current, { target: { value: "current-password" } });
    fireEvent.change(next, { target: { value: "replacement-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your password fields are preserved. Review the message and try again.");
    expect(current).toHaveValue("current-password");
    expect(next).toHaveValue("replacement-password");
  });

  it("makes failed Organization reads recoverable without changing administrative state", async () => {
    let roleReads = 0; let connectionReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/agent-grant-options") return Response.json({ organizations: [] });
      if (path.endsWith("/roles")) return ++roleReads === 1
        ? new Response(JSON.stringify({ message: "Roles unavailable." }), { status: 503 }) : Response.json({ roles: [] });
      if (path.endsWith("/repository-connections")) return ++connectionReads === 1
        ? new Response(JSON.stringify({ message: "Connections unavailable." }), { status: 503 }) : Response.json({ repositoryConnections: [] });
      return Response.json({});
    }));
    view(<OrganizationSettingsPage token="admin-token" administrations={[organizationAdministration]} />);
    expect(await screen.findByRole("alert", { name: "Roles unavailable" })).toHaveTextContent("Existing Roles and assignments are unchanged");
    expect(screen.getByRole("alert", { name: "Repository Connections unavailable" })).toHaveTextContent("Existing Repository Connections are unchanged");
    fireEvent.click(screen.getByRole("button", { name: "Try loading Roles again" }));
    fireEvent.click(screen.getByRole("button", { name: "Try loading Repository Connections again" }));
    await waitFor(() => { expect(roleReads).toBe(2); expect(connectionReads).toBe(2); });
  });

  it("submits an Obsidian vault through the dedicated client boundary and presents its report",async()=>{
    vi.stubGlobal("matchMedia",vi.fn(()=>({matches:true,addEventListener(){},removeEventListener(){}})));
    const openWorkspace=vi.fn();let request:{path:string;init?:RequestInit}|undefined;vi.stubGlobal("fetch",vi.fn(async(path:string,init?:RequestInit)=>{request={path,init};return Response.json({status:"imported",report:{workspaceId:"workspace-imported",transformed:[{object:"Note:Home.md",reason:"wikilink_resolved"}],skipped:[],ambiguous:[{object:"Link:Home.md->Idea",reason:"multiple_note_targets"}]}})}));
    view(<WorkspaceDataPage token="member-token" workspaceId="workspace-1" memberId="account-1" onOpenWorkspace={openWorkspace}/>);fireEvent.click(screen.getByLabelText("Markdown or Obsidian vault"));
    fireEvent.change(screen.getByLabelText("ZIP archive"),{target:{files:[new File(["vault"],"vault.zip",{type:"application/zip"})]}});fireEvent.submit(screen.getByRole("button",{name:"Validate and import"}).closest("form")!);
    expect(await screen.findByRole("heading",{name:"Import committed"})).toBeVisible();expect(request?.path).toBe("/api/workspace-imports/markdown");expect(request?.init?.headers).toMatchObject({authorization:"Bearer member-token"});expect(screen.getByText(/multiple note targets/)).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Open imported Workspace"}));expect(openWorkspace).toHaveBeenCalledWith("workspace-imported");
  });

  it("exposes Organization-only roles, invitations, connections, and OIDC controls", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let customMemberIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => { requests.push({ path, init });
      if (path === "/api/agent-grant-options") return Response.json({ organizations: [{ organizationId: "org-1", organizationName: "Acme", projects: [{ id: "project-1", name: "Launch" }] }] });
      if (path.endsWith("/roles") && !init?.method) return Response.json({ roles: [
        { name: "Owner", immutable: true, permissions: ["create_project"] },
        { name: "Admin", immutable: true, permissions: ["create_project"] },
        { name: "Member", immutable: true, permissions: [] },
        { id: "role-1", name: "Project lead", immutable: false, permissions: ["create_project"], memberIds: customMemberIds },
      ] });
      if (path.endsWith("/roles/role-1/members/member-1")) {
        customMemberIds = init?.method === "DELETE" ? [] : ["member-1"];
        return Response.json({ updated: true });
      }
      if (path.includes("/roles")) return Response.json({ updated: true });
      return Response.json({ repositoryConnections: [{ id: "connection-1", repositoryUrl: "https://github.com/acme/stash", projectIds: [], ownership: "organization", state: "active" }] }); }));
    view(<OrganizationSettingsPage token="admin-token" activeOrganizationId="org-1" administrations={[{ organizationId: "org-1", organizationName: "Acme", members: [{ id: "member-1", name: "Ada", email: "ada@example.com", role: "Owner" }] }]} />);
    expect(screen.getByRole("heading", { name: "Organization settings" })).toBeVisible();
    expect(screen.queryByText("Organization administration", { selector: "p" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Roles and Members" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Custom Roles" })).toBeVisible();
    fireEvent.change(screen.getAllByRole("textbox", { name: "Role name" })[0]!, { target: { value: "Delivery lead" } });
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Can create Projects" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Create custom Role" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/roles") && init?.method === "POST"
      && String(init.body).includes('"create_project"'))).toBe(true));
    const customRole = screen.getAllByRole("textbox", { name: "Role name" })[1]!.closest("article")!;
    expect(within(customRole).getAllByText("Role name", { selector: "span" })).not.toHaveLength(0);
    expect(within(customRole).getByText("Add Organization Member", { selector: "span" })).toBeVisible();
    fireEvent.change(within(customRole).getByRole("textbox", { name: "Role name" }), { target: { value: "Project captain" } });
    fireEvent.click(within(customRole).getByRole("button", { name: "Save Role" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/roles/role-1") && init?.method === "PUT"
      && String(init.body).includes("Project captain"))).toBe(true));
    fireEvent.change(within(customRole).getByRole("combobox", { name: "Add Organization Member" }), { target: { value: "member-1" } });
    fireEvent.click(within(customRole).getByRole("button", { name: "Grant Role" }));
    await waitFor(() => expect(within(customRole).getByRole("button", { name: "Revoke" })).toBeVisible());
    fireEvent.click(within(customRole).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/roles/role-1/members/member-1") && init?.method === "DELETE")).toBe(true));
    expect(screen.getByRole("heading", { name: "Invite access" })).toBeVisible(); expect(screen.getByRole("heading", { name: "GitHub Repository Connections" })).toBeVisible(); expect(screen.getByRole("heading", { name: "OpenID Connect" })).toBeVisible();
    fireEvent.change(await screen.findByRole("combobox", { name: "Project for https://github.com/acme/stash" }), { target: { value: "project-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/repository-connections/connection-1/projects/project-1") && init?.method === "POST")).toBe(true));
    for (const button of screen.getAllByRole("button")) expect(button, button.textContent || "unnamed button").toHaveAttribute("data-variant");
  });
});
