import type { HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export interface CapabilityModule {
  readonly name: string;
  readonly owns?: readonly string[];
  routes(): readonly HttpRoute[];
  publicRoutes?(): readonly HttpRoute[];
  readonly memberAccess?: MemberAccessResolver;
}

export interface CapabilityRegistry {
  readonly modules: readonly CapabilityModule[];
}

export function createCapabilityRegistry(modules: readonly CapabilityModule[]): CapabilityRegistry {
  const names = new Set<string>();
  for (const module of modules) {
    if (names.has(module.name)) throw new Error(`Duplicate capability module name: ${module.name}`);
    names.add(module.name);
  }
  return { modules: [...modules] };
}

export function routesFromCapabilities(registry: CapabilityRegistry): readonly HttpRoute[] {
  return registry.modules.flatMap((module) => [...module.routes()]);
}

export function publicRoutesFromCapabilities(registry: CapabilityRegistry): readonly HttpRoute[] {
  return registry.modules.flatMap((module) => [...(module.publicRoutes?.() ?? [])]);
}

export function memberAccessFromCapabilities(registry: CapabilityRegistry) {
  const providers = registry.modules.flatMap((module) => module.memberAccess ? [module.memberAccess] : []);
  if (providers.length > 1) throw new Error("Multiple capabilities provide Member access");
  return providers[0];
}
