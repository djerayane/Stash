import type { CapabilityModule } from "../capability-registry.js";
import { diagnosticsAdminRoute, diagnosticsSchemaRoute } from "../diagnostics-routes.js";
import type { Diagnostics } from "../diagnostics.js";
import { requireInstanceAdministrator } from "../http-routing.js";
import { agentGrantRoutes } from "../agent-grant-routes.js";
import type { AgentGrantService } from "../agent-grants.js";
import { instanceBackupRoute } from "../instance-backup-routes.js";
import type { InstanceBackupRestoreTarget, InstanceBackupService } from "../instance-backup.js";
import { instanceUpgradeRoute } from "../instance-upgrade-routes.js";
import type { InstanceUpgradeService } from "../instance-upgrade.js";
import { mcpRoute } from "../mcp-route.js";
import type { NoteService } from "../notes.js";
import type { TaskService } from "../tasks.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { portableWorkspaceImportRoute } from "../portable-workspace-import-route.js";
import type { PortableWorkspaceImportService } from "../portable-workspace-import.js";

export function instanceOperationsCapability(options: {
  instanceAdminToken: string;
  diagnostics: Diagnostics;
  memberAccess?: MemberAccessResolver;
  agentGrants?: AgentGrantService;
  notes?: NoteService;
  tasks?: TaskService;
  mcpEnabled?: boolean;
  instanceBackups?: InstanceBackupService;
  instanceBackupRoot?: string;
  instanceBackupRestoreTarget?: InstanceBackupRestoreTarget;
  instanceUpgrades?: InstanceUpgradeService;
  portableWorkspaceImports?: PortableWorkspaceImportService;
}): CapabilityModule {
  const memberRoutes = () => options.agentGrants && options.memberAccess
    ? [agentGrantRoutes(options.agentGrants, options.memberAccess,
      { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })]
    : [];
  return {
    name: "instance-operations",
    owns: ["diagnostics", ...(options.agentGrants ? ["agent-grants"] : []), ...(options.mcpEnabled ? ["mcp"] : []),
      ...(options.instanceBackups ? ["instance-backups"] : []), ...(options.instanceUpgrades ? ["instance-upgrades"] : []),
      ...(options.portableWorkspaceImports ? ["portable-import"] : [])],
    routes: () => [
      diagnosticsSchemaRoute(options.diagnostics),
      requireInstanceAdministrator(options.instanceAdminToken, diagnosticsAdminRoute(options.diagnostics)),
      ...memberRoutes(),
      ...(options.mcpEnabled && options.agentGrants ? [mcpRoute(options.agentGrants, true,
        { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })] : []),
      ...(options.instanceBackups && options.instanceBackupRoot && options.instanceBackupRestoreTarget
        ? [requireInstanceAdministrator(options.instanceAdminToken, instanceBackupRoute(options.instanceBackups,
          options.instanceBackupRoot, options.instanceBackupRestoreTarget))] : []),
      ...(options.instanceUpgrades ? [requireInstanceAdministrator(options.instanceAdminToken, instanceUpgradeRoute(options.instanceUpgrades))] : []),
      ...(options.portableWorkspaceImports ? [requireInstanceAdministrator(options.instanceAdminToken,
        portableWorkspaceImportRoute(options.portableWorkspaceImports))] : []),
    ],
    publicRoutes: memberRoutes,
  };
}
