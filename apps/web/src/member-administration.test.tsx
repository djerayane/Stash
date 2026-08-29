import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { MemberAdministrationPage } from "./member-administration";

const organization = {
  organizationId: "organization", organizationName: "Acme", members: [
    { id: "owner", name: "Owner", email: "owner@example.com", role: "Owner" as const },
    { id: "member", name: "Ada", email: "ada@example.com", role: "Member" as const },
  ],
};
function show(props: Partial<ComponentProps<typeof MemberAdministrationPage>> = {}) {
  return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><MemberAdministrationPage
    activeOrganizationId="organization" currentMemberId="owner" token="token" administrations={[organization]} {...props} />
  </MemoryRouter></QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

test("uses one administration heading, shared actions, and no decorative authority kicker", () => {
  const { container } = show();

  expect(screen.getByRole("heading", { name: "Member access" })).toBeInTheDocument();
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(screen.queryByText("Acme", { selector: "p" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review departure" })).toHaveAttribute("data-variant", "secondary");
});

test("keeps the Member access heading and shared Organization field when administration is unavailable or selectable", () => {
  const unavailable = show({ administrations: [] });
  expect(screen.getByRole("heading", { name: "Member access" })).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("No access was changed");
  unavailable.unmount();

  show({ administrations: [organization, { ...organization, organizationId: "other", organizationName: "Other" }] });
  const picker = screen.getByRole("combobox", { name: "Organization" });
  expect(picker.closest("label")?.querySelector("span")).toHaveTextContent("Organization");
});

test("returns focus to the departure trigger when removal is cancelled", async () => {
  show();
  const trigger = screen.getByRole("button", { name: "Review departure" });
  trigger.focus();
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByRole("region", { name: /Remove Ada/ })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Keep Member" }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("moves focus to the completion after a Member is removed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  show();
  fireEvent.click(screen.getByRole("button", { name: "Review departure" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Member" }));
  const completion = (await screen.findByRole("heading", { name: "Ada no longer has access" })).closest("section")!;
  await waitFor(() => expect(completion).toHaveFocus());
});
