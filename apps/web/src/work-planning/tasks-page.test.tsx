import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { TasksPage } from "./tasks-page";

const workflow = { statuses: [
  { id: "11111111-1111-4111-8111-111111111111", name: "To do", category: "unstarted", position: 1 },
  { id: "22222222-2222-4222-8222-222222222222", name: "In progress", category: "started", position: 2 },
] };
function show(fetcher: typeof fetch) { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TasksPage fetcher={fetcher} memberId="member" token="token" workspaceId="workspace" /></QueryClientProvider>); }

test("creates Projectless Tasks and changes canonical status with keyboard-operable views", async () => {
  const task = { id: "task", title: "Trace the source", status: workflow.statuses[0], assigneeIds: ["member"], projectKeys: [], projectAssociations: [] };
  const moved = { ...task, status: workflow.statuses[1] };
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ tasks: [task], workflow }))
    .mockResolvedValueOnce(Response.json({ status: "updated", task: moved }))
    .mockResolvedValueOnce(Response.json({ tasks: [moved], workflow }))
    .mockResolvedValueOnce(Response.json({ status: "created", task: { ...task, id: "new", title: "Projectless work" } }, { status: 201 }))
    .mockResolvedValueOnce(Response.json({ tasks: [moved, { ...task, id: "new", title: "Projectless work" }], workflow }));
  show(fetcher);
  expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  expect(await screen.findByText("No Project")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(screen.getByRole("combobox", { name: "Status for Trace the source" }), { target: { value: workflow.statuses[1]!.id } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/canonical-tasks/task", expect.objectContaining({ method: "PATCH" })));
  fireEvent.change(screen.getByRole("textbox", { name: "New Task" }), { target: { value: "Projectless work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/workspaces/workspace/canonical-tasks", expect.objectContaining({
    method: "POST", body: JSON.stringify({ title: "Projectless work" }),
  })));
});

test("uses the shared page, primary-action, and filter language", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ tasks: [], workflow }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(<QueryClientProvider client={client}><TasksPage fetcher={fetcher} memberId="member" token="token" workspaceId="workspace" /></QueryClientProvider>);

  await screen.findByRole("heading", { name: "Tasks" });
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(screen.queryByText("Workspace work")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create Task" })).toHaveAttribute("data-variant", "primary");
  expect(screen.getByRole("group", { name: "Filters" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
});

test("explains that failed Task loading preserves the current view and draft", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "Tasks are temporarily unavailable." }), { status: 503 }));
  show(fetcher);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Your Task view and draft are preserved");
  expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
