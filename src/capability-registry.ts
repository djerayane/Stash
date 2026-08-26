import type { HttpRoute } from "./http-routing.js";

export interface CapabilityModule {
  readonly name: string;
  routes(): readonly HttpRoute[];
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
