import { queryOptions } from '@tanstack/react-query'
import type { Server } from '#/api/servers'

// Shapes match apps/plane/src/schema.ts's `ObservedHostSchema` / `ProbesSchema` /
// `ServerDetailResponse`, kept hand-written for the same reason as api/servers.ts.

export type ObservedHost = {
  identity: { os: string; kernel: string; hostname: string; uptime_s: number }
  capacity: {
    cpus: number
    mem_total: number
    swap_total: number
    disks: { mount: string; size: number; used: number }[]
  }
  load: [number, number, number]
  listeners: { proto: string; addr: string; port: number; pid_name: string }[]
  security: {
    sshd: { permit_root_login: string; password_authentication: string; max_auth_tries: number }
    fail2ban_active: boolean
    unattended_upgrades_active: boolean
    last_apt_activity_unix: number
  }
}

export type ProbeKind = 'docker' | 'firewall' | 'systemd' | 'cron' | 'host'
export type ProbeStatus = 'ok' | 'unavailable'
export type Probes = Partial<Record<ProbeKind, ProbeStatus>>

// Matches daemon/internal/protocol/protocol.go's `ObservedResource`/`Observed`. `detail` stays
// `Record<string, unknown>` — it's genuinely kind-specific free-form data on the wire (Go's
// `map[string]any`), not a field the API under-specifies. Only `created_at` (docker's
// container-creation unix seconds, set by observer.go for every container-backed resource) is
// read off it below, defensively, since the schema gives it no guarantee across other kinds.
const HEALTH_VALUES: readonly string[] = ['healthy', 'degraded', 'unhealthy', 'stopped', 'unknown']

export type ObservedResource = {
  kind: string
  name: string
  observed: {
    exists: boolean
    health: 'healthy' | 'degraded' | 'unhealthy' | 'stopped' | 'unknown'
    detail: Record<string, unknown>
    observed_at: number
  }
}

export type ServerDetail = {
  server: Server
  observed: { rev: number; resources: ObservedResource[] } | null
  host: ObservedHost | null
  probes: Probes | null
}

// Distinguished from a network/plane failure so the error boundary can tell "this id doesn't
// exist" apart from "couldn't reach the plane" — the two need different copy and the second
// one's "check that the plane is running" hint would be actively misleading for the first.
export class ServerNotFoundError extends Error {}

export async function fetchServerDetail(id: string): Promise<ServerDetail> {
  const res = await fetch(`/servers/${id}`)

  if (res.status === 404) throw new ServerNotFoundError(`No server with id ${id}`)
  if (!res.ok) throw new Error(`GET /servers/${id} failed: ${res.status}`)

  const body = (await res.json()) as Partial<ServerDetail>

  // A malformed nested member would otherwise crash mid-render (`host.identity.hostname`,
  // `resource.observed.health`) and surface as "couldn't reach the plane" — the same
  // misdirection ServerNotFoundError exists to avoid. Check the members the screens
  // dereference.
  const malformedHost =
    body.host != null &&
    (!body.host.identity || !body.host.capacity || !Array.isArray(body.host.load))
  const malformedObserved =
    body.observed != null &&
    (!Array.isArray(body.observed.resources) ||
      body.observed.resources.some((r) => typeof r?.observed !== 'object' || r.observed === null))

  if (!body.server || malformedHost || malformedObserved) {
    throw new Error(`GET /servers/${id}: unexpected response shape`)
  }

  // The DO stores `health` as an unvalidated string, so the closed union in
  // `ObservedResource` is enforced here or nowhere — an unrecognised value degrades to
  // `unknown` (which renders as no dot) instead of silently missing every lookup.
  for (const r of body.observed?.resources ?? []) {
    if (!HEALTH_VALUES.includes(r.observed.health)) r.observed.health = 'unknown'
  }

  return body as ServerDetail
}

// A function, not a constant object, because the id is part of the cache key — each server
// gets its own cache entry, and the route file's loader and component must derive the exact
// same key from the same id to share one.
export const serverDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['servers', id],
    queryFn: () => fetchServerDetail(id),
  })
