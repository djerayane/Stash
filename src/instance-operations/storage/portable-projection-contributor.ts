import type { PortableDurableObject } from "../../portable-workspace-export.js";
import type { PostgresQueryable } from "./postgres-kernel.js";

/** Capability-owned durable projections, without teaching the database kernel capability tables or schemas. */
export interface PostgresPortableProjectionContributor {
  preparePortableObjects(client: PostgresQueryable): Promise<void>;
  importPortableObjects(client: PostgresQueryable, objects: readonly PortableDurableObject[], workspaceId: string): Promise<void>;
  readPortableObjects(client: PostgresQueryable, input: {
    workspaceId: string; memberId: string; member: boolean; visibleNoteIds: ReadonlySet<string>;
  }): Promise<PortableDurableObject[]>;
}
