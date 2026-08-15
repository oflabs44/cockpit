import {
  DeploymentSchema,
  OperationSchema,
  ProjectSchema,
  ResourceSchema,
  SourceSchema,
} from "../schema";
import type { deployments, operations, projects, resources, sources } from "../db";

export function projectResponse(row: typeof projects.$inferSelect) {

  return ProjectSchema.parse({
    id: row.id,
    server_id: row.serverId,
    name: row.name,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export function resourceResponse(row: typeof resources.$inferSelect) {

  return ResourceSchema.parse({
    id: row.id,
    server_id: row.serverId,
    project_id: row.projectId,
    kind: row.kind,
    name: row.name,
    configuration: row.configuration,
    configuration_version: row.configurationVersion,
    current_release_id: row.currentReleaseId,
    health: row.health,
    exposed_at: row.exposedAt,
    drifted: row.drifted,
    observed: row.observed,
    observed_rev: row.observedRev,
    observed_at: row.observedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export function sourceResponse(row: typeof sources.$inferSelect, appSlug: string | null = null) {

  return SourceSchema.parse({
    id: row.id,
    github_app_slug: appSlug,
    provider: row.provider,
    name: row.name,
    github_login: row.login,
    github_installation_id: row.installationId,
    account_id: row.accountId,
    repository_selection: row.repositorySelection,
    permissions: row.permissions,
    events: row.events,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export function deploymentResponse(row: typeof deployments.$inferSelect) {

  return DeploymentSchema.parse({
    id: row.id,
    project_id: row.projectId,
    app_id: row.appId,
    server_id: row.serverId,
    trigger: row.trigger,
    triggered_by: row.triggeredBy,
    status: row.status,
    source_revision: row.sourceRevision,
    configuration_snapshot: row.configurationSnapshot,
    configuration_version: row.configurationVersion,
    steps: row.steps,
    changes: row.changes,
    workflow_id: row.workflowId,
    release_id: row.releaseId,
    created_at: row.createdAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  });
}

export function operationResponse(row: typeof operations.$inferSelect) {

  return OperationSchema.parse({
    id: row.id,
    server_id: row.serverId,
    project_id: row.projectId,
    resource_id: row.resourceId,
    kind: row.kind,
    actor: row.actor,
    status: row.status,
    configuration_snapshot: row.configurationSnapshot,
    changes: row.changes,
    workflow_id: row.workflowId,
    release_id: row.releaseId,
    created_at: row.createdAt,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  });
}
