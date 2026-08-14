import { createFileRoute, useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { connectGithub, sourcesQueryOptions, type Source } from '#/api/sources'
import { formatAgo } from '#/lib/format'

// The plane's GitHub callback redirects the browser back here carrying the outcome:
// `?connected=<source_id>` after a successful install/update, `?notice=<code>` when the
// flow ended without an installation to record, `?error=<code>` when the installation
// lookup failed (detail stays in the plane's logs). All are one-shot hints, not state —
// unknown values render nothing.
type SourcesSearch = {
  connected?: string
  notice?: string
  error?: string
}

export const Route = createFileRoute('/_app/sources')({
  staticData: { title: 'Sources' },
  validateSearch: (search: Record<string, unknown>): SourcesSearch => ({
    connected: typeof search.connected === 'string' ? search.connected : undefined,
    notice: typeof search.notice === 'string' ? search.notice : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(sourcesQueryOptions),
  pendingComponent: SourcesPending,
  errorComponent: SourcesError,
  component: SourcesScreen,
})

function SourcesPending() {
  return (
    <div className="empty">
      <p className="empty-body">Loading sources&hellip;</p>
    </div>
  )
}

function SourcesError({ error }: ErrorComponentProps) {
  const router = useRouter()

  return (
    <div className="empty">
      <h2 className="empty-title">Couldn&rsquo;t load sources</h2>
      <p className="empty-body">{error.message}. Check that the plane is running.</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => router.invalidate()}>
          Retry
        </button>
      </div>
    </div>
  )
}

// The failure codes the callback redirect can carry today. Anything else gets the
// generic line rather than being echoed raw into the page.
const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  github_app_misconfigured:
    'GitHub is not fully configured on this plane. Check the GitHub App settings and try again.',
  github_installation_lookup_failed:
    "GitHub didn't confirm the installation, so nothing was saved. Try connecting again.",
  github_connect_failed:
    "The GitHub connection didn't complete, so nothing was saved. Check the plane's logs and try again.",
}

const CALLBACK_NOTICE_MESSAGES: Record<string, string> = {
  'pending-approval':
    'Your install request went to the account owner. The source appears here once they approve it.',
}

function CallbackNotice({ search, sources }: { search: SourcesSearch; sources: Source[] }) {
  if (search.error) {
    return (
      <p className="form-error" role="alert" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        {CALLBACK_ERROR_MESSAGES[search.error] ??
          "The GitHub connection didn't complete. Try connecting again."}
      </p>
    )
  }

  if (search.notice) {
    const message = CALLBACK_NOTICE_MESSAGES[search.notice]

    if (!message) return null

    return (
      <p className="form-success" role="status" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        {message}
      </p>
    )
  }

  if (search.connected) {
    // The redirect may carry an id for either a new installation or a refreshed grant on an
    // existing one — name it if the list has it, and stay quiet on a stale/unknown id.
    const source = sources.find((s) => s.id === search.connected)

    if (!source) return null

    return (
      <p className="form-success" role="status" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
        GitHub installation for @{source.github_login} connected.
      </p>
    )
  }

  return null
}

function SourcesScreen() {
  const { data, error } = useSuspenseQuery(sourcesQueryOptions)
  const search = Route.useSearch()

  const connect = useMutation({
    mutationFn: connectGithub,
    onSuccess: ({ url }) => {
      // The rest of the flow happens off-app: GitHub's install page finishes and returns
      // via the plane's callback. Full navigation, not a popup — the page is abandoned
      // either way, and the button's pending state honestly covers the gap until unload.
      window.location.assign(url)
    },
  })

  const connectButton = (size: 'btn-lg' | 'btn-sm') => (
    <button
      type="button"
      className={`btn btn-primary ${size}`}
      onClick={() => connect.mutate()}
      disabled={connect.isPending}
    >
      {connect.isPending ? 'Connecting…' : 'Connect GitHub'}
    </button>
  )

  if (data.length === 0) {
    return (
      <div className="empty">
        <div className="empty-art">
          <SourcesEmptyArt />
        </div>
        <h2 className="empty-title">No sources connected</h2>
        <p className="empty-body">
          Install the cockpit GitHub App to deploy straight from your repositories &mdash; a
          push becomes a deployment. cockpit only sees the repositories you grant, and you can
          revoke the installation from GitHub at any time.
        </p>
        <div className="empty-actions">{connectButton('btn-lg')}</div>
        {!connect.isError && search.error && (
          <div style={{ marginTop: 'calc(var(--spacing) * 4)' }}>
            <CallbackNotice search={search} sources={data} />
          </div>
        )}
        {connect.isError && (
          <p className="form-error" role="alert" style={{ marginTop: 'calc(var(--spacing) * 4)' }}>
            Couldn&rsquo;t start the GitHub connection ({connect.error.message}).
          </p>
        )}
      </div>
    )
  }

  return (
    <>
      {error && (
        <p className="server-note" role="alert">
          Plane unreachable since the last refresh &mdash; this list may be stale.
        </p>
      )}
      <CallbackNotice search={search} sources={data} />
      <div className="toolbar">
        <p className="toolbar-note">
          GitHub App installations connected to this account. Pushes to their repositories can
          trigger deployments.
        </p>
        <span className="spacer" />
        {connectButton('btn-sm')}
      </div>
      {connect.isError && (
        <p className="form-error" role="alert" style={{ marginBottom: 'calc(var(--spacing) * 4)' }}>
          Couldn&rsquo;t start the GitHub connection ({connect.error.message}).
        </p>
      )}
      <div className="servers-grid">
        {data.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>

    </>
  )
}

function SourceCard({ source }: { source: Source }) {
  const permissions = Object.entries(source.permissions)

  return (
    <div className="card">
      <div className="card-section">
        <div className="server-head">
          <span style={{ minWidth: 0 }}>
            <span className="server-name">{source.name}</span>
            <span className="server-meta">
              <span>@{source.github_login}</span>
              <span>
                <span className="sep">&middot;</span>installation {source.github_installation_id}
              </span>
            </span>
          </span>
        </div>
      </div>

      <div className="card-section">
        <div className="kv">
          <div className="kv-item">
            <div className="kv-k">repositories</div>
            <div className="kv-v">
              {source.repository_selection === 'all' ? 'all repositories' : 'selected repositories'}
            </div>
          </div>
          <div className="kv-item">
            <div className="kv-k">events</div>
            <div className="kv-v">{source.events.length > 0 ? source.events.join(', ') : '—'}</div>
          </div>
          <div className="kv-item">
            <div className="kv-k">permissions</div>
            <div className="kv-v">
              {permissions.length > 0
                ? permissions.map(([scope, level]) => `${scope}: ${level}`).join(', ')
                : '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="card-section card-foot">
        <div className="server-foot">
          <span className="server-foot-value">connected {formatAgo(source.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

// Solid = what exists (cockpit). Dashed = what is absent (the commit graph feeding it) —
// same convention as the servers empty art.
function SourcesEmptyArt() {
  return (
    <svg
      viewBox="0 0 180 170"
      width="200"
      height="189"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      <g strokeDasharray="4 4" opacity={0.8}>
        <circle cx="40" cy="35" r="6" />
        <circle cx="40" cy="85" r="6" />
        <circle cx="40" cy="135" r="6" />
        <path d="M40 41v38M40 91v38" />
        <path d="M46 85h20" />
        <circle cx="72" cy="85" r="6" />
        <path d="M78 85h36" />
      </g>
      <path d="M114 51h48v68h-48z" />
      <path d="M114 71h48" opacity={0.4} />
      <g opacity={0.45}>
        <path d="M122 87h16M122 97h26M122 107h20" />
      </g>
    </svg>
  )
}
