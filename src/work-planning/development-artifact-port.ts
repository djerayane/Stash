import type { ActivityCause } from "../activity.js";
import type { DevelopmentArtifactKind } from "../github-artifacts.js";
import type { PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

export type DevelopmentArtifactTarget =
  | { kind: "task_key"; memberId: string; projectId: string; taskKey: string }
  | { kind: "task_id"; taskId: string; actor: { kind: "member"; memberId: string }
    | { kind: "organization_owner"; organizationId: string } };

export interface WorkPlanningDevelopmentArtifactPort {
  linkDevelopmentArtifact(
    client: PostgresQueryable,
    target: DevelopmentArtifactTarget,
    artifact: { kind: DevelopmentArtifactKind; url: string },
    action: string,
    cause: ActivityCause,
  ): Promise<"linked" | "forbidden">;
}
