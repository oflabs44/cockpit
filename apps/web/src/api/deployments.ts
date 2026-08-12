import { queryOptions } from '@tanstack/react-query'
import { errorDetail } from '#/api/servers'

export type Actor = { kind: 'human' | 'agent' | 'system'; id: string }
export type SourceRevision = { ref: string; commit: string; message: string | null }
export type Impact = 'none' | 'reload' | 'restart' | 'replace' | 'destructive'

export type DeploymentTrigger =
  | { kind: 'git_push'; source_id: string; revision: SourceRevision; delivery_id: string }
  | { kind: 'manual'; commit: string | null }
  | { kind: 'redeploy'; deployment_id: string }
  | { kind: 'rollback'; release_id: string }

export type DeploymentStatus =
  | 'queued'
  | 'fetching'
  | 'building'
  | 'planning'
  | 'deploying'
  | 'checking'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type DeploymentStep = {
  name: 'source' | 'build' | 'changes' | 'apply' | 'healthcheck'
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  started_at: number | null
  finished_at: number | null
  error: { kind: string; message: string } | null
}

export type Change = {
  action: 'create' | 'update' | 'replace' | 'delete'
  target: string
  before: unknown | null
  after: unknown | null
  impact: Impact
  result: 'pending' | 'applied' | 'failed' | 'skipped'
  error?: { kind: string; message: string }
}

export type ChangeSet = {
  basis: Record<string, number>
  changes: Change[]
  max_impact: Impact
  calculated_at: number
}

export type Deployment = {
  id: string
  project_id: string
  app_id: string
  server_id: string
  trigger: DeploymentTrigger
  triggered_by: Actor
  status: DeploymentStatus
  source_revision: SourceRevision | null
  configuration_snapshot: Record<string, unknown>
  configuration_version: number
  steps: DeploymentStep[]
  changes: ChangeSet | null
  workflow_id: string
  release_id: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export class DeploymentNotFoundError extends Error {}

export async function fetchProjectDeployments(projectId: string): Promise<Deployment[]> {
  const res = await fetch(`/projects/${encodeURIComponent(projectId)}/deployments`)

  if (res.status === 404) throw new DeploymentNotFoundError(`No project with id ${projectId}`)
  if (!res.ok) throw new Error(`GET /projects/${projectId}/deployments failed: ${res.status}`)

  const body = (await res.json()) as { deployments?: Deployment[] }

  if (!Array.isArray(body.deployments)) {
    throw new Error(`GET /projects/${projectId}/deployments: unexpected response shape`)
  }

  return body.deployments
}

export const projectDeploymentsQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ['projects', projectId, 'deployments'],
    queryFn: () => fetchProjectDeployments(projectId),
  })

export async function fetchDeployment(id: string): Promise<Deployment> {
  const res = await fetch(`/deployments/${encodeURIComponent(id)}`)

  if (res.status === 404) throw new DeploymentNotFoundError(`No deployment with id ${id}`)
  if (!res.ok) throw new Error(`GET /deployments/${id} failed: ${res.status}`)

  const body = (await res.json()) as { deployment?: Deployment }

  if (!body.deployment) throw new Error(`GET /deployments/${id}: unexpected response shape`)

  return body.deployment
}

export const deploymentQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['deployments', id],
    queryFn: () => fetchDeployment(id),
  })

export async function createManualDeployment(body: {
  resourceId: string
  commit: string | null
}): Promise<Deployment> {
  const res = await fetch(`/resources/${encodeURIComponent(body.resourceId)}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: { kind: 'manual', commit: body.commit } }),
  })

  if (res.status === 404) throw new DeploymentNotFoundError(`No resource with id ${body.resourceId}`)

  if (!res.ok) {
    throw new Error(
      `POST /resources/${body.resourceId}/deployments failed: ${res.status}${await errorDetail(res)}`,
    )
  }

  const created = (await res.json()) as { deployment?: Deployment }

  if (!created.deployment) {
    throw new Error(`POST /resources/${body.resourceId}/deployments: unexpected response shape`)
  }

  return created.deployment
}
