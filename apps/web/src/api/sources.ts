import { queryOptions } from '@tanstack/react-query'
import { errorDetail, planeError } from '#/api/servers'

// Shape matches the plane's Sources API, kept as a hand-written subset rather than a
// cross-package import — same convention as #/api/servers.

// GitHub's own vocabulary for an App installation: the operator granted either every
// repository on the account or a picked subset.
export type RepositorySelection = 'all' | 'selected'

export type Source = {
  id: string
  provider: 'github'
  name: string
  github_login: string
  github_installation_id: number
  // The slug of the GitHub App this installation belongs to, so the card can link to the
  // App's own settings without the web app knowing the plane's App by name. Null when the
  // plane has no GITHUB_APP_SLUG configured.
  github_app_slug: string | null
  // GitHub permission name -> access level, e.g. { contents: 'read', metadata: 'read' }.
  permissions: Record<string, string>
  // Webhook events the installation subscribes to, e.g. ['push'].
  events: string[]
  repository_selection: RepositorySelection
  created_at: number
  updated_at: number
}

export async function fetchSources(): Promise<Source[]> {
  const res = await fetch('/source-connections')

  if (!res.ok) throw new Error(`GET /source-connections failed: ${res.status}`)

  const body = (await res.json()) as { sources?: Source[] }

  if (!Array.isArray(body.sources)) {
    throw new Error('GET /source-connections: unexpected response shape')
  }

  return body.sources
}

export const sourcesQueryOptions = queryOptions({
  queryKey: ['sources'],
  queryFn: fetchSources,
})

// ADR-0012 — what an operator picks from when importing a project. Read live from GitHub on
// every request and never mirrored here, so a repository added or removed on github.com
// shows up on the next fetch.
export type Repository = {
  id: string
  full_name: string
  // Empty on a repository with no commits yet: there is nothing to clone or deploy.
  default_branch: string
  private: boolean
  archived: boolean
}

// The plane's own maximum, so the walk below takes the fewest requests it can.
const REPOSITORY_PAGE_SIZE = 100

// The grant is paged, and a large one does not fit in a page — so every page is fetched in
// order until the plane says there are no more. Stopping at the first page would present a
// truncated grant as the whole grant.
export async function fetchSourceRepositories(sourceId: string): Promise<Repository[]> {
  const all: Repository[] = []

  for (let page = 1; ; page++) {
    const res = await fetch(
      `/source-connections/${encodeURIComponent(sourceId)}/repositories?page=${page}&per_page=${REPOSITORY_PAGE_SIZE}`,
    )

    if (res.status === 404) {
      throw new Error('this GitHub connection no longer exists; reconnect it under Sources')
    }

    if (!res.ok) {
      const detail = await planeError(res)

      // 502 is GitHub's answer, not the plane's — worth saying so, since retrying is the
      // right move and there is nothing to fix on this side.
      if (res.status === 502) {
        throw new Error(detail || "GitHub wouldn't list the repositories for this installation")
      }

      throw new Error(
        `GET /source-connections/${sourceId}/repositories failed: ${res.status}${detail ? ` — ${detail}` : ''}`,
      )
    }

    const body = (await res.json()) as { repositories?: Repository[]; has_more?: boolean }

    if (!Array.isArray(body.repositories)) {
      throw new Error(`GET /source-connections/${sourceId}/repositories: unexpected response shape`)
    }

    all.push(...body.repositories)

    // The empty-page guard is the backstop: `has_more` comes from a total count GitHub
    // reports, and a wrong one must not turn this walk into an endless loop.
    if (!body.has_more || body.repositories.length === 0) return all
  }
}

export const sourceRepositoriesQueryOptions = (sourceId: string) =>
  queryOptions({
    queryKey: ['sources', sourceId, 'repositories'],
    queryFn: () => fetchSourceRepositories(sourceId),
  })

// The plane answers with GitHub's App install page for the configured App — the caller's
// move is to leave for `url` and come back through the plane's callback. An unconfigured
// plane answers 500 instead (GithubAppNotConfiguredError below), never a URL.
export type ConnectGithubResponse = { url: string }

export class GithubAppNotConfiguredError extends Error {}

export async function connectGithub(): Promise<ConnectGithubResponse> {
  // The route takes no input, but the plane's CSRF guard rejects POSTs whose content-type
  // isn't application/json (403) — so declare it, with an empty object as the honest body.
  const res = await fetch('/source-connections/github/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })

  if (!res.ok) {
    const detail = await errorDetail(res)
    if (res.status === 500 && detail.includes('github app not configured')) {
      throw new GithubAppNotConfiguredError(
        'GitHub App is not configured on this plane. Add GITHUB_APP_ID, GITHUB_APP_SLUG, and GITHUB_APP_PRIVATE_KEY, then restart the plane.',
      )
    }
    throw new Error(`POST /source-connections/github/connect failed: ${res.status}${detail}`)
  }

  const body = (await res.json()) as Partial<ConnectGithubResponse>

  if (typeof body.url !== 'string') {
    throw new Error('POST /source-connections/github/connect: unexpected response shape')
  }

  return body as ConnectGithubResponse
}

// Revoking the installation on GitHub is the first thing the plane does, so a success here
// means cockpit and GitHub agree. `confirm` is the connection's github_login: the plane
// refuses a disconnect that does not carry it (ADR-0009, confirmation at request time).
export type DisconnectSourceResponse = { id: string; revoked_on_github: boolean }

export async function disconnectSource(input: {
  id: string
  confirm: string
}): Promise<DisconnectSourceResponse> {
  const res = await fetch(`/source-connections/${input.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: input.confirm }),
  })

  // Already gone (another tab, a stale list) is the end state the caller asked for.
  if (res.status === 404) return { id: input.id, revoked_on_github: false }

  if (!res.ok) {
    const detail = await errorDetail(res)

    // The plane leaves the connection alone when GitHub refuses, so the operator can retry.
    if (res.status === 502) {
      throw new Error(`GitHub wouldn't revoke the installation, so nothing changed${detail}`)
    }

    throw new Error(`DELETE /source-connections/${input.id} failed: ${res.status}${detail}`)
  }

  return (await res.json()) as DisconnectSourceResponse
}
