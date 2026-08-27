import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SetupPage } from "./setup-page";

const storedSessions = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storedSessions.get(key) ?? null,
  setItem: (key: string, value: string) => storedSessions.set(key, value),
  removeItem: (key: string) => storedSessions.delete(key),
  clear: () => storedSessions.clear(),
});

describe("first-run setup", () => {
  it("asks only for identity and Workspace fields on a loopback Instance", async () => {
    render(<SetupPage state="available-local" />);
    expect(screen.getByRole("heading", { name: "Keep the thread." })).toBeVisible();
    expect(screen.getByText("Stash")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Step 1 of 2" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByLabelText("Name")).toBeVisible();
    expect(screen.getByLabelText("Email")).toBeVisible();
    expect(screen.queryByLabelText("Setup code")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByLabelText("Workspace name")).toBeVisible();
    expect(screen.getByLabelText("Password")).toHaveAttribute("minlength", "12");
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
  });

  it("shows the operator code field only when setup is code-protected", async () => {
    render(<SetupPage state="code-required" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grace Hopper" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "grace@example.test" } });
    fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
    expect(await screen.findByLabelText("Setup code")).toHaveAttribute("autocomplete", "one-time-code");
    expect(screen.getByText(/startup output/i)).toBeVisible();
  });

  it("submits setup, stores the authenticated session, and opens the starter Note", async () => {
    const completed = vi.fn();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "member-token", workspaceId: "workspace-1", starterNoteId: "note-1",
    }), { status: 201, headers: { "content-type": "application/json" } }));
    render(<SetupPage fetcher={fetcher} onComplete={completed} state="code-required" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "Ada's Workspace" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Setup code"), { target: { value: "FIRST-CODE" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my Workspace" }));
    await waitFor(() => expect(completed).toHaveBeenCalledWith({
      token: "member-token", workspaceId: "workspace-1", starterNoteId: "note-1",
    }));
    expect(fetcher).toHaveBeenCalledWith("/api/instance/setup", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Ada Lovelace", email: "ada@example.test",
        password: "correct horse battery staple", workspaceName: "Ada's Workspace", setupCode: "FIRST-CODE" }),
    }));
    expect(JSON.parse(localStorage.getItem("stash.member-session")!)).toEqual({ token: "member-token" });
  });

  it("announces a recoverable setup error and keeps entered values", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "That setup code has expired." }), {
      status: 410, headers: { "content-type": "application/json" },
    }));
    render(<SetupPage fetcher={fetcher} state="code-required" />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "Personal" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("Setup code"), { target: { value: "OLD-CODE" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my Workspace" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code has expired.");
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Personal");
    expect(screen.getByRole("button", { name: "Create my Workspace" })).toHaveFocus();
  });
});
