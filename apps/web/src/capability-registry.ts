import type { ReactNode } from "react";

export interface NavigationContribution {
  readonly to: string;
  readonly label: string;
  readonly icon: string;
}

export interface WebRouteContribution {
  readonly path: string;
  readonly element: ReactNode;
}

export interface WebCapability {
  readonly name: string;
  readonly primaryNavigation: readonly NavigationContribution[];
  readonly contextualNavigation: readonly NavigationContribution[];
  routes(context: WebCapabilityContext): readonly WebRouteContribution[];
}

export interface WebCapabilityContext {
  readonly workspaceId: string;
  readonly memberId: string;
  readonly token: string;
  readonly activeOrganizationId?: string;
  readonly hasOrganizationAdministration: boolean;
  openProject(projectId: string): void;
  openWorkspace(workspaceId: string): void;
}

export interface WebCapabilityRegistry {
  readonly capabilities: readonly WebCapability[];
}

const validationContext: WebCapabilityContext = {
  workspaceId: "", memberId: "", token: "", hasOrganizationAdministration: false,
  openProject() {}, openWorkspace() {},
};

export function createWebCapabilityRegistry(capabilities: readonly WebCapability[]): WebCapabilityRegistry {
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const capability of capabilities) {
    if (names.has(capability.name)) throw new Error(`Duplicate web capability: ${capability.name}`);
    names.add(capability.name);
    for (const route of capability.routes(validationContext)) {
      if (paths.has(route.path)) throw new Error(`Duplicate web route: ${route.path}`);
      paths.add(route.path);
    }
  }
  return { capabilities: [...capabilities] };
}

export function navigationFromCapabilities(registry: WebCapabilityRegistry, placement: "primary" | "contextual"): readonly NavigationContribution[] {
  return registry.capabilities.flatMap((capability) => placement === "primary" ? capability.primaryNavigation : capability.contextualNavigation);
}

export function routesFromWebCapabilities(registry: WebCapabilityRegistry, context: WebCapabilityContext): readonly WebRouteContribution[] {
  return registry.capabilities.flatMap((capability) => capability.routes(context));
}
