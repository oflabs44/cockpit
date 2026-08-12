import { queryOptions } from '@tanstack/react-query'
import { errorDetail } from '#/api/servers'

export type Health = 'healthy' | 'degraded' | 'unhealthy' | 'stopped' | 'unknown'

export type ResourceKind =
  | 'app'
  | 'database'
  | 'proxy'
  | 'volume'
  | 'network'
  | 'cron'
  | 'daemon'
  | 'firewall_rule'
  | 'domain'
  | 'dns_record'
  | 'source'
  | 'secret'
  | 'secret_provider'
  | 'backup_destination'

export type Resource = {
  id: string
  server_id: string | null
  project_id: string | null
  kind: ResourceKind
  name: string
  configuration: Record<string, unknown>
  configuration_version: number
  current_release_id: string | null
  health: Health
  exposed_at: string | null
  drifted: boolean
  observed: {
    exists: boolean
    health: Health
    detail: Record<string, unknown>
    observed_at: number
  } | null
  observed_rev: number
  observed_at: number | null
  created_at: number
  updated_at: number
}

export type RepoSource = { type: 'repo'; url: string; ref: string; path?: string }
export type ImageSource = { type: 'image'; image: string; digest?: string }
export type AppSource = RepoSource | ImageSource

export type AppConfiguration = {
  source: AppSource
  build?: {
    dockerfile?: string
    args?: Record<string, string>
    limits: { cpu: string; memory: string }
    prune: { keep_layers: number }
  }
  domains: string[]
  ports: { container: number; protocol: 'tcp' | 'udp' }[]
  env: Record<string, string>
  replicas: number
  healthcheck?: { path: string; interval_s: number; timeout_s: number; retries: number }
  limits: { cpu: string; memory: string }
  restart: 'always' | 'unless-stopped' | 'on-failure'
}

export class ResourceNotFoundError extends Error {}
export class ResourceConflictError extends Error {}

export function appSource(resource: Resource): AppSource | null {
  if (resource.kind !== 'app') return null

  const source = resource.configuration.source

  if (!source || typeof source !== 'object') return null

  if (
    'type' in source &&
    source.type === 'repo' &&
    'url' in source &&
    typeof source.url === 'string' &&
    'ref' in source &&
    typeof source.ref === 'string'
  ) {
    return {
      type: 'repo',
      url: source.url,
      ref: source.ref,
      ...('path' in source && typeof source.path === 'string' ? { path: source.path } : {}),
    }
  }

  if (
    'type' in source &&
    source.type === 'image' &&
    'image' in source &&
    typeof source.image === 'string'
  ) {
    return {
      type: 'image',
      image: source.image,
      ...('digest' in source && typeof source.digest === 'string' ? { digest: source.digest } : {}),
    }
  }

  return null
}

export async function fetchServerResources(serverId: string): Promise<Resource[]> {
  const res = await fetch(`/servers/${encodeURIComponent(serverId)}/resources`)

  if (res.status === 404) throw new ResourceNotFoundError(`No server with id ${serverId}`)
  if (!res.ok) throw new Error(`GET /servers/${serverId}/resources failed: ${res.status}`)

  const body = (await res.json()) as { resources?: Resource[] }

  if (!Array.isArray(body.resources)) {
    throw new Error(`GET /servers/${serverId}/resources: unexpected response shape`)
  }

  return body.resources
}

export const serverResourcesQueryOptions = (serverId: string) =>
  queryOptions({
    queryKey: ['servers', serverId, 'resources'],
    queryFn: () => fetchServerResources(serverId),
  })

export async function fetchResource(id: string): Promise<Resource> {
  const res = await fetch(`/resources/${encodeURIComponent(id)}`)

  if (res.status === 404) throw new ResourceNotFoundError(`No resource with id ${id}`)
  if (!res.ok) throw new Error(`GET /resources/${id} failed: ${res.status}`)

  const body = (await res.json()) as { resource?: Resource }

  if (!body.resource) throw new Error(`GET /resources/${id}: unexpected response shape`)

  return body.resource
}

export const resourceQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['resources', id],
    queryFn: () => fetchResource(id),
  })

export async function updateResourceConfiguration(body: {
  id: string
  configuration: Record<string, unknown>
}): Promise<Resource> {
  const res = await fetch(`/resources/${encodeURIComponent(body.id)}/configuration`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configuration: body.configuration }),
  })

  if (res.status === 404) throw new ResourceNotFoundError(`No resource with id ${body.id}`)

  if (!res.ok) {
    throw new Error(
      `PATCH /resources/${body.id}/configuration failed: ${res.status}${await errorDetail(res)}`,
    )
  }

  const updated = (await res.json()) as { resource?: Resource }

  if (!updated.resource) {
    throw new Error(`PATCH /resources/${body.id}/configuration: unexpected response shape`)
  }

  return updated.resource
}

export async function createProjectResource(body: {
  projectId: string
  name: string
  kind: ResourceKind
  configuration: Record<string, unknown>
}): Promise<Resource> {
  const res = await fetch(`/projects/${encodeURIComponent(body.projectId)}/resources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: body.name, kind: body.kind, configuration: body.configuration }),
  })

  if (res.status === 404) throw new ResourceNotFoundError(`No project with id ${body.projectId}`)

  if (res.status === 409) {
    throw new ResourceConflictError(`A resource named "${body.name}" already exists on this server`)
  }

  if (!res.ok) {
    throw new Error(
      `POST /projects/${body.projectId}/resources failed: ${res.status}${await errorDetail(res)}`,
    )
  }

  const created = (await res.json()) as { resource?: Resource }

  if (!created.resource) {
    throw new Error(`POST /projects/${body.projectId}/resources: unexpected response shape`)
  }

  return created.resource
}
