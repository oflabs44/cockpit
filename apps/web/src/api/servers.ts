import { queryOptions } from '@tanstack/react-query'

// Shape matches apps/plane/src/schema.ts's `ServerSchema`, kept as a hand-written subset
// rather than a cross-package import — the web app has no dependency on the plane package.

export type ServerStatus = 'enrolling' | 'connected' | 'disconnected' | 'draining'

// The closed set from apps/plane/src/schema.ts's `CreateServerBody`/`ServerSchema`.
export const PROVIDERS = ['hetzner', 'digitalocean', 'linode', 'other'] as const
export type Provider = (typeof PROVIDERS)[number]

export type Server = {
  id: string
  name: string
  provider: Provider
  addr: string | null
  arch: string | null
  status: ServerStatus
  agent_version: string | null
  last_seen_at: number | null
  labels: Record<string, string>
  created_at: number
}

export async function fetchServers(): Promise<Server[]> {
  const res = await fetch('/servers')

  if (!res.ok) throw new Error(`GET /servers failed: ${res.status}`)

  const body = (await res.json()) as { servers?: Server[] }

  // A shape mismatch (proxy error page, field rename) must land in the query's error
  // state, not crash the render on `data.length`.
  if (!Array.isArray(body.servers)) throw new Error('GET /servers: unexpected response shape')

  return body.servers
}

// Shared between the route loader (`ensureQueryData`) and the component (`useSuspenseQuery`)
// so both sides key and fetch identically — the loader warms the exact cache entry the
// component reads.
export const serversQueryOptions = queryOptions({
  queryKey: ['servers'],
  queryFn: fetchServers,
})

// Distinguished so the add-server form can say "that name is taken" rather than a generic
// failure — apps/plane/src/routes/servers-create.ts's only documented failure mode.
export class ServerNameConflictError extends Error {}

export type CreateServerBody = { name: string; provider: Provider }
export type CreateServerResponse = { server: Server; token: string; install_command: string }

export async function createServer(body: CreateServerBody): Promise<CreateServerResponse> {
  const res = await fetch('/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, labels: {} }),
  })

  if (res.status === 409) throw new ServerNameConflictError(`A server named "${body.name}" already exists`)

  // The plane's 400s carry a validation message (e.g. the name pattern) — "failed: 400"
  // alone isn't actionable.
  if (!res.ok) throw new Error(`POST /servers failed: ${res.status}${await errorDetail(res)}`)

  const created = (await res.json()) as Partial<CreateServerResponse>

  // Same standard as fetchServers above: a 2xx with the wrong shape must fail loudly here,
  // not crash the panel at `created.install_command`.
  if (!created.server || typeof created.install_command !== 'string' || typeof created.token !== 'string') {
    throw new Error('POST /servers: unexpected response shape')
  }

  return created as CreateServerResponse
}

export async function errorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')

  return text ? ` — ${text.slice(0, 200)}` : ''
}

// The plane answers a refusal with `{ "error": "<sentence the operator can act on>" }`.
// Pulled out on its own so a caller can show that sentence instead of wrapping raw JSON in
// a status line. Empty when the body is not that shape — the caller falls back.
export async function planeError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')

  try {
    const body = JSON.parse(text) as { error?: unknown }

    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // Not JSON: an HTML error page or an empty body. Nothing to quote.
  }

  return ''
}
