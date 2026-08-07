import { queryOptions } from '@tanstack/react-query'

// Shape matches apps/plane/src/schema.ts's `ServerSchema`, kept as a hand-written subset
// rather than a cross-package import — the web app has no dependency on the plane package.

export type ServerStatus = 'enrolling' | 'connected' | 'disconnected' | 'draining'

export type Server = {
  id: string
  name: string
  provider: 'hetzner' | 'digitalocean' | 'linode' | 'other'
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
