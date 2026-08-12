import { queryOptions } from '@tanstack/react-query'
import { errorDetail } from '#/api/servers'

export type Project = {
  id: string
  server_id: string
  name: string
  created_at: number
  updated_at: number
}

export class ProjectNotFoundError extends Error {}
export class ProjectNameConflictError extends Error {}

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

export async function createProject(body: { server_id: string; name: string }): Promise<Project> {
  const res = await fetch('/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (res.status === 404) throw new ProjectNotFoundError(`No server with id ${body.server_id}`)

  if (res.status === 409) {
    throw new ProjectNameConflictError(`A project named "${body.name}" already exists on this server`)
  }

  if (!res.ok) throw new Error(`POST /projects failed: ${res.status}${await errorDetail(res)}`)

  const created = (await res.json()) as { project?: Project }

  if (!created.project) throw new Error('POST /projects: unexpected response shape')

  return created.project
}
