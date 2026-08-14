import { queryOptions } from '@tanstack/react-query'
import { errorDetail } from '#/api/servers'

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
