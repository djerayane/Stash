import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import gsap from "gsap";
import { AgentGrantsPage } from "./agent-grants";

afterEach(() => vi.unstubAllGlobals());
describe("AgentGrantsPage motion", () => {
  it("does not animate settings or Proposal states under reduced motion", async () => {
    vi.spyOn(gsap, "from"); vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("agent-grant-options")
      ? { organizations: [{ organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Team", projects: [] }] }
      : path.endsWith("proposals") ? { proposals: [] } : { grants: [] }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AgentGrantsPage token="member" /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Pending Proposals" })).toBeVisible(); expect(gsap.from).not.toHaveBeenCalled();
  });
  it("runs state motion through the scoped GSAP lifecycle", async () => {
    vi.spyOn(gsap, "from").mockReturnValue({} as any);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))); vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("agent-grant-options")
      ? { organizations: [{ organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Team", projects: [] }] }
      : path.endsWith("proposals") ? { proposals: [] } : { grants: [] }), { status: 200 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><AgentGrantsPage token="member" /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Pending Proposals" })).toBeVisible(); expect(gsap.from).toHaveBeenCalledWith("header > *, section", expect.objectContaining({ clearProps: "all" }));
  });
});
