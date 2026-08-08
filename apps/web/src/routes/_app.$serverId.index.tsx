import type { ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import {
  Package01Icon,
  DatabaseIcon,
  GlobeIcon,
  HardDriveIcon,
  Clock01Icon,
  FirewallIcon,
  Settings01Icon,
} from '@hugeicons/core-free-icons'
import { serverDetailQueryOptions, type ObservedResource } from '#/api/server-detail'
import type { ServerStatus } from '#/api/servers'
import { DOT_CLASS } from '#/components/server-card'
import { formatAgo, formatBytes, formatDuration } from '#/lib/format'

export const Route = createFileRoute('/_app/$serverId/')({
  // No loader here: the parent `_app.$serverId` route's loader already warmed
  // `serverDetailQueryOptions(serverId)`, and `useSuspenseQuery` below reads that same cache
  // entry — one fetch per server, shared across every tab.
  component: ServerOverview,
})

const STATUS_LABEL: Record<ServerStatus, string> = {
  connected: 'connected',
  enrolling: 'enrolling',
  draining: 'draining',
  disconnected: 'no contact',
}

// docs/design.md §3: icons mean a resource kind, never decoration. `IsServerKind` in
// protocol.go names eight server-scoped kinds; `network` has no icon here because the
// docker observer never emits it today. Anything unmapped falls back to no icon, since
// guessing a glyph for an unnamed kind is its own kind of invention.
const KIND_ICON: Record<string, IconSvgElement> = {
  app: Package01Icon,
  database: DatabaseIcon,
  proxy: GlobeIcon,
  volume: HardDriveIcon,
  cron: Clock01Icon,
  firewall_rule: FirewallIcon,
  daemon: Settings01Icon,
}

const RESOURCE_DOT: Record<ObservedResource['observed']['health'], string | null> = {
  healthy: 'dot-healthy',
  degraded: 'dot-degraded',
  unhealthy: 'dot-failed',
  stopped: 'dot-stopped',
  unknown: null,
}

function ServerOverview() {
  const { serverId } = Route.useParams()
  // `useSuspenseQuery` throws to the error boundary only when no data exists; a failed
  // background refetch keeps rendering cached data and surfaces here as `error` instead.
  const { data } = useSuspenseQuery(serverDetailQueryOptions(serverId))
  const { server, observed, host, probes } = data
  // Same rule as ServerCardFoot: an enrolling server shows its creation time, everything
  // else shows last contact.
  const enrolling = server.status === 'enrolling'
  let contact = 'never'

  if (enrolling) contact = formatAgo(server.created_at)
  else if (server.last_seen_at) contact = formatAgo(server.last_seen_at)

  return (
    <>
      <div className="summary">
        <div className="card">
          <div className="card-section">
            <div className="kv kv-inline">
              <KvItem label="status">
                {DOT_CLASS[server.status] && <span className={`dot ${DOT_CLASS[server.status]}`} />}
                {STATUS_LABEL[server.status]}
              </KvItem>
              <KvItem label="provider">{server.provider}</KvItem>
              <KvItem label="address">{server.addr ?? '—'}</KvItem>
              {server.arch && <KvItem label="arch">{server.arch}</KvItem>}
              <KvItem label="agent">{server.agent_version ?? '—'}</KvItem>
              <KvItem label={enrolling ? 'created' : 'last seen'}>{contact}</KvItem>
              {host && (
                <>
                  <KvItem label="hostname">{host.identity.hostname || '—'}</KvItem>
                  <KvItem label="os">{host.identity.os || '—'}</KvItem>
                  {/* mem_total and uptime_s come from parsing /proc/meminfo and /proc/uptime
                      (daemon/internal/executor/oscli/host.go) — files that don't exist on
                      macOS, so the daemon on xin-macbook reads nothing and both parse to Go's
                      int64 zero. cpus (runtime.NumCPU) and kernel (`uname -r`) are genuinely
                      cross-platform and stay real. A literal 0 here is indistinguishable from
                      "this platform can't report it", so it's treated as not-reported rather
                      than shown as a fact ("0.0 GB" of memory, "0m" of uptime). */}
                  <KvItem label="hardware">
                    {host.capacity.cpus} vCPU
                    {host.capacity.mem_total > 0 && ` / ${formatBytes(host.capacity.mem_total)}`}
                    {host.capacity.disks[0] && ` / ${formatBytes(host.capacity.disks[0].size)}`}
                  </KvItem>
                  <KvItem label="uptime">
                    {host.identity.uptime_s > 0 ? formatDuration(host.identity.uptime_s) : '—'}
                  </KvItem>
                  <KvItem label="load">{host.load.map((n) => n.toFixed(2)).join(' · ')}</KvItem>
                </>
              )}
              {observed && <KvItem label="resources">{observed.resources.length}</KvItem>}
            </div>
          </div>
        </div>
      </div>

      {/* GET /servers/:id can report a connected server with no snapshot yet — the daemon's
          first post-reconnect report hasn't landed (docs/prototype-reality-check.md's rule
          against invented data). A snapshot WITH a null host is a different fact: the daemon
          reported but its host probe failed — "waiting for the next report" would be false
          there. Absence is information either way, so each case says which absence it is. */}
      {!host &&
        (observed ? (
          <p className="detail-note">Host report unavailable &mdash; the daemon&rsquo;s host probe did not return.</p>
        ) : (
          <p className="detail-note">Not yet observed &mdash; waiting for the daemon&rsquo;s next report.</p>
        ))}

      {probes && Object.keys(probes).length > 0 && (
        <>
          <div className="sec">
            <span className="label">Probes</span>
          </div>
          <div className="summary" style={{ paddingTop: 0 }}>
            <div className="card">
              <div className="card-section">
                <div className="kv kv-inline">
                  {Object.entries(probes).map(([kind, status]) => (
                    <KvItem key={kind} label={kind}>
                      <span className={`dot ${status === 'ok' ? 'dot-healthy' : 'dot-stopped'}`} />
                      {status}
                    </KvItem>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {observed && (
        <>
          <div className="sec">
            <span className="label">Resources</span>
          </div>
          <ResourcesTable resources={observed.resources} />
        </>
      )}
    </>
  )
}

// prototype/server.html's Overview table has five columns: kind, name, exposed at, release,
// age. Two are dropped: "exposed at" has no wire field (the only candidate is Docker
// Desktop's own debug labels, absent on Linux Docker), and "release" belongs to the
// Plan/Release model, which ObservedResource doesn't carry.
function ResourcesTable({ resources }: { resources: ObservedResource[] }) {
  if (resources.length === 0) {
    return <p className="detail-note">No resources reported.</p>
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: 130 }}>kind</th>
          <th>name</th>
          <th className="col-age">age</th>
        </tr>
      </thead>
      <tbody>
        {resources.map((resource) => (
          <ResourceRow key={`${resource.kind}:${resource.name}`} resource={resource} />
        ))}
      </tbody>
    </table>
  )
}

function ResourceRow({ resource }: { resource: ObservedResource }) {
  const icon = KIND_ICON[resource.kind]
  const dotClass = RESOURCE_DOT[resource.observed.health]
  // `created_at` is set by the daemon's docker observer for every container-backed resource
  // (observer.go: `"created_at": c.Created`) but isn't part of the wire schema for the other
  // kinds it can report (firewall rules, systemd units, cron entries) — read defensively.
  // The `> 0` also drops dockercli's zero sentinel for an unparseable creation date, which
  // would otherwise render as a 1970s age.
  const createdAt = resource.observed.detail.created_at
  const age = typeof createdAt === 'number' && createdAt > 0 ? formatAgo(createdAt * 1000) : '—'

  return (
    <tr>
      <td>
        <span className="cell">
          {icon && <HugeiconsIcon icon={icon} className="icon icon-sm kindicon" />}
          <span className="muted">{resource.kind}</span>
        </span>
      </td>
      <td>
        <span className="cell">
          {dotClass && (
            <span className={`dot ${dotClass}`} role="img" aria-label={resource.observed.health} />
          )}
          {resource.name}
        </span>
      </td>
      <td className="muted col-age">{age}</td>
    </tr>
  )
}

function KvItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv-item">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  )
}
