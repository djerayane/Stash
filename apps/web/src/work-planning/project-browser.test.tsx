import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

import { ProjectBrowser } from "./project-browser";

function renderBrowser(fetcher: typeof fetch, onOpenProject = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter>
    <ProjectBrowser fetcher={fetcher} onOpenProject={onOpenProject} token="member-token" />
  </MemoryRouter></QueryClientProvider>);
  return onOpenProject;
}

test("makes Project creation discoverable and opens the created Project", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{
    id: "personal", name: "My Workspace", projectCreation: { allowed: true },
    projects: [{ id: "existing", name: "Existing", key: "OLD" }],
  }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({
    id: "new-project", workspaceId: "personal", name: "Launch", key: "LAUNCH",
  }), { status: 201 }));
  const openProject = renderBrowser(fetcher);

  expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Create a Project in My Workspace" }));
  const dialog = screen.getByRole("dialog", { name: "Create a Project" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), { target: { value: "Launch" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Project key" }), { target: { value: "launch" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create Project" }));

  await waitFor(() => expect(openProject).toHaveBeenCalledWith("new-project"));
  expect(fetcher).toHaveBeenLastCalledWith("/api/workspaces/personal/projects", expect.objectContaining({
    method: "POST", body: JSON.stringify({ name: "Launch", key: "LAUNCH" }),
  }));
});

test("explains permission denial without offering an active create control", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ workspaces: [{
    id: "organization", name: "Acme", projectCreation: { allowed: false,
      reason: "Your Organization Role does not include Project creation." }, projects: [],
  }] }), { status: 200 }));
  renderBrowser(fetcher, vi.fn());

  expect(await screen.findByRole("button", { name: "Create a Project in Acme" })).toBeDisabled();
  expect(screen.getByText("Your Organization Role does not include Project creation.")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("preserves the draft and returns focus to a failed create action", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [{
    id: "personal", name: "Personal", projectCreation: { allowed: true }, projects: [],
  }] }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ message: "That key is already in use." }), { status: 409 }));
  renderBrowser(fetcher);
  fireEvent.click(await screen.findByRole("button", { name: "Create a Project in Personal" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Launch" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Project key" }), { target: { value: "LAUNCH" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("That key is already in use.");
  expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Launch");
  expect(screen.getByRole("button", { name: "Create Project" })).toHaveFocus();
});

test("traps dialog focus, closes with Escape, and restores the exact create trigger", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ workspaces: [{
    id: "personal", name: "Personal", projectCreation: { allowed: true }, projects: [],
  }] }), { status: 200 }));
  renderBrowser(fetcher);
  const trigger = await screen.findByRole("button", { name: "Create a Project in Personal" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Create a Project" });
  const submit = within(dialog).getByRole("button", { name: "Create Project" });
  submit.focus();
  fireEvent.keyDown(submit, { key: "Tab" });
  expect(within(dialog).getByRole("textbox", { name: "Project name" })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
