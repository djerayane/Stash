import { describe, expect, it } from "vitest";
import {
  createWebCapabilityRegistry,
  navigationFromCapabilities,
  routesFromWebCapabilities,
  type WebCapability,
} from "./capability-registry";
import { knowledgeAuthoringWebCapability } from "./knowledge-authoring/web-capability";
import { workPlanningWebCapability } from "./work-planning/web-capability";

const capability = (name: string, primary: string[], contextual: string[], routes: string[]): WebCapability => ({
  name,
  primaryNavigation: primary.map((label) => ({ label, to: `/app/${label.toLowerCase()}`, icon: label.toLowerCase() })),
  contextualNavigation: contextual.map((label) => ({ label, to: `/app/${label.toLowerCase()}`, icon: label.toLowerCase() })),
  routes: () => routes.map((path) => ({ path, element: null })),
});

describe("web capability registry", () => {
  it("composes the production navigation and routes from observable capability contributions", () => {
    const registry = createWebCapabilityRegistry([knowledgeAuthoringWebCapability, workPlanningWebCapability]);
    const context = {
      workspaceId: "workspace-1", memberId: "member-1", token: "member-token",
      hasOrganizationAdministration: false, openProject() {}, openWorkspace() {},
    };

    expect(registry.capabilities.map(({ name }) => name)).toEqual(["knowledge-authoring", "work-planning"]);
    expect(navigationFromCapabilities(registry, "primary").map(({ label }) => label)).toEqual(["Inbox", "Note Tree", "Search", "Tasks"]);
    expect(navigationFromCapabilities(registry, "contextual").map(({ label }) => label)).toEqual(["Activity", "Projects"]);
    expect(routesFromWebCapabilities(registry, context).map(({ path }) => path)).toEqual([
      "/app/inbox", "/app/notes", "/app/notes/:noteId/history", "/app/notes/:targetId/discussions",
      "/app/notes/:targetId/blocks/:blockKey/discussions", "/app/activity", "/app/notifications", "/app/search",
      "/app/tasks", "/app/projects", "/app/projects/:projectId/boards", "/app/projects/:projectId/boards/:boardId",
      "/app/tasks/:targetId/discussions", "/app/projects/:projectId/tasks/:taskKey", "/app/projects/:projectId/notifications",
    ]);
  });

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
