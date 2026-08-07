import type { Server, ServerStatus } from '#/api/servers'
import { formatAgo } from '#/lib/format'

// docs/design.md §5.9 dot palette. `disconnected` gets ink, not a semantic colour —
// cockpit not hearing from a daemon is an absence, not itself a declared failure.
// `enrolling` gets no dot at all (design.md §6): any dot would imply cockpit knows
// something it has not been told.
const DOT_CLASS: Record<ServerStatus, string | null> = {
  connected: 'dot-healthy',
  enrolling: null,
  draining: 'dot-degraded',
  disconnected: 'dot-stopped',
}

export function ServerCard({ server }: { server: Server }) {
  const meta = [server.provider, server.addr, server.arch].filter(Boolean)

  return (
    <div className="card">
      <div className="card-section">
        <div className="server-head">
          {DOT_CLASS[server.status] && (
            <span
              className={`dot ${DOT_CLASS[server.status]}`}
              style={{ marginTop: 6 }}
              role="img"
              aria-label={server.status}
            />
          )}
          <span style={{ minWidth: 0 }}>
            <span className="server-name">{server.name}</span>
            <span className="server-meta">
              {meta.map((value, i) => (
                <span key={value}>
                  {i > 0 && <span className="sep">&middot;</span>}
                  {value}
                </span>
              ))}
            </span>
          </span>
        </div>
      </div>

      {/* No metrics section: ServerSchema (the GET /servers payload) carries identity only,
          no metric fields — a gauge here would be inventing data. */}
      <ServerCardBody server={server} />

      <div className="card-section card-foot">
        <div className="server-foot">
          <ServerCardFoot server={server} />
        </div>
      </div>
    </div>
  )
}

function ServerCardBody({ server }: { server: Server }) {
  if (server.status === 'enrolling') {
    return (
      <div className="card-section" style={{ paddingTop: 0, paddingBottom: 'calc(var(--spacing) * 5)' }}>
        <div className="sweep" />
      </div>
    )
  }

  if (server.status === 'disconnected') {
    return <div className="card-section server-note">No contact from the daemon</div>
  }

  if (server.status === 'draining') {
    return <div className="card-section server-note">Draining</div>
  }

  if (server.agent_version) {
    return <div className="card-section server-note">agent {server.agent_version}</div>
  }

  return null
}

function ServerCardFoot({ server }: { server: Server }) {
  if (server.status === 'enrolling') {
    return <span className="server-foot-value">created {formatAgo(server.created_at)}</span>
  }

  if (server.last_seen_at) {
    return <span className="server-foot-value">last seen {formatAgo(server.last_seen_at)}</span>
  }

  return <span className="server-foot-value">never seen</span>
}
