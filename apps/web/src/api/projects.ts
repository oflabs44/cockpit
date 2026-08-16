import { queryOptions } from '@tanstack/react-query'
import { planeError } from '#/api/servers'

// The project's target settings. No client builds one yet — an import sends
// DEFAULT_PROJECT_SETTINGS and there is no editor for the rest.
export type ProjectSettings = {
  ingress: { service: string; port: number; domains: string[] } | null
  migration: { service: string; command?: string[] } | null
  health: { required_services: string[] }
  variables: Record<string, string>
}

export type Project = {
  id: string
  server_id: string
  name: string
  // ADR-0012 source binding. Null on a project created before the import route existed;
  // the plane guarantees the six fields are all set or all null, never a mix.
  source_id: string | null
  repository_id: string | null
  repository_full_name: string | null
  ref: string | null
  base_directory: string | null
  compose_path: string | null
  auto_deploy: boolean
  settings: ProjectSettings
  created_at: number
  updated_at: number
}

export class ProjectNotFoundError extends Error {}
// The plane refused the import and said why: a gone server or source, a name already taken
// on the server, or a repository stack already imported there.
export class ProjectImportError extends Error {}

export async function fetchProjects(serverId: string): Promise<Project[]> {
  const res = await fetch(`/projects?server=${encodeURIComponent(serverId)}`)

  if (!res.ok) throw new Error(`GET /projects failed: ${res.status}`)

  const body = (await res.json()) as { projects?: Project[] }

  if (!Array.isArray(body.projects)) throw new Error('GET /projects: unexpected response shape')

  return body.projects
}

export const projectsQueryOptions = (serverId: string) =>
  queryOptions({
    queryKey: ['projects', 'server', serverId],
    queryFn: () => fetchProjects(serverId),
  })

export async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`/projects/${encodeURIComponent(id)}`)

  if (res.status === 404) throw new ProjectNotFoundError(`No project with id ${id}`)
  if (!res.ok) throw new Error(`GET /projects/${id} failed: ${res.status}`)

  const body = (await res.json()) as { project?: Project }

  if (!body.project) throw new Error(`GET /projects/${id}: unexpected response shape`)

  return body.project
}

export const projectQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['projects', id],
    queryFn: () => fetchProject(id),
  })

// The settings a Compose project starts with: nothing routed, nothing migrated, no service
// required healthy, no variables. Deliberately not editable at import time.
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  ingress: null,
  migration: null,
  health: { required_services: [] },
  variables: {},
}

export type ImportProjectInput = {
  server_id: string
  name: string
  source_id: string
  // GitHub's numeric repository id as text — the authoritative identity, which survives a
  // rename. `repository_full_name` is the display cache alongside it.
  repository_id: string
  repository_full_name: string
  ref: string
  base_directory: string
  compose_path: string
  auto_deploy: boolean
  settings: ProjectSettings
}

// ADR-0012: importing a repository is how a deployable project is created. POST /projects
// still exists on the plane but produces an unbound project no client can deploy, so no
// client calls it.
export async function importProject(body: ImportProjectInput): Promise<Project> {
  const res = await fetch('/projects/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await planeError(res)

    // The Plane's 400 is a serialized Zod issue list, not operator-facing text.
    if (res.status === 400) {
      throw new ProjectImportError('check the ref, base directory, and Compose path')
    }

    if (res.status === 404 || res.status === 409) {
      throw new ProjectImportError(detail || `the plane refused the import (${res.status})`)
    }

    throw new Error(`POST /projects/import failed: ${res.status}${detail ? ` — ${detail}` : ''}`)
  }

  const created = (await res.json()) as { project?: Project }

  if (!created.project) throw new Error('POST /projects/import: unexpected response shape')

  return created.project
}
