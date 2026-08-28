import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";

import { MemberAdministrationPage } from "./member-administration";

test("uses one administration heading, shared actions, and no decorative authority kicker", () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
    <MemberAdministrationPage activeOrganizationId="organization" currentMemberId="owner" token="token" administrations={[{
      organizationId: "organization", organizationName: "Acme", members: [
        { id: "owner", name: "Owner", email: "owner@example.com", role: "Owner" },
        { id: "member", name: "Ada", email: "ada@example.com", role: "Member" },
      ],
    }]} />
  </MemoryRouter></QueryClientProvider>);

  expect(screen.getByRole("heading", { name: "Member access" })).toBeInTheDocument();
  expect(container.querySelectorAll("h1")).toHaveLength(1);
  expect(screen.queryByText("Acme", { selector: "p" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review departure" })).toHaveAttribute("data-variant", "secondary");
});
