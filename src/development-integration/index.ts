import type { CapabilityModule } from "../capability-registry.js";
import { githubArtifactRoutes } from "../github-artifact-routes.js";
import type { GitHubArtifactService } from "../github-artifacts.js";
import { githubSignalRoutes, githubWebhookRoute } from "../github-signal-routes.js";
import type { GitHubSignalService } from "../github-signals.js";
import { repositoryConnectionRoutes } from "../repository-connection-routes.js";
import type { RepositoryConnectionService } from "../repository-connections.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

export function developmentIntegrationCapability(options: {
  memberAccess: MemberAccessResolver;
  repositoryConnections?: RepositoryConnectionService;
  githubArtifacts?: GitHubArtifactService;
  githubSignals?: GitHubSignalService;
}): CapabilityModule {
  const publicRoutes = () => [
    ...(options.repositoryConnections ? [repositoryConnectionRoutes(options.repositoryConnections, options.memberAccess)] : []),
    ...(options.githubArtifacts ? [githubArtifactRoutes(options.githubArtifacts, options.memberAccess)] : []),
    ...(options.githubSignals ? [githubSignalRoutes(options.githubSignals, options.memberAccess)] : []),
  ];
  return {
    name: "development-integration",
    owns: [...(options.repositoryConnections ? ["repository-connections"] : []),
      ...(options.githubArtifacts ? ["github-artifacts"] : []), ...(options.githubSignals ? ["github-signals"] : [])],
    routes: () => [
      ...(options.githubSignals ? [githubWebhookRoute(options.githubSignals)] : []),
      ...publicRoutes(),
    ],
    publicRoutes,
  };
}
