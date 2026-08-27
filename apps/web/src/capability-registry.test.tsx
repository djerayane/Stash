import { describe, expect, it } from "vitest";
import {
  createWebCapabilityRegistry,
  navigationFromCapabilities,
  routesFromWebCapabilities,
  type WebCapability,
} from "./capability-registry";

const capability = (name: string, primary: string[], contextual: string[], routes: string[]): WebCapability => ({
  name,
  primaryNavigation: primary.map((label) => ({ label, to: `/app/${label.toLowerCase()}`, icon: label.toLowerCase() })),
  contextualNavigation: contextual.map((label) => ({ label, to: `/app/${label.toLowerCase()}`, icon: label.toLowerCase() })),
  routes: () => routes.map((path) => ({ path, element: null })),
});

describe("web capability registry", () => {
  it("preserves declared capability order for routes and separates primary from contextual navigation", () => {
    const registry = createWebCapabilityRegistry([
      capability("knowledge-authoring", ["Inbox", "Notes", "Search"], ["Activity"], ["/app/inbox", "/app/notes"]),
      capability("work-planning", ["Tasks"], ["Projects"], ["/app/tasks", "/app/projects"]),
    ]);

    expect(navigationFromCapabilities(registry, "primary").map(({ label }) => label)).toEqual(["Inbox", "Notes", "Search", "Tasks"]);
    expect(navigationFromCapabilities(registry, "contextual").map(({ label }) => label)).toEqual(["Activity", "Projects"]);
    expect(routesFromWebCapabilities(registry, {} as never).map(({ path }) => path)).toEqual([
      "/app/inbox", "/app/notes", "/app/tasks", "/app/projects",
    ]);
  });

  it("rejects duplicate capability names and route paths", () => {
    expect(() => createWebCapabilityRegistry([capability("notes", [], [], []), capability("notes", [], [], [])])).toThrow(/Duplicate web capability/);
    expect(() => createWebCapabilityRegistry([
      capability("notes", [], [], ["/app/notes"]), capability("search", [], [], ["/app/notes"]),
    ])).toThrow(/Duplicate web route/);
  });
});
